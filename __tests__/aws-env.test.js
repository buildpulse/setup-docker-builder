'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cacheRegion, awsOpts, DEFAULT_REGION } = require('../src/aws-env');

const FILE = '/opt/example/aws/credentials';

test('region prefers the dedicated variable over the ambient one', () => {
    assert.equal(
        cacheRegion({ BP_CACHE_AWS_REGION: 'eu-central-1', AWS_REGION: 'us-east-1' }),
        'eu-central-1'
    );
});

test('region falls back to the ambient variable, then to the default', () => {
    assert.equal(cacheRegion({ AWS_REGION: 'us-east-1' }), 'us-east-1');
    assert.equal(cacheRegion({}), DEFAULT_REGION);
});

test('with no dedicated credentials file the options are handed back untouched', () => {
    const opts = { stdio: 'ignore', timeout: 15000 };
    // Identity, not just equality: the spawn must be exactly what it was before, with
    // no env key introduced that would override an inherited environment.
    assert.strictEqual(awsOpts(opts, { AWS_REGION: 'us-east-1' }), opts);
    assert.deepEqual(awsOpts(undefined, {}), {});
});

test('the credentials file and profile are set on the child env', () => {
    const out = awsOpts({ stdio: 'ignore' }, {
        BP_CACHE_AWS_CREDENTIALS_FILE: FILE,
        BP_CACHE_AWS_PROFILE: 'cache-profile',
        PATH: '/usr/bin',
    });
    assert.equal(out.stdio, 'ignore');
    assert.equal(out.env.AWS_SHARED_CREDENTIALS_FILE, FILE);
    assert.equal(out.env.AWS_PROFILE, 'cache-profile');
    // The rest of the environment still reaches the child — sudo -E has nothing to
    // preserve if we hand it a stripped env.
    assert.equal(out.env.PATH, '/usr/bin');
});

test('profile defaults when only the file is supplied', () => {
    const out = awsOpts(undefined, { BP_CACHE_AWS_CREDENTIALS_FILE: FILE });
    assert.equal(out.env.AWS_PROFILE, 'default');
});

test('the caller environment is never mutated', () => {
    // The whole point: these two variables are global to every AWS CLI process, so
    // writing them to process.env would redirect the job's own later `aws` calls.
    const env = { BP_CACHE_AWS_CREDENTIALS_FILE: FILE, PATH: '/usr/bin' };
    const before = { ...env };
    awsOpts({ stdio: 'inherit' }, env);
    assert.deepEqual(env, before);
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, undefined);
    assert.equal(env.AWS_PROFILE, undefined);
});

test('an explicit env on the incoming options wins over the ambient one', () => {
    const out = awsOpts({ env: { ONLY: 'this' } }, {
        BP_CACHE_AWS_CREDENTIALS_FILE: FILE,
        PATH: '/usr/bin',
    });
    assert.equal(out.env.ONLY, 'this');
    assert.equal(out.env.PATH, undefined);
    assert.equal(out.env.AWS_SHARED_CREDENTIALS_FILE, FILE);
});
