#!/usr/bin/env node
/**
 * Refresh the bundled copy of the keyless source directory
 * (server/providers/sourceDirectorySnapshot.json), which the server serves
 * until its first live refresh. Every entry stays for referral; `access` (the
 * feed URL) is kept only for entries the app may use, under the same rule the
 * server applies.
 *
 *   npm run sources:snapshot
 *   GEV_SOURCE_DIRECTORY_URL=file:///…/dist/directory.json npm run sources:snapshot
 */
import fs from 'node:fs';
import {
  SOURCE_DIRECTORY_URL,
  isUsableEntry,
} from '../server/providers/sourceDirectory.js';

const url = process.env.GEV_SOURCE_DIRECTORY_URL || SOURCE_DIRECTORY_URL;
const out = new URL(
  '../server/providers/sourceDirectorySnapshot.json',
  import.meta.url,
);

const directory = url.startsWith('file:')
  ? JSON.parse(fs.readFileSync(new URL(url), 'utf8'))
  : await fetch(url, { signal: AbortSignal.timeout(60_000) }).then(
      (response) => {
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response.json();
      },
    );
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
