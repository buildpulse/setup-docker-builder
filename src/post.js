// BuildPulse setup-docker-builder (post) — commit-on-success.
// Runs only when the job succeeded (post-if: success() in action.yml), so a failed
// or cancelled build never overwrites a known-good cache (no poisoning). Two tiers:
//   1) copy the buildkit state (--root: layer cache AND RUN --mount=type=cache) to
//      the node-local NVMe hot cache (Last-Write-Wins);
//   2) push that cache to the durable S3 backing so it survives node churn / spot
//      reclaim and hydrates onto whatever node the next build lands on.
//
// All commands use execFileSync with argv arrays — NO shell — so nothing is
// interpolated through a shell. Tenant/bucket are additionally charset-validated
// before they reach the S3 URI, so a hostile value can neither inject nor traverse.
const core = require('@actions/core');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TAR = '/tmp/bk-commit.tar.zst';
const SUM = '/tmp/bk-commit.sha256';
// S3 bucket names and k8s namespaces are both a strict subset of this; anything else
// is rejected rather than passed to aws.
const SAFE = /^[a-z0-9][a-z0-9._-]*$/;
// Per-tenant cache size cap (prune before commit) — bounds unbounded growth so the
// tar/upload/hydrate cost stays flat. Overridable via bp-max-cache-gb input.
const MAX_CACHE_GB = parseInt(process.env.BP_MAX_CACHE_GB || '10', 10) || 10;

function run(file, args, opts) { execFileSync(file, args, { stdio: 'inherit', ...(opts || {}) }); }

// Persistent-root mode (runners#72, chart >=0.14.4 with buildkitBuilder.persistentRoot):
// the buildkit --root IS the per-tenant NVMe dir — there is no per-pod copy, so the
// NVMe commit tier disappears and the S3 commit reads the LIVE root. The live root is
// daemon-owned (uid 1000), so aws reads run privileged with the Pod-Identity env
// preserved (-E: AWS_CONTAINER_CREDENTIALS_FULL_URI + token file, root-readable).
const PERSISTENT = (process.env.BP_PERSISTENT_BK_ROOT || '') === 'true';
const CACHE_SRC = PERSISTENT ? '/home/runner/buildkit-root' : '/nvme-cache';
function runAws(args) {
  if (PERSISTENT) run('sudo', ['-n', '-E', 'aws', ...args]);
  else run('aws', args);
}
function awsOut(args) {
  return PERSISTENT
    ? execFileSync('sudo', ['-n', '-E', 'aws', ...args])
    : execFileSync('aws', args);
}

// List a directory as root. The snapshotter's snapshot dirs are daemon-owned and can be
// mode 0700, so the runner uid cannot readdir them directly now that /nvme-cache is no
// longer blanket-chowned. Returns [] on any error (treated as "nothing to commit here").
function sudoList(dir) {
  try {
    return execFileSync('sudo', ['-n', 'ls', '-1', dir], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (_) { return []; }
}

// Does a path exist (as root)? Used where the runner uid may lack traverse permission.
function sudoExists(p) {
  try { execFileSync('sudo', ['-n', 'test', '-e', p]); return true; } catch (_) { return false; }
}

// Best-effort CloudWatch metric (P1 observability). Failures never affect the build.
function emitMetric(name, value, unit, ns, region) {
  try {
    execFileSync('aws', ['cloudwatch', 'put-metric-data',
      '--namespace', 'BP/Runners', '--metric-name', name,
      '--unit', unit, '--value', String(value),
      '--dimensions', `Tenant=${ns}`, '--region', region],
      { stdio: 'ignore', timeout: 15000 });
  } catch (_) { /* metrics are best-effort */ }
}

// Cap the buildkit cache before snapshotting so the committed object can't grow
// without bound (a max-cache-size prune, LRU by buildkit's GC).
function pruneCache() {
  // --reserved-space is the renamed --keep-storage (buildx deprecation); fall back for
  // older buildx. Prune failure is never fatal — worst case the cache is a bit bigger.
  try {
    run('docker', ['buildx', 'prune', '--builder', 'buildpulse',
      '--reserved-space', `${MAX_CACHE_GB}GB`, '--force']);
  } catch (_) {
    try {
      run('docker', ['buildx', 'prune', '--builder', 'buildpulse',
        '--keep-storage', `${MAX_CACHE_GB}GB`, '--force']);
    } catch (e) {
      core.warning(`cache prune skipped: ${e.message}`);
    }
  }
}

function commitToNvme() {
  // Hardening: the build step is finished by post-time so buildkitd is idle; `sync`
  // flushes any pending writes so the on-disk --root is consistent before we copy
  // it (closes the documented consistency window). sudo: buildkitd's state files
  // are owned by uid 1000 (0600); the runner reads them as root via passwordless
  // sudo. /nvme-cache is this build's isolated persistent cache dir.
  run('sudo', ['-n', 'sync']);
  run('sudo', ['-n', 'cp', '-a', '/home/runner/buildkit-root/.', '/nvme-cache/']);
  // Hand the cache to the runner uid so the non-root aws CLI (Pod Identity creds) can read +
  // TRAVERSE it for the S3 sync — BUT prune the snapshot filesystems: a blanket `chown -R`
  // would collapse the per-file uids INSIDE the restored layers (a uid-999 non-root image's
  // baked ~/.cache -> the runner uid, then the hydrate collapses again to uid 1000 = the
  // daemon's userns root), so the non-root build's next (warm) build can't write it. Pruning
  // …/snapshots/snapshots/<id>/fs keeps those exact uids; the S3 commit tars them privileged
  // with `--numeric-owner` and the hydrate restores + re-chowns everything-but-fs to 1000.
  run('sudo', ['-n', 'find', '/nvme-cache', '-path', '*/snapshots/snapshots/*/fs', '-prune',
    '-o', '-exec', 'chown', `${process.getuid()}:${process.getgid()}`, '{}', '+']);
  core.info('committed docker layer cache -> node NVMe (LWW, ownership preserved)');
}

// Locate the buildkit snapshotter dir (runc-overlayfs / runc-native / runc-fuse-overlayfs).
function snapshotterDir(src) {
  // PERSISTENT: the live root can be daemon-owned/0700 — readdir as the runner uid
  // would EACCES and silently no-op every S3 commit (review catch on runners#74).
  const entries = PERSISTENT ? sudoList(src) : fs.readdirSync(src);
  const d = entries.find((x) => x.startsWith('runc-'));
  if (!d) throw new Error('no runc-* snapshotter dir under cache root');
  return d;
}

// Object basenames already under an S3 prefix (empty list if the prefix does not exist yet).
function s3Basenames(prefix, region) {
  try {
    return awsOut(['s3', 'ls', prefix, '--region', region])
      .toString().split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);
  } catch (_) { return []; }
}

// Durable S3 backing — PER-LAYER incremental, CONTENT-ADDRESSED (v2).
//
// Why content-addressed: buildkit's numeric snapshot ids (snapshots/snapshots/<id>) are a
// PER-DAEMON monotonic counter persisted in its boltdb — the same id on two pods is
// DIFFERENT content. The v1 format deduped uploads by bare id into the shared per-tenant
// prefix while the boltdb was last-writer-wins, so two CONCURRENT builds desynced the
// prefix: the id-space became a union of both pods while the meta described only one.
// A later hydrate then restored dirs the winning boltdb's counter didn't know about →
//   rename …/new-XXXX → …/<id>: file exists
// (and the silent variant: an id ≤ counter holding the OTHER pod's content = wrong layer).
//
// v2 keys each archive by its own sha256 — same key ⇒ same bytes, cross-pod collisions
// impossible — and pins the id→sha map in a manifest committed INSIDE the atomic metadata
// object, so a reader always restores exactly the set its boltdb describes:
//   snap-ca/<sha256>.tar.zst — one compressed archive per immutable snapshot fs, keyed by
//                              archive digest (the key doubles as the integrity check).
//   blobs/…                  — content-addressed layer blobs (native), skip-existing sync.
//   cache-meta-v2.tar.zst    — boltdb set + RUN --mount caches + bp-snap-manifest.json,
//                              ONE atomic object written LAST (write-before-ref). The v2
//                              name gates the format: old readers never mix v2 meta with
//                              v1 objects, and the new reader does not trust v1 prefixes
//                              at all (they may already be latently desynced).
// Reads run as the runner uid (commitToNvme handed it the cache); only fs/ of each snapshot
// is archived — the overlay work/ dir is transient and mode-0000.
const MANIFEST = 'bp-snap-manifest.json';
function commitToS3(bucket, ns, region) {
  if (!SAFE.test(bucket)) throw new Error(`refusing unsafe bucket name: ${bucket}`);
  if (!SAFE.test(ns)) throw new Error(`refusing unsafe tenant namespace: ${ns}`);
  if (!SAFE.test(region)) throw new Error(`refusing unsafe region: ${region}`);
  const base = `s3://${bucket}/${ns}`;
  const SRC = CACHE_SRC;
  const snap = snapshotterDir(SRC);
  const snapDir = `${SRC}/${snap}/snapshots/snapshots`;
  const blobsDir = `${SRC}/${snap}/content/blobs`;

  // Blob digests this build's content store actually holds. Listed ONCE and used twice:
  // pinned in the manifest (so a cold hydrate fetches exactly this set instead of the whole
  // blobs/ prefix) and reused for the lifecycle refresh below. The prefix accumulates
  // orphans — locally-pruned layers stay in S3 until the lifecycle expires them — so the
  // whole-prefix sync a hydrate used to do pulls far more than the live set (12.8GB vs
  // ~3GB referenced on the largest tenant).
  //
  // The set is only PINNED when every entry is a well-formed digest. Anything unexpected
  // means the listing does not fully describe the content store, and a pinned-but-incomplete
  // set would make the hydrate silently under-fetch — so in that case the key is omitted and
  // the hydrate falls back to the full-prefix sync. The refresh below still uses the raw
  // list either way, exactly as it did before.
  let blobList = [];
  try { blobList = sudoList(`${blobsDir}/sha256`); } catch (_) { /* no blobs yet */ }
  const blobsPinnable = blobList.length > 0 && blobList.every((n) => /^[0-9a-f]{64}$/.test(n));

  // 1) SNAPSHOTS — archive each local snapshot, upload under its content digest.
  const have = new Set(s3Basenames(`${base}/snap-ca/`, region).map((k) => k.replace(/\.tar\.zst$/, '')));
  // Listed as root: the snapshotter dirs are daemon-owned and no longer chowned to the runner.
  const localIds = sudoList(snapDir).filter((x) => /^[0-9]+$/.test(x));
  // Prior manifest (last commit on this node lineage, or the S3 hydrate that seeded it):
  // committed snapshots are immutable and ids are never reused within a lineage, so a
  // previously-computed sha for a still-present id is reusable without re-tarring — this
  // keeps the recurring cost at exactly the NEW layers, like the v1 skip-existing did.
  let prior = {};
  try {
    const raw = PERSISTENT
      ? execFileSync('sudo', ['-n', 'cat', `${SRC}/${MANIFEST}`], { encoding: 'utf8' })
      : fs.readFileSync(`${SRC}/${MANIFEST}`, 'utf8');
    prior = JSON.parse(raw).snapshots || {};
  } catch (_) { /* first v2 commit */ }
  const manifest = {};
  let newLayers = 0;
  for (const id of localIds) {
    if (!sudoExists(`${snapDir}/${id}/fs`)) continue;
    // Reuse only if the object still exists in S3 (lifecycle may have expired it on a
    // long-idle tenant) — otherwise fall through and re-archive so the manifest never
    // references a missing object (the hydrate is all-or-nothing on that).
    if (prior[id] && /^[0-9a-f]{64}$/.test(prior[id]) && have.has(prior[id])) { manifest[id] = prior[id]; continue; }
    // Unique per (pid,id): each build runs in its own pod with an isolated /tmp, so a
    // cross-build collision on this path can't actually happen, but scope it defensively.
    const tmp = `/tmp/snap-${process.pid}-${id}.tar.zst`;
    try {
      // Privileged + --numeric-owner: the snapshot fs holds the build's per-file uids (a
      // uid-999 non-root image's files are 0600, unreadable by the runner). Root reads them
      // and --numeric-owner records the exact uids so the hydrate can restore them faithfully;
      // hand the finished archive back to the runner so the Pod-Identity aws CLI can upload it.
      run('sudo', ['-n', 'env', 'ZSTD_NBTHREADS=0', 'tar', '--zstd', '--numeric-owner',
        '--warning=no-file-ignored', '-cf', tmp, '-C', `${snapDir}/${id}`, 'fs']);
      if (PERSISTENT) run('sudo', ['-n', 'chmod', '0644', tmp]);
      if (!PERSISTENT) run('sudo', ['-n', 'chown', `${process.getuid()}:${process.getgid()}`, tmp]);
      const sha = execFileSync('sha256sum', [tmp]).toString().trim().split(/\s+/)[0];
      // Content-addressed dedupe is safe (unlike by-id): same key ⇒ same bytes. Two pods
      // producing identical layers share one object; differing archives get distinct keys.
      if (!have.has(sha)) {
        runAws(['s3', 'cp', tmp, `${base}/snap-ca/${sha}.tar.zst`, '--region', region, '--only-show-errors']);
        newLayers += 1;
      }
      manifest[id] = sha;
    } catch (e) {
      core.warning(`snapshot ${id} skipped: ${e.message}`);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* best effort */ }
    }
  }
  // Persist the manifest into the cache root BEFORE the metadata tar: it ships inside the
  // atomic meta object (pinning the exact restore set) and stays on the node NVMe so the
  // next commit on this lineage reuses the shas above.
  // `blobs` is additive and optional: an older hydrate ignores the key, and a newer hydrate
  // reading a manifest without it falls back to the full sync — so commit and hydrate can
  // roll out in either order without a partial restore.
  const manifestJSON = JSON.stringify(blobsPinnable
    ? { version: 2, snapshots: manifest, blobs: blobList }
    : { version: 2, snapshots: manifest });
  if (PERSISTENT) {
    // Live root is daemon-owned; stage in /tmp and install with matching ownership,
    // world-readable so the next commit's prior-manifest read (runner uid) works.
    fs.writeFileSync('/tmp/bp-snap-manifest.json', manifestJSON);
    run('sudo', ['-n', 'cp', '/tmp/bp-snap-manifest.json', `${SRC}/${MANIFEST}`]);
    run('sudo', ['-n', 'chown', '1000:1000', `${SRC}/${MANIFEST}`]);
    run('sudo', ['-n', 'chmod', '0644', `${SRC}/${MANIFEST}`]);
  } else {
    fs.writeFileSync(`${SRC}/${MANIFEST}`, manifestJSON);
  }

  // 2) BLOBS — content-addressed + already compressed; incremental skip-existing sync.
  // The commitToNvme find-prune already handed the blobs + their parent dirs to the runner
  // uid (blob ownership is irrelevant — content is digest-addressed and S3 carries no uids),
  // so the non-root aws CLI can read + traverse to them directly.
  try {
    runAws(['s3', 'sync', blobsDir, `${base}/blobs/`, '--region', region,
      '--only-show-errors', '--no-progress']);
  } catch (e) { core.warning(`blob sync incomplete: ${e.message}`); }

  // 3) METADATA — the mutable remainder as ONE atomic object, written LAST: the boltdb set
  //    + RUN --mount caches, minus the snapshots/blobs (handled above) and transient state.
  // This remainder (runner-owned after the find-prune, excludes the snapshot fs) is tarred
  // with --numeric-owner; the hydrate re-chowns everything-but-fs back to the daemon's uid
  // 1000, so the boltdb is daemon-owned again when buildkitd reopens it. sudo is belt-and-
  // suspenders in case any excluded-path sibling wasn't runner-readable.
  run('sudo', ['-n', 'env', 'ZSTD_NBTHREADS=0', 'tar', '--zstd', '--numeric-owner', '--warning=no-file-ignored', '-cf', TAR, '-C', SRC,
    '--exclude', `./${snap}/snapshots/snapshots`,
    '--exclude', `./${snap}/content/blobs`,
    '--exclude', `./${snap}/content/ingest`,
    '--exclude', `./${snap}/executor`,
    '--exclude', './buildkitd.lock', '.']);
  if (!PERSISTENT) run('sudo', ['-n', 'chown', `${process.getuid()}:${process.getgid()}`, TAR]);
  // Integrity sidecar (R1/S2): hydrate verifies this digest before trusting the metadata.
  if (PERSISTENT) run('sudo', ['-n', 'chmod', '0644', TAR]);
  const digest = execFileSync('sha256sum', [TAR]).toString().trim().split(/\s+/)[0];
  fs.writeFileSync(SUM, digest);
  const bytes = fs.statSync(TAR).size;
  const metaObj = `${base}/cache-meta-v2.tar.zst`;
  runAws(['s3', 'cp', TAR, metaObj, '--region', region, '--only-show-errors']);
  runAws(['s3', 'cp', SUM, `${metaObj}.sha256`, '--region', region, '--only-show-errors']);
  run('sudo', ['-n', 'rm', '-f', TAR, SUM]); // root-owned in persistent mode (sticky /tmp)

  // 4) REFRESH + ORPHAN GC — keep this ACTIVE tenant's REFERENCED layers alive under the
  //    bucket's LastModified lifecycle expiry, via a server-side copy-in-place (REPLACE
  //    metadata, NO data transfer). Crucially we refresh ONLY the objects this build's
  //    manifest actually references; objects no longer referenced (orphans from a locally-
  //    pruned layer, or a lost concurrent-commit's unique archives) are deliberately NOT
  //    touched, so they age out of S3 via the lifecycle rule — that IS the orphan GC.
  //    Concurrency-safe: no deletes, so a concurrent build refreshes its own set and only
  //    layers referenced by NOBODY age out. Abandoned tenants never run this, so their whole
  //    prefix (v1 leftovers included) ages out. One `aws s3 cp` per prefix (the CLI
  //    parallelizes), filtered with --exclude '*' + per-object --include.
  const snapInc = [...new Set(Object.values(manifest))].flatMap((sha) => ['--include', `${sha}.tar.zst`]);
  const blobInc = blobList.flatMap((n) => ['--include', `sha256/${n}`]);
  // Batch the --include flags so a tenant with thousands of objects can't blow past OS
  // ARG_MAX in a single exec (a failed refresh would silently skip that build's touch, and
  // its objects could then age out). Each object contributes 2 argv entries; 1000/call keeps
  // the arg list tiny. For typical caches (<1000 objects) this is still a single call.
  const refresh = (pfx, includes) => {
    const step = 1000 * 2;
    for (let i = 0; i < includes.length; i += step) {
      try {
        runAws(['s3', 'cp', `${base}/${pfx}/`, `${base}/${pfx}/`, '--recursive', '--region', region,
          '--only-show-errors', '--no-progress', '--metadata-directive', 'REPLACE', '--metadata', 'bp-cache=v2',
          '--exclude', '*', ...includes.slice(i, i + step)]);
      } catch (e) { core.warning(`cache refresh (${pfx}) batch skipped: ${e.message}`); }
    }
  };
  refresh('snap-ca', snapInc);
  refresh('blobs', blobInc);
  core.info(`committed docker layer cache -> ${base}/ (${newLayers} new layer archive(s) + blobs sync + ${Math.round(bytes / 1024)}KB atomic metadata; manifest pins ${Object.keys(manifest).length} snapshot(s), orphans age out)`);
  return bytes;
}

// Cache-write policy. By DEFAULT, `pull_request` builds also write the shared per-tenant
// cache (matching how hosted CI builders behave) — PRs are usually the bulk of build
// volume, so this is what makes the cache actually pay off; a strict "protected-branch
// only" rule leaves PRs permanently cold until a merge seeds it. Per-tenant Pod Identity
// scoping already prevents CROSS-tenant access; the residual is a PR poisoning its OWN
// tenant's cache (buildkit layers are content-addressed; the real vector is
// RUN --mount=type=cache). Opt into strict isolation (PR builds read-only) with
// BP_CACHE_ISOLATE_PR=true.
//
// `pull_request_target` is deliberately EXCLUDED from write-by-default and is ALWAYS
// read-only: it runs untrusted fork code WITH the base repo's secrets and write
// permissions — a fundamentally higher trust boundary than `pull_request` — so it must
// never seed the shared cache (that would hand a fork PR the RUN --mount=type=cache
// poisoning path into the tenant's cache). This holds regardless of BP_CACHE_ISOLATE_PR.
const event = (process.env.GITHUB_EVENT_NAME || '').toLowerCase();
const isolatePR = (process.env.BP_CACHE_ISOLATE_PR || '').toLowerCase() === 'true';
if (event === 'pull_request_target') {
  core.info('pull_request_target — cache read-only (untrusted fork code + base secrets), not committing');
  process.exit(0);
}
if (event === 'pull_request' && isolatePR) {
  core.info('pull_request + BP_CACHE_ISOLATE_PR — cache read-only, not committing');
  process.exit(0);
}

const region = process.env.AWS_REGION || 'us-west-2';
const ns = core.getState('bp_namespace') || process.env.POD_NAMESPACE || 'unknown';

// Cap size, then Tier 1 — node-local NVMe. If tier 1 fails there is nothing to push.
pruneCache();
try {
  if (PERSISTENT) {
    core.info('persistent buildkit root — no NVMe copy tier (root IS the node cache)');
  } else {
    commitToNvme();
  }
} catch (e) {
  core.warning(`NVMe cache commit skipped: ${e.message}`);
  emitMetric('CacheCommitErrors', 1, 'Count', ns, region);
  process.exit(0);
}

// Tier 2 — durable S3 backing (best-effort; never fail the job on a cache issue).
const bucket = process.env.BK_CACHE_BUCKET || '';
if (!bucket) {
  core.info('no S3 backing configured — node-local NVMe only');
} else {
  const t0 = Date.now();
  try {
    if (!ns || ns === 'unknown') throw new Error('tenant namespace unknown');
    const bytes = commitToS3(bucket, ns, region);
    emitMetric('CacheCommitBytes', bytes, 'Bytes', ns, region);
    emitMetric('CacheCommitSeconds', (Date.now() - t0) / 1000, 'Seconds', ns, region);
  } catch (e) {
    core.warning(`S3 cache backing skipped: ${e.message}`);
    emitMetric('CacheCommitErrors', 1, 'Count', ns, region);
  }
}
