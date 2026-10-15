#!/usr/bin/env node
/**
 * Refresh the vendored conformance cases (src/data/sourceConformance.json)
 * from gev-open-sources, so both repos test the same credential, header and
 * coverage rules. Any failure (not published yet, network, bad JSON, wrong
 * shape) keeps the current file and warns; nothing else depends on it.
 *
 *   npm run sources:cases
 */
import fs from 'node:fs';

const URL_CASES =
  'https://raw.githubusercontent.com/quanticsoul4772/gev-open-sources/main/conformance/cases.json';
const out = new URL('../src/data/sourceConformance.json', import.meta.url);

const count = (c) =>
  `${c?.credentials?.flag?.length ?? 0}/${c?.credentials?.pass?.length ?? 0} URLs, ` +
  `${c?.headers?.flag?.length ?? 0}/${c?.headers?.pass?.length ?? 0} headers, ` +
  `${c?.coverage?.pass?.length ?? 0}/${c?.coverage?.fail?.length ?? 0} boxes (flag-or-fail/pass)`;

/** The keys the app's conformance test reads, each an array (limits an object). */
function wellShaped(c) {
  return (
    Array.isArray(c?.credentials?.flag) &&
    Array.isArray(c?.credentials?.pass) &&
    Array.isArray(c?.headers?.flag) &&
    Array.isArray(c?.headers?.pass) &&
    c?.coverage?.limits &&
    typeof c.coverage.limits === 'object' &&
    Array.isArray(c?.coverage?.pass) &&
    Array.isArray(c?.coverage?.fail)
  );
}

const current = JSON.parse(fs.readFileSync(out, 'utf8'));
let next;
try {
  const response = await fetch(URL_CASES, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  next = await response.json();
  if (!wellShaped(next)) throw new Error('unexpected shape');
} catch (error) {
  console.warn(
    `Kept the current cases (${count(current)}): ${URL_CASES} — ${error?.message || error}`,
  );
  process.exit(0);
}
fs.writeFileSync(out, `${JSON.stringify(next, null, 2)}\n`);
console.log(`Cases: ${count(current)} → ${count(next)}`);
