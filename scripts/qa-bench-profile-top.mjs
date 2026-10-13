#!/usr/bin/env node
/**
 * Summarise a Chrome .cpuprofile (from `qa-bench.mjs --profile`): self time by
 * function and by source file, so a hotspot is named by evidence.
 *
 *   node scripts/qa-bench-profile-top.mjs <file.cpuprofile> [--top 25]
 *
 * Self time is samples × sampling interval. "(program)", "(idle)" and
 * "(garbage collector)" are Chrome's own buckets: idle is main-thread slack,
 * program is native work outside JS (layout, paint, WebGL calls), and GC is
 * collection triggered by the app's allocations.
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: qa-bench-profile-top.mjs <file.cpuprofile> [--top N]');
  process.exit(2);
}
const topIndex = process.argv.indexOf('--top');
const TOP = topIndex > 0 ? Number(process.argv[topIndex + 1]) : 25;

const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const counts = new Map();
for (const id of profile.samples) counts.set(id, (counts.get(id) || 0) + 1);
const totalMs = (profile.endTime - profile.startTime) / 1000;
const msPerSample = totalMs / profile.samples.length;

const shortUrl = (url) =>
  (url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '') ||
  '(native)';
const byFunction = new Map();
const byFile = new Map();
for (const [id, n] of counts) {
  const { functionName, url, lineNumber } = byId.get(id).callFrame;
  const name = `${functionName || '(anonymous)'}  ${shortUrl(url)}:${lineNumber + 1}`;
  byFunction.set(name, (byFunction.get(name) || 0) + n);
  const f = url ? shortUrl(url) : functionName || '(native)';
  byFile.set(f, (byFile.get(f) || 0) + n);
}

const print = (title, map) => {
  console.log(`\n${title}`);
  for (const [name, n] of [...map].sort((a, b) => b[1] - a[1]).slice(0, TOP))
    console.log(
      `${(n * msPerSample).toFixed(0).padStart(7)} ms  ${((100 * n) / profile.samples.length).toFixed(1).padStart(5)}%  ${name}`,
    );
};
console.log(
  `${file}: ${totalMs.toFixed(0)} ms, ${profile.samples.length} samples`,
);
print('Self time by function', byFunction);
print('Self time by file', byFile);
