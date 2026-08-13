<a href="https://buildpulse.io"><img src=".github/banner.svg" alt="setup-docker-builder, by BuildPulse" width="100%"></a>

<a href="https://buildpulse.io/products/runners?ref=github-badge"><img src=".github/runs-on-buildpulse-compact.svg" alt="Runs on BuildPulse" height="28"></a>
[![CI](https://img.shields.io/github/actions/workflow/status/buildpulse/setup-docker-builder/ci.yml?style=for-the-badge&label=CI&labelColor=15161B)](https://github.com/buildpulse/setup-docker-builder/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/buildpulse/setup-docker-builder?style=for-the-badge&label=RELEASE&labelColor=15161B&color=454ADE)](https://github.com/buildpulse/setup-docker-builder/tags)
[![Last commit](https://img.shields.io/github/last-commit/buildpulse/setup-docker-builder?style=for-the-badge&label=LAST%20COMMIT&labelColor=15161B&color=E8590C)](https://github.com/buildpulse/setup-docker-builder/commits/main)

Drop-in replacement for `docker/setup-buildx-action` on BuildPulse docker-builder
runners. Points buildx at the runner's **local rootless buildkitd sidecar**, whose
state is hydrated from / committed to a **persistent per-tenant cache on node NVMe**.
No `cache-from`/`cache-to` config: the cache is the daemon's own `--root`, so it
preserves layer cache *and* `RUN --mount=type=cache`.

```yaml
jobs:
  build:
    runs-on: bp-docker-builder-x64-32x   # a BuildPulse docker-builder pool
    steps:
      - uses: actions/checkout@v4
      - uses: buildpulse/setup-docker-builder@v1
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: myimage:latest
```

## How it works
- The pod's init container **hydrates** the buildkitd `--root` from
  `/mnt/nvme/bk-cache/<tenant-namespace>` before buildkitd starts.
- This action wires `buildx` to `unix:///run/buildkit/buildkitd.sock` (remote driver).
- On job **success only**, the post step **commits** the root back (Last-Write-Wins).

## Build
`npm ci && npm run build` regenerates `dist/` (committed; GitHub Actions runs `dist/`).

## Status
v1. Needs: (1) extraction to its own `buildpulse/setup-docker-builder` repo to be
`uses:`-able externally; (2) dev hardening of the commit step (quiesce buildkitd
before copy to close the consistency window).
