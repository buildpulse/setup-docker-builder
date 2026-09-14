'use strict';

// Where the cache's own AWS calls get their credentials and region — extracted so it
// can be tested, and so the two entry points cannot drift apart.
//
// Historically both were ambient: the region came from a bare AWS_REGION, and the
// credentials from whatever the default chain resolved, which on a runner means the
// shared credentials file found by expanding $HOME. Both are shared with the job, so a
// build that configures AWS for its own purposes silently redirects the cache commit
// too — and both are being withdrawn from the environment.
//
// The environment now supplies a dedicated, absolute-path credentials file plus the
// profile and region to use with it. Prefer those; fall back to the old ambient values
// so nothing breaks where they are not set yet.

const DEFAULT_REGION = 'us-west-2';

/** Region for the cache's AWS calls: dedicated, then ambient, then the default. */
function cacheRegion(env) {
    return env.BP_CACHE_AWS_REGION || env.AWS_REGION || DEFAULT_REGION;
}

/**
 * Child-process options for an `aws` invocation, carrying the dedicated credentials.
 *
 * The variables are placed ONLY on the returned options' `env`. Callers must never
 * assign them to process.env: AWS_SHARED_CREDENTIALS_FILE and AWS_PROFILE are global
 * to every AWS CLI/SDK process, so mutating the process environment would also
 * redirect the `aws` calls the job itself makes later in the build.
 *
 * With no dedicated credentials file configured, the options are returned untouched so
 * the spawn is exactly what it was before — the fallback is "behave as we always did",
 * not "behave with an empty credentials file".
 *
 * @param {object|undefined} opts child_process options to extend
 * @param {object} env            process.env equivalent, injectable for tests
 */
function awsOpts(opts, env) {
    const base = opts || {};
    const file = env.BP_CACHE_AWS_CREDENTIALS_FILE || '';
    if (!file) return base;
    return {
        ...base,
        env: {
            ...(base.env || env),
            AWS_SHARED_CREDENTIALS_FILE: file,
            AWS_PROFILE: env.BP_CACHE_AWS_PROFILE || 'default',
        },
    };
}

module.exports = { cacheRegion, awsOpts, DEFAULT_REGION };
