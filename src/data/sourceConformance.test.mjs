import assert from 'node:assert/strict';
import test from 'node:test';
import cases from './sourceConformance.json' with { type: 'json' };
import {
  areSafeHeaders,
  hasCredential,
  isPlausibleCoverage,
} from '../../server/providers/sourceDirectory.js';
import {
  BIKESHARE_DOMAIN,
  COVERAGE_LIMITS,
  EARTHQUAKES_DOMAIN,
  TRANSIT_DOMAIN,
} from './sourceDomains.js';

// The cases are shared with gev-open-sources (conformance/cases.json), so both
// repos refuse the same URLs, headers and coverage boxes. Each repo keeps its
// own tests too; a case removed upstream never lowers the app's coverage.

// The app keys coverage limits by domain: one domain per class.
const DOMAIN_OF_CLASS = {
  regional: BIKESHARE_DOMAIN,
  national: TRANSIT_DOMAIN,
  global: EARTHQUAKES_DOMAIN,
};

test('shared cases: credentials in URLs', () => {
  for (const url of cases.credentials.flag)
    assert.equal(hasCredential(url), true, `should flag ${url}`);
  for (const url of cases.credentials.pass)
    assert.equal(hasCredential(url), false, `should pass ${url}`);
});

test('shared cases: request headers (flag = carries a credential)', () => {
  for (const headers of cases.headers.flag)
    assert.equal(areSafeHeaders(headers), false, JSON.stringify(headers));
  for (const headers of cases.headers.pass)
    assert.equal(areSafeHeaders(headers), true, JSON.stringify(headers));
});

test('shared cases: coverage boxes by class', () => {
  for (const { bbox, class: cls } of cases.coverage.pass)
    assert.equal(
      isPlausibleCoverage(bbox, DOMAIN_OF_CLASS[cls]),
      true,
      `${cls} should pass ${JSON.stringify(bbox)}`,
    );
  for (const { bbox, class: cls } of cases.coverage.fail)
    assert.equal(
      isPlausibleCoverage(bbox, DOMAIN_OF_CLASS[cls]),
      false,
      `${cls} should fail ${JSON.stringify(bbox)}`,
    );
});

test('shared coverage limits equal the app’s own', () => {
  assert.deepEqual(cases.coverage.limits, {
    regional: [...COVERAGE_LIMITS.regional],
    national: [...COVERAGE_LIMITS.national],
    global: COVERAGE_LIMITS.global,
  });
});
