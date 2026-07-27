// BuildPulse setup-docker-builder (main).
// Wires buildx to the local rootless buildkitd sidecar whose --root was hydrated
// from the persistent per-tenant NVMe cache by the pod's init container. The whole
// build (layers + RUN --mount=type=cache) then hits local NVMe — no network cache,
// no cache-from/to to configure. Commit-on-success happens in post.js.
const core = require('@actions/core');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');

const SOCK = 'unix:///run/buildkit/buildkitd.sock';

function sh(cmd) { execSync(cmd, { stdio: 'inherit' }); }

// Best-effort cache hit-rate signal (P1 observability): 1 = the node-local cache was
// warm when this build started, 0 = cold. Averaging the metric gives the hit rate.
function emitHydrateMetric(ns) {
  try {
    let warm = 0;
    try { warm = fs.readdirSync('/home/runner/buildkit-root').length > 0 ? 1 : 0; } catch (_) {}
    execFileSync('aws', ['cloudwatch', 'put-metric-data',
      '--namespace', 'BP/Runners', '--metric-name', 'CacheHydrate',
      '--unit', 'Count', '--value', String(warm),
      '--dimensions', `Tenant=${ns || 'unknown'}`,
      '--region', process.env.AWS_REGION || 'us-west-2'],
      { stdio: 'ignore', timeout: 15000 });
  } catch (_) { /* metrics are best-effort */ }
}

try {
  // Create a buildx builder backed by the local buildkitd (remote driver over the
  // Unix socket the sidecar shares with the runner) and select it as default.
  sh(`docker buildx create --name buildpulse --driver remote --use ${SOCK}`);
  sh(`docker buildx inspect --bootstrap buildpulse`);

  // Tenant namespace scopes the persistent cache path (isolation); stash for post.
  let ns = process.env.POD_NAMESPACE || '';
  if (!ns) {
    try { ns = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim(); } catch (_) {}
  }
  core.saveState('bp_namespace', ns);
  emitHydrateMetric(ns);
  core.info(`BuildPulse docker builder ready (local buildkitd, tenant=${ns || 'unknown'})`);
} catch (e) {
  core.setFailed(`setup-docker-builder failed: ${e.message}`);
}
