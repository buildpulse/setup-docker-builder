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
  core.info('committed docker layer cache -> node NVMe (LWW)');
}

function commitToS3(bucket, ns, region) {
  if (!SAFE.test(bucket)) throw new Error(`refusing unsafe bucket name: ${bucket}`);
  if (!SAFE.test(ns)) throw new Error(`refusing unsafe tenant namespace: ${ns}`);
  if (!SAFE.test(region)) throw new Error(`refusing unsafe region: ${region}`);
  // Single-object PUT is atomic: a cold node hydrating concurrently sees either the
  // whole previous object or the whole new one, never a torn cache. Tar the static
  // NVMe copy (not the live --root) so the archive itself is consistent. LWW.
  // zstd -T0 (multi-threaded via ZSTD_NBTHREADS) — several-x faster than gzip at a
  // similar ratio, so the post-step commit doesn't stall large builds.
  run('sudo', ['-n', 'env', 'ZSTD_NBTHREADS=0', 'tar', '--zstd', '-cf', TAR, '-C', '/nvme-cache', '.']);
  run('sudo', ['-n', 'chown', `${process.getuid()}:${process.getgid()}`, TAR]);
  // Integrity sidecar (R1/S2): the hydrate init verifies this digest before it will
  // extract the object, so a torn or tampered archive is discarded, not restored.
  const digest = execFileSync('sha256sum', [TAR]).toString().trim().split(/\s+/)[0];
  fs.writeFileSync(SUM, digest);
  const bytes = fs.statSync(TAR).size;
  const s3obj = `s3://${bucket}/${ns}/root.tar.zst`;
  run('aws', ['s3', 'cp', TAR, s3obj, '--region', region, '--only-show-errors']);
  run('aws', ['s3', 'cp', SUM, `${s3obj}.sha256`, '--region', region, '--only-show-errors']);
  run('rm', ['-f', TAR, SUM]);
  core.info(`committed docker layer cache -> ${s3obj} (${(bytes / 1e6).toFixed(0)}MB, sha256 ${digest.slice(0, 12)}…)`);
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
