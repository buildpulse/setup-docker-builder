'use strict';

// Refresh policy for the S3 layer cache — extracted so it can be tested.
//
// The cache bucket expires objects on LastModified. An ACTIVE tenant keeps its
// REFERENCED layers alive by copying them in place (REPLACE metadata, no data
// transfer), which resets that clock. Unreferenced orphans are deliberately
// never touched, so they age out — that is the entire garbage collection story.
//
// Copying every referenced object on every commit is what made this expensive:
// each copy is billed as a PUT request, and those requests cost far more than the
// storage itself. Touching an object with six days left on a seven-day rule buys
// nothing.
//
// So: one LIST per prefix (Tier2, ~12x cheaper per call) gives every object's
// age, and only those near expiry are copied. The GC property is unchanged —
// an object is refreshed only when a build references it AND it is near expiry.

/**
 * Parse `aws s3 ls <uri> --recursive` output into key -> age in days.
 *
 * Lines look like:
 *   2026-08-20 11:40:12       2023 <ns>/<prefix>/<key>
 *
 * The timestamp is UTC. Keys are returned relative to the listed prefix so they
 * match the `--include` patterns the caller builds: pass `keyPrefix` (e.g.
 * `<ns>/snap-ca/`, or `<ns>/<lane>/snap-ca/` on a lane-scoped cache) and the
 * remainder after it is the key; a line outside that prefix is skipped. Without
 * `keyPrefix` the legacy two-segment strip (`<ns>/<prefix>/`) applies.
 * Unparseable lines are skipped rather than throwing: a listing that is partly
 * unreadable should degrade to "refresh more than strictly necessary", never to
 * a crash in a post-step that runs after a successful build.
 *
 * @param {string} text  raw stdout
 * @param {number} nowMs Date.now() equivalent, injectable for tests
 * @param {string} [keyPrefix] listed prefix relative to the bucket, with trailing slash
 * @returns {Map<string, number>|null} null when nothing parsed (caller fails open)
 */
function parseS3ListAges(text, nowMs, keyPrefix) {
    const ages = new Map();
    for (const line of String(text).split('\n')) {
        const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\d+\s+(.+)$/);
        if (!m) continue;
        let key;
        if (keyPrefix) {
            if (!m[2].startsWith(keyPrefix)) continue;
            key = m[2].slice(keyPrefix.length);
        } else {
            key = m[2].split('/').slice(2).join('/'); // strip "<ns>/<prefix>/"
        }
        if (!key) continue;
        const t = Date.parse(m[1].replace(' ', 'T') + 'Z');
        if (Number.isNaN(t)) continue;
        ages.set(key, (nowMs - t) / 86400000);
    }
    return ages.size ? ages : null;
}

/**
 * Should this referenced object be refreshed?
 *
 * Fails OPEN in both unknown cases — a null map (the listing failed) and a key
 * absent from the map (raced with an upload, or listed under an unexpected
 * shape). Refreshing unnecessarily costs a request; skipping wrongly costs the
 * layer. A cost optimisation must never make the cache less durable.
 */
function nearExpiry(ages, key, thresholdDays) {
    if (!ages) return true;
    const age = ages.get(key);
    if (age === undefined) return true;
    return age >= thresholdDays;
}

/**
 * Largest age an object can reach under this policy: it can sit just under the
 * threshold when a build runs, then wait a full inter-build gap before the next
 * one refreshes it. Must stay below the bucket's lifecycle or a referenced
 * layer expires.
 */
function worstCaseAgeDays(thresholdDays, longestBuildGapDays) {
    return thresholdDays + longestBuildGapDays;
}

module.exports = { parseS3ListAges, nearExpiry, worstCaseAgeDays };
