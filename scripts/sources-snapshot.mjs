#!/usr/bin/env node
/**
 * Refresh the bundled copy of the keyless source directory
 * (server/providers/sourceDirectorySnapshot.json), which the server serves
 * until its first live refresh. Every entry stays for referral; `access` (the
 * feed URL) is kept only for entries the app may use, under the same rule the
 * server applies.
 *
 * Before writing, the new copy is compared with the committed one by usable
 * entry id; a domain losing more than min(5, 10 %) of them is refused (a short
 * upstream outage once hid 10 bike-share systems). `--force` writes anyway.
 *
 *   npm run sources:snapshot [-- --force]
 *   GEV_SOURCE_DIRECTORY_URL=file:///…/dist/v1/index.json npm run sources:snapshot
 */
import fs from 'node:fs';
import {
  SOURCE_DIRECTORY_URL,
  compareSnapshots,
  isUsableEntry,
  loadDirectory,
} from '../server/providers/sourceDirectory.js';

const force = process.argv.includes('--force');
const url = process.env.GEV_SOURCE_DIRECTORY_URL || SOURCE_DIRECTORY_URL;
const out = new URL(
  '../server/providers/sourceDirectorySnapshot.json',
  import.meta.url,
);

const { directory } = await loadDirectory(url);
if (!Array.isArray(directory?.entries) || !directory.entries.length)
  throw new Error(`${url}: no entries`);

const entries = directory.entries.map((entry) =>
  isUsableEntry(entry) ? entry : { ...entry, access: null },
);
const next = {
  version: directory.version,
  generated_at: directory.generated_at,
  entries,
};

let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {
  // No committed snapshot: nothing to compare with.
}
const { ok, domains } = compareSnapshots(previous, next);
for (const d of domains) {
  const flag = d.refused ? ' REFUSED' : '';
  console.log(
    `${d.domain}: ${d.before} → ${d.after} usable${flag}${d.lost.length ? `; lost ${d.lost.join(', ')}` : ''}${d.gained.length ? `; gained ${d.gained.length}` : ''}`,
  );
}
if (!ok && !force) {
  console.error(
    'Not written: a domain lost more usable entries than allowed. Check the directory, or rerun with --force.',
  );
  process.exit(1);
}

fs.writeFileSync(out, JSON.stringify(next));
console.log(
  `${entries.length} entries, ${entries.filter((e) => e.access).length} usable, generated ${directory.generated_at}${!ok ? ' (forced)' : ''}`,
);
