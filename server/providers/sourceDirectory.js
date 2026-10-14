/**
 * The keyless source directory (github.com/quanticsoul4772/gev-open-sources):
 * a published list of live feeds that need no key, each with its decoder,
 * licence decision and health. The server loads it daily (bundled snapshot
 * first), and offers only entries that are verified, cleared for display, of a
 * format the app decodes, and that pass the URL guards below.
 *
 * The directory is harvested from third-party catalogs, so it is never trusted
 * as a fixed registry: every URL is checked here, every connection is pinned
 * to a public address, and a refresh that drops or adds too much is refused.
 */
import fs from 'node:fs';
import { lookup } from 'node:dns/promises';
import {
  fetchPinnedRadioResponse,
  resolveRadioProxyAddresses,
} from './radio/transport.js';

export const SOURCE_DIRECTORY_URL =
  'https://quanticsoul4772.github.io/gev-open-sources/directory.json';
export const SOURCE_DIRECTORY_REFRESH_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_URL = new URL('./sourceDirectorySnapshot.json', import.meta.url);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CREDENTIAL_PARAM =
  /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|auth[_-]?token|secret|client[_-]?secret|subscription[_-]?key|password|pwd|sig|signature)$/i;
const FORMATS = new Set(['gtfs-rt.vehicle-positions', 'gbfs.station-status']);

/** An https URL on the default port, a DNS name (no IP literal), no credentials. */
export function isSafeSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password)
    return false;
  const host = url.hostname;
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('['))
    return false;
  for (const key of url.searchParams.keys())
    if (CREDENTIAL_PARAM.test(key)) return false;
  return true;
}

/** A licence link the UI may render: http(s) only (never `javascript:` etc.). */
const isWebLink = (value) => {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** Whether the app may fetch and display an entry. */
export function isUsableEntry(entry) {
  return (
    ID_PATTERN.test(entry?.id || '') &&
    entry.health?.status === 'verified' &&
    entry.licence?.display === true &&
    FORMATS.has(entry.format) &&
    isSafeSourceUrl(entry.access?.url) &&
    Object.values(entry.access?.related || {}).every(isSafeSourceUrl) &&
    (entry.access?.redirectHosts || []).every(
      (host) =>
        /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) && !/^[\d.]+$/.test(host),
    ) &&
    (entry.licence.url === null || isWebLink(entry.licence.url))
  );
}

/**
 * Accept a newly fetched directory only if it is well-formed and doesn't drop
 * more than 20 % or double the entry count of the one in use.
 */
export function acceptDirectory(next, current) {
  if (!next || !Array.isArray(next.entries)) return false;
  if (!current?.entries?.length) return next.entries.length > 0;
  const before = current.entries.length;
  const after = next.entries.length;
  return after >= before * 0.8 && after <= before * 2;
}

/**
 * Fetch that connects only to public addresses, pinned at connect time so a
 * DNS answer can't change between the check and the connection. Redirects are
 * returned, not followed (callers resolve them hop by hop).
 */
export async function publicOnlyFetch(url, init = {}, lookupImpl = lookup) {
  const target = new URL(url);
  const addresses = await resolveRadioProxyAddresses(
    target.hostname,
    lookupImpl,
  );
  // The pinned request is a raw https.request, which does not decompress:
  // ask for an uncompressed body.
  const headers = Object.fromEntries(
    Object.entries(init.headers || {}).filter(
      ([name]) => name.toLowerCase() !== 'accept-encoding',
    ),
  );
  return fetchPinnedRadioResponse(
    target,
    {
      headers: { ...headers, 'Accept-Encoding': 'identity' },
      signal: init.signal,
    },
    addresses,
  );
}

function readSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_URL, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {{fetchImpl?: typeof fetch, url?: string, snapshot?: object|null,
 *   refreshMs?: number}} [options]
 */
export function createSourceDirectory({
  fetchImpl = fetch,
  url = SOURCE_DIRECTORY_URL,
  snapshot = readSnapshot(),
  refreshMs = SOURCE_DIRECTORY_REFRESH_MS,
} = {}) {
  let current = acceptDirectory(snapshot, null) ? snapshot : { entries: [] };
  // The size guard compares live copies only: a bundled snapshot can be far
  // older than the live directory, which grows, and must not pin the app to it.
  let live = false;
  let etag = null;
  let timer = null;
  let usable = current.entries.filter(isUsableEntry);

  async function refresh() {
    try {
      const response = await fetchImpl(url, {
        headers: etag ? { 'If-None-Match': etag } : {},
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 304 || !response.ok) return false;
      const next = await response.json();
      if (!acceptDirectory(next, live ? current : null)) return false;
      current = next;
      live = true;
      usable = next.entries.filter(isUsableEntry);
      etag = response.headers.get('etag');
      return true;
    } catch {
      return false;
    }
  }

  return {
    refresh,
    start() {
      refresh();
      timer = setInterval(refresh, refreshMs);
      timer.unref?.();
    },
    close() {
      clearInterval(timer);
      timer = null;
    },
    /** Every entry (for referral), with whether the app can use it. */
    entries() {
      return current.entries;
    },
    /** Entries the app may fetch and show. */
    usable(domain) {
      return domain ? usable.filter((e) => e.domain === domain) : usable;
    },
    generatedAt() {
      return current.generated_at || null;
    },
  };
}

/**
 * Directory entries that cover a point (or all, without one), for referral:
 * what can be shown now, and what exists. Never returns feed URLs.
 * @param {object[]} entries
 * @param {{lat?: number, lon?: number, domain?: string, limit?: number}} query
 */
export function referralEntries(
  entries,
  { lat, lon, domain, limit = 25 } = {},
) {
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);
  const rows = [];
  for (const e of entries) {
    if (domain && e.domain !== domain) continue;
    const b = e.coverage?.bbox;
    if (
      hasPoint &&
      !(b && lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3])
    )
      continue;
    rows.push({
      id: e.id,
      domain: e.domain,
      name: e.name,
      provider: e.provider,
      countries: e.coverage?.countries || [],
      status: e.health?.status || 'candidate',
      usable: isUsableEntry(e),
      licence: e.licence?.id || null,
      licenceUrl: isWebLink(e.licence?.url) ? e.licence.url : null,
      display: e.licence?.display === true,
    });
  }
  // Usable first, then verified, then the rest.
  const rank = (r) => (r.usable ? 0 : r.status === 'verified' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return rows.slice(0, Math.max(1, Math.min(100, limit)));
}

/**
 * Vite plugin: loads the directory (snapshot, then daily refresh) and serves
 *   GET /api/sources/directory?lat=&lon=&domain=&limit=  → referral rows
 * @param {ReturnType<typeof createSourceDirectory>} directory
 */
export function sourceDirectoryProxy(directory) {
  let started = false;
  function install(server) {
    if (!started) {
      started = true;
      directory.start();
      server.httpServer?.once('close', () => directory.close());
    }
    server.middlewares.use('/api/sources/directory', (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const num = (k) =>
        url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined;
      const body = JSON.stringify({
        generatedAt: directory.generatedAt(),
        sources: referralEntries(directory.entries(), {
          lat: num('lat'),
          lon: num('lon'),
          domain: url.searchParams.get('domain') || undefined,
          limit: num('limit'),
        }),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      });
      res.end(body);
    });
  }
  return {
    name: 'source-directory',
    closeBundle: () => directory.close(),
    configureServer: install,
    configurePreviewServer: install,
  };
}
