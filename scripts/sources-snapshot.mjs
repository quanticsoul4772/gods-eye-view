#!/usr/bin/env node
/**
 * Refresh the bundled copy of the keyless source directory
 * (server/providers/sourceDirectorySnapshot.json), which the server serves
 * until its first live refresh. Every entry stays for referral; `access` (the
 * feed URL) is kept only for entries the app may use, under the same rule the
 * server applies.
 *
 *   npm run sources:snapshot
 *   GEV_SOURCE_DIRECTORY_URL=file:///…/dist/v1/index.json npm run sources:snapshot
 */
import fs from 'node:fs';
import {
  SOURCE_DIRECTORY_URL,
  isUsableEntry,
  loadDirectory,
} from '../server/providers/sourceDirectory.js';

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
fs.writeFileSync(
  out,
  JSON.stringify({
    version: directory.version,
    generated_at: directory.generated_at,
    entries,
  }),
);
console.log(
  `${entries.length} entries, ${entries.filter((e) => e.access).length} usable, generated ${directory.generated_at}`,
);
