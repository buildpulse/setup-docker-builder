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
  try {
    run('docker', ['buildx', 'prune', '--builder', 'buildpulse',
      '--keep-storage', `${MAX_CACHE_GB}GB`, '--force']);
  } catch (e) {
    core.warning(`cache prune skipped: ${e.message}`);
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
  // buildkitd writes its state as uid 1000 with restrictive per-file perms (extracted
  // layer files can be 0600/0000). Hand the whole tenant cache to the runner uid so the
  // non-root aws CLI — which carries the tenant Pod Identity creds — can read every object
  // for the incremental S3 sync. buildkitd never reads /nvme-cache directly (hydrate
  // re-chowns its working --root to 1000), so this ownership is inert for the daemon.
  run('sudo', ['-n', 'chown', '-R', `${process.getuid()}:${process.getgid()}`, '/nvme-cache']);
  core.info('committed docker layer cache -> node NVMe (LWW)');
}

// Locate the buildkit snapshotter dir (runc-overlayfs / runc-native / runc-fuse-overlayfs).
function snapshotterDir(src) {
  const d = fs.readdirSync(src).find((x) => x.startsWith('runc-'));
  if (!d) throw new Error('no runc-* snapshotter dir under cache root');
  return d;
}

// Object basenames already under an S3 prefix (empty list if the prefix does not exist yet).
function s3Basenames(prefix, region) {
  try {
    return execFileSync('aws', ['s3', 'ls', prefix, '--region', region])
      .toString().split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);
  } catch (_) { return []; }
}

// Durable S3 backing — PER-LAYER incremental. The first cut synced the raw --root
// file-by-file, which cost ~10x the bytes (snapshots are uncompressed) across ~100k tiny
// objects. This refinement keys on buildkit's own structure under s3://<bucket>/<ns>/:
//   snap/<id>.tar.zst   — one COMPRESSED archive per immutable buildkit snapshot (its
//                         extracted layer fs). A committed snapshot never changes, so we
//                         upload only ids not already in S3 — the recurring cost is exactly
//                         the NEW layers the build produced, compressed.
//   blobs/…             — content-addressed layer blobs (already compressed), synced
//                         incrementally (immutable -> skip-existing).
//   cache-meta.tar.zst  — the mutable, must-stay-consistent remainder (boltdb *.db +
//                         RUN --mount caches), as ONE atomic object written LAST
//                         (write-before-ref: a cold reader pulls it, then finds every
//                         snapshot/blob it references already present).
// Reads run as the runner uid (commitToNvme handed it the cache); only fs/ of each snapshot
// is archived — the overlay work/ dir is transient and mode-0000.
function commitToS3(bucket, ns, region) {
  if (!SAFE.test(bucket)) throw new Error(`refusing unsafe bucket name: ${bucket}`);
  if (!SAFE.test(ns)) throw new Error(`refusing unsafe tenant namespace: ${ns}`);
  if (!SAFE.test(region)) throw new Error(`refusing unsafe region: ${region}`);
  const base = `s3://${bucket}/${ns}`;
  const SRC = '/nvme-cache';
  const snap = snapshotterDir(SRC);
  const snapDir = `${SRC}/${snap}/snapshots/snapshots`;
  const blobsDir = `${SRC}/${snap}/content/blobs`;

  // 1) SNAPSHOTS — per-id compressed archive; upload only ids missing from S3 (immutable).
  const have = new Set(s3Basenames(`${base}/snap/`, region).map((k) => k.replace(/\.tar\.zst$/, '')));
  let localIds = [];
  try { localIds = fs.readdirSync(snapDir).filter((x) => /^[0-9]+$/.test(x)); } catch (_) { /* none yet */ }
  let newLayers = 0;
  for (const id of localIds) {
    if (have.has(id)) continue;
    if (!fs.existsSync(`${snapDir}/${id}/fs`)) continue;
    // Unique per (pid,id): each build runs in its own pod with an isolated /tmp, so a
    // cross-build collision on this path can't actually happen, but scope it defensively.
    const tmp = `/tmp/snap-${process.pid}-${id}.tar.zst`;
    try {
      run('env', ['ZSTD_NBTHREADS=0', 'tar', '--zstd', '--warning=no-file-ignored',
        '-cf', tmp, '-C', `${snapDir}/${id}`, 'fs']);
      run('aws', ['s3', 'cp', tmp, `${base}/snap/${id}.tar.zst`, '--region', region, '--only-show-errors']);
      newLayers += 1;
    } catch (e) {
      core.warning(`snapshot ${id} skipped: ${e.message}`);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* best effort */ }
    }
  }

  // 2) BLOBS — content-addressed + already compressed; incremental skip-existing sync.
  try {
    run('aws', ['s3', 'sync', blobsDir, `${base}/blobs/`, '--region', region,
      '--only-show-errors', '--no-progress']);
  } catch (e) { core.warning(`blob sync incomplete: ${e.message}`); }

  // 3) METADATA — the mutable remainder as ONE atomic object, written LAST: the boltdb set
  //    + RUN --mount caches, minus the snapshots/blobs (handled above) and transient state.
  run('env', ['ZSTD_NBTHREADS=0', 'tar', '--zstd', '--warning=no-file-ignored', '-cf', TAR, '-C', SRC,
    '--exclude', `./${snap}/snapshots/snapshots`,
    '--exclude', `./${snap}/content/blobs`,
    '--exclude', `./${snap}/content/ingest`,
    '--exclude', `./${snap}/executor`,
    '--exclude', './buildkitd.lock', '.']);
  // Integrity sidecar (R1/S2): hydrate verifies this digest before trusting the metadata.
  const digest = execFileSync('sha256sum', [TAR]).toString().trim().split(/\s+/)[0];
  fs.writeFileSync(SUM, digest);
  const bytes = fs.statSync(TAR).size;
  const metaObj = `${base}/cache-meta.tar.zst`;
  run('aws', ['s3', 'cp', TAR, metaObj, '--region', region, '--only-show-errors']);
  run('aws', ['s3', 'cp', SUM, `${metaObj}.sha256`, '--region', region, '--only-show-errors']);
  run('rm', ['-f', TAR, SUM]);

  // 4) REFRESH — keep this ACTIVE tenant's layers alive under the bucket's LastModified
  //    lifecycle expiry. snap/ + blobs/ objects are IMMUTABLE and not re-uploaded each build,
  //    so without a touch their LastModified would age past the rule and an actively-built
  //    tenant's base layers would be evicted (then rebuilt on the next cold hydrate). A
  //    server-side copy-in-place (REPLACE metadata, NO data transfer) refreshes LastModified.
  //    Abandoned tenants never run this, so their prefix still ages out. (Orphan cleanup —
  //    objects no longer referenced by a live build — is the separate GC in runners#52.)
  for (const pfx of ['snap', 'blobs']) {
    try {
      run('aws', ['s3', 'cp', `${base}/${pfx}/`, `${base}/${pfx}/`, '--recursive', '--region', region,
        '--only-show-errors', '--no-progress', '--metadata-directive', 'REPLACE', '--metadata', 'bp-cache=v1']);
    } catch (e) { core.warning(`cache LastModified refresh (${pfx}) skipped: ${e.message}`); }
  }
  core.info(`committed docker layer cache -> ${base}/ (${newLayers} new layer archive(s) + blobs sync + ${(bytes / 1e6).toFixed(1)}MB atomic metadata; lifecycle-refreshed)`);
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
  commitToNvme();
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
