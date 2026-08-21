'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    parseS3ListAges,
    nearExpiry,
    worstCaseAgeDays
} = require('../src/refresh-policy');

const NOW = Date.parse('2026-08-21T00:00:00Z');
const ls = (lines) => lines.join('\n');

test('parses aws s3 ls output into key -> age in days', () => {
    const ages = parseS3ListAges(
        ls([
            '2026-08-20 12:00:00       2023 org-x/snap-ca/aaa.tar.zst',
            '2026-08-14 00:00:00      50000 org-x/snap-ca/bbb.tar.zst'
        ]),
        NOW
    );
    assert.ok(ages);
    assert.equal(ages.size, 2);
    assert.ok(Math.abs(ages.get('aaa.tar.zst') - 0.5) < 0.01);
    assert.ok(Math.abs(ages.get('bbb.tar.zst') - 7) < 0.01);
});

test('keys are relative to <ns>/<prefix>/ so they match --include patterns', () => {
    // blobs live one level deeper; the whole remainder must survive.
    const ages = parseS3ListAges(
        ls(['2026-08-20 00:00:00        10 org-x/blobs/sha256/deadbeef']),
        NOW
    );
    assert.deepEqual([...ages.keys()], ['sha256/deadbeef']);
});

test('timestamps are read as UTC, not local time', () => {
    // A naive Date.parse of "2026-08-20 12:00:00" is local, which would shift the
    // age by the TZ offset and could flip a boundary decision.
    const ages = parseS3ListAges(
        ls(['2026-08-20 00:00:00        10 org-x/snap-ca/k.tar.zst']),
        NOW
    );
    assert.ok(Math.abs(ages.get('k.tar.zst') - 1) < 1e-6);
});

test('unparseable and empty lines are skipped, not thrown on', () => {
    const ages = parseS3ListAges(
        ls([
            '',
            'Bucket: something',
            'garbage',
            '2026-08-19 00:00:00        10 org-x/snap-ca/good.tar.zst',
            '2026-13-45 99:99:99        10 org-x/snap-ca/baddate.tar.zst'
        ]),
        NOW
    );
    assert.deepEqual([...ages.keys()], ['good.tar.zst']);
});

test('an empty listing yields null so the caller fails open', () => {
    assert.equal(parseS3ListAges('', NOW), null);
    assert.equal(parseS3ListAges('no objects here', NOW), null);
});

test('nearExpiry: young objects are skipped, old ones refreshed', () => {
    const ages = new Map([['young', 0.5], ['old', 3.2]]);
    assert.equal(nearExpiry(ages, 'young', 1), false);
    assert.equal(nearExpiry(ages, 'old', 1), true);
});

test('nearExpiry is inclusive at the threshold', () => {
    const ages = new Map([['exact', 1]]);
    assert.equal(nearExpiry(ages, 'exact', 1), true);
});

test('nearExpiry fails OPEN when the listing failed', () => {
    // Skipping wrongly costs the layer; refreshing wrongly costs one request.
    assert.equal(nearExpiry(null, 'anything', 1), true);
});

test('nearExpiry fails OPEN for a key absent from the listing', () => {
    // Raced with an upload, or listed under an unexpected shape.
    assert.equal(nearExpiry(new Map([['other', 0.1]]), 'missing', 1), true);
});

test('worst-case age stays under the 7-day lifecycle at the shipped default', () => {
    // An active repo builds many times an hour on weekdays, so the binding case
    // is the weekend: observed inter-build gaps reach ~2.4 days. Shipped
    // threshold is 1 day.
    const LIFECYCLE_DAYS = 7;
    const LONGEST_OBSERVED_GAP = 2.37;
    const worst = worstCaseAgeDays(1, LONGEST_OBSERVED_GAP);
    assert.ok(
        worst < LIFECYCLE_DAYS,
        `worst-case age ${worst}d must stay under the ${LIFECYCLE_DAYS}d lifecycle`
    );
    // And keep real headroom, not just squeak under.
    assert.ok(LIFECYCLE_DAYS - worst > 3, 'want >3 days of quiet-stretch tolerance');
});

test('a threshold that would expire referenced layers is detectable', () => {
    // Guards the reasoning itself: at threshold 5 with the same gap the policy
    // would let a referenced layer age out. This is the check to re-run before
    // ever raising BP_CACHE_REFRESH_AGE_DAYS.
    assert.ok(worstCaseAgeDays(5, 2.37) > 7);
});
