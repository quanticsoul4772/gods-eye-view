#!/usr/bin/env node
/**
 * qa-heap-diff.mjs — what a layer still holds after it is turned off.
 *
 * Takes a heap snapshot (after GC) with the layer off, turns it on, waits for
 * data, turns it off again, and takes a second snapshot (after GC). Prints the
 * object types whose count or retained size grew between the two, which is
 * what `qa-bench`'s `retainedMiB` reports as a single number.
 *
 *   node scripts/qa-heap-diff.mjs --layer local-datacenters [--top 30]
 *   node scripts/qa-heap-diff.mjs --layer cctv --warm-cycles 1 --cycles 2
 *     growth per extra on/off cycle: a cache stays flat, a leak grows
 *
 * Against the dev server the constructor names are readable; the build's are
 * minified. Snapshots are written to qa-shots/heap/<stamp>/ (gitignored) and
 * can be opened in Chrome DevTools > Memory for retainer paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchProbeBrowser } from './qa-renderProbe.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback;
const APP_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
const LAYER = opt('--layer', 'local-datacenters');
const TOP = Number(opt('--top', '30'));
/** On/off cycles before the first snapshot (0: compare against never-on). */
const WARM_CYCLES = Number(opt('--warm-cycles', '0'));
/** On/off cycles between the two snapshots. */
const CYCLES = Number(opt('--cycles', '1'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join('qa-shots', 'heap', `${stamp}-${LAYER}`);
fs.mkdirSync(outDir, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot(cdp, file) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  const text = chunks.join('');
  fs.writeFileSync(file, text);
  return JSON.parse(text);
}

/** Self size and count per "type:name" for every node in a snapshot. */
function aggregate(snap) {
  const meta = snap.snapshot.meta;
  const fields = meta.node_fields;
  const width = fields.length;
  const typeNames = meta.node_types[0];
  const iType = fields.indexOf('type');
  const iName = fields.indexOf('name');
  const iSize = fields.indexOf('self_size');
  const out = new Map();
  const nodes = snap.nodes;
  for (let i = 0; i < nodes.length; i += width) {
    const type = typeNames[nodes[i + iType]];
    // Strings and code are keyed by type alone; objects by constructor name.
    const name =
      type === 'object' || type === 'closure' || type === 'native'
        ? snap.strings[nodes[i + iName]]
        : '';
    const key = `${type}${name ? `:${name}` : ''}`;
    const entry = out.get(key) || { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += nodes[i + iSize];
    out.set(key, entry);
  }
  return out;
}

const browser = await launchProbeBrowser({ gpu: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() =>
  sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
);
const cdp = await page.createCDPSession();
await cdp.send('HeapProfiler.enable');
try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.voiceCommands?.runner,
    {
      timeout: 180_000,
    },
  );
  await pause(8000);
  const cycle = () =>
    page.evaluate(async (id) => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled(id, true, { origin: 'user' });
      const t0 = performance.now();
      while (performance.now() - t0 < 60_000) {
        if ((dm.getAll().find((l) => l.id === id)?.stats?.count || 0) > 0)
          break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const count = dm.getAll().find((l) => l.id === id)?.stats?.count || 0;
      await new Promise((r) => setTimeout(r, 5000));
      await dm.setEnabled(id, false, { origin: 'user' });
      await new Promise((r) => setTimeout(r, 5000));
      return count;
    }, LAYER);
  for (let i = 0; i < WARM_CYCLES; i += 1) await cycle();
  const before = aggregate(
    await snapshot(cdp, path.join(outDir, 'before.heapsnapshot')),
  );
  let on = 0;
  for (let i = 0; i < CYCLES; i += 1) on = await cycle();
  const after = aggregate(
    await snapshot(cdp, path.join(outDir, 'after-off.heapsnapshot')),
  );
  const total = (agg) => [...agg.values()].reduce((a, e) => a + e.bytes, 0);
  console.log(
    `${LAYER}: ${on} objects while on. Heap before ${(total(before) / 2 ** 20).toFixed(1)} MiB, after off ${(total(after) / 2 ** 20).toFixed(1)} MiB`,
  );
  const rows = [];
  for (const [key, e] of after) {
    const b = before.get(key) || { count: 0, bytes: 0 };
    if (e.bytes - b.bytes > 0)
      rows.push({ key, dCount: e.count - b.count, dBytes: e.bytes - b.bytes });
  }
  rows.sort((a, b) => b.dBytes - a.dBytes);
  console.log('\nGrowth by type (self size), second snapshot minus first:');
  for (const r of rows.slice(0, TOP))
    console.log(
      `${(r.dBytes / 2 ** 20).toFixed(2).padStart(8)} MiB  ${String(r.dCount).padStart(8)}  ${r.key}`,
    );
  console.log(`\nSnapshots: ${outDir}`);
} finally {
  await browser.close();
}
