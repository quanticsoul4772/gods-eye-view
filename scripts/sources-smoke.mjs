#!/usr/bin/env node
/**
 * Live smoke check of the keyless source directory as the app reads it: the
 * v1 index loads, each domain's app-usable entries are counted, and one usable
 * feed per shown domain is fetched through the app's own code paths (public
 * addresses only, with timeouts). Uses the network, so it is not part of
 * `npm test`. Exits non-zero when anything fails.
 *
 *   npm run sources:smoke
 */
import {
  SOURCE_DIRECTORY_URL,
  createSourceDirectory,
  isUsableEntry,
  loadDirectory,
  publicOnlyFetch,
} from '../server/providers/sourceDirectory.js';
import { fetchGbfsUpstream } from '../server/providers/gbfs.js';
import { createSharedMobilityService } from '../server/providers/sharedMobility.js';
import { fetchTransitFeed } from '../src/sources/transitService.js';
import { directoryTransitFeed } from '../src/data/transitDirectory.js';
import {
  BIKESHARE_DOMAIN,
  SHAREDMOBILITY_DOMAIN,
  TRANSIT_DOMAIN,
} from '../src/data/sourceDomains.js';

const url = process.env.GEV_SOURCE_DIRECTORY_URL || SOURCE_DIRECTORY_URL;
const rows = [];
let failed = false;
const note = (check, ok, detail) => {
  rows.push({ check, result: ok ? 'ok' : 'FAIL', detail });
  if (!ok) failed = true;
};

const { directory } = await loadDirectory(url);
note(
  'index',
  Array.isArray(directory?.entries) && directory.entries.length > 0,
  `${directory?.entries?.length ?? 0} entries, generated ${directory?.generated_at}`,
);
const usableBy = new Map();
for (const e of directory.entries)
  if (isUsableEntry(e)) {
    if (!usableBy.has(e.domain)) usableBy.set(e.domain, []);
    usableBy.get(e.domain).push(e);
  }
for (const [domain, list] of [...usableBy].sort())
  rows.push({ check: `usable ${domain}`, result: 'ok', detail: `${list.length}` });

/** Try the usable entries of a domain until one answers; report the first. */
async function firstWorking(domain, attempt) {
  const list = usableBy.get(domain) || [];
  if (!list.length) return note(`fetch ${domain}`, false, 'no usable entry');
  const errors = [];
  for (const entry of list.slice(0, 5)) {
    try {
      const detail = await attempt(entry);
      return note(`fetch ${domain}`, true, `${entry.id}: ${detail}`);
    } catch (error) {
      errors.push(`${entry.id}: ${error?.message || error}`);
    }
  }
  note(`fetch ${domain}`, false, errors.join(' | '));
}

await firstWorking(TRANSIT_DOMAIN, async (entry) => {
  const feed = directoryTransitFeed(entry);
  const { response } = await fetchTransitFeed(
    feed,
    AbortSignal.timeout(20_000),
    publicOnlyFetch,
  );
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  await response.body?.cancel?.().catch(() => {});
  return 'HTTP 200';
});

await firstWorking(BIKESHARE_DOMAIN, async (entry) => {
  const upstream = await fetchGbfsUpstream(entry.access.url, {
    fetchImpl: publicOnlyFetch,
  });
  if (upstream.status !== 200) throw new Error(`HTTP ${upstream.status}`);
  const stations = JSON.parse(upstream.body)?.data?.stations?.length ?? 0;
  return `${stations} stations`;
});

const live = createSourceDirectory({ url, snapshot: null });
await live.refresh();
const service = createSharedMobilityService({ directory: live });
await firstWorking(SHAREDMOBILITY_DOMAIN, async (entry) => {
  const response = await service.handle({
    url: `http://localhost/api/sharedmobility/vehicles/${encodeURIComponent(entry.id)}`,
    method: 'GET',
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return `${body.vehicles.length} vehicles`;
});
service.close();
live.close();

console.table(rows);
process.exitCode = failed ? 1 : 0;
