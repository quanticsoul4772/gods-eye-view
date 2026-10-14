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
// The credential rule the directory publishes under (gev-open-sources): a
// parameter (query or fragment) named like a credential, a path segment after
// a key-like segment (`/key/<key>/`), or a value that looks like a token.
const CREDENTIAL_PARAM =
  /key|token|secret|passw|pwd|signature|credential|appid|app_id|app_code|client_id|session|jwt|bearer|^(sig|auth|code|sid|pass|user|username|login|access|k|p)$/i;
const CREDENTIAL_SEGMENT = /^(key|token|apikey|api_key|auth|secret)$/i;
const TOKEN_VALUE = /^(eyJ|AKIA|sk-|ghp_|xox)/;
const SAFE_HEADERS = new Set(['et-client-name', 'user-agent', 'accept']);
const TEXT_MAX = 120;
const FORMATS = new Set(['gtfs-rt.vehicle-positions', 'gbfs.station-status']);

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Whether a URL carries a credential: userinfo, a credential parameter, a key
 * in its path, or a token-like value. Unparseable counts as carrying one.
 */
export function hasCredential(value) {
  let url;
  try {
    url = new URL(String(value).replace(/&amp;/gi, '&'));
  } catch {
    return true;
  }
  if (url.username || url.password) return true;
  const segments = url.pathname.split('/').filter(Boolean).map(decode);
  if (
    segments.some(
      (segment, i) =>
        TOKEN_VALUE.test(segment) ||
        (CREDENTIAL_SEGMENT.test(segment) && i < segments.length - 1),
    )
  )
    return true;
  for (const params of [
    url.searchParams,
    new URLSearchParams(url.hash.slice(1)),
  ])
    for (const [name, param] of params)
      if (CREDENTIAL_PARAM.test(name) || TOKEN_VALUE.test(param)) return true;
  return false;
}

/** An https URL on the default port, a DNS name (no IP literal), no credentials. */
export function isSafeSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port) return false;
  const host = url.hostname;
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('['))
    return false;
  return !hasCredential(value);
}

/**
 * A redirect host the proxy may follow: a DNS name under the feed host's
 * parent domain (data.example.org → download.example.org), never elsewhere.
 */
function isSiblingHost(host, feedUrl) {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || /^[\d.]+$/.test(host))
    return false;
  const labels = new URL(feedUrl).hostname.split('.').slice(1);
  if (labels.length < 2) return false;
  const parent = labels.join('.');
  return host === parent || host.endsWith(`.${parent}`);
}

/** A licence link the UI may render: http(s) only (never `javascript:` etc.). */
const isWebLink = (value) => {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/**
 * Credentials never come from the directory, headers included: only client
 * identification (Entur requires `ET-Client-Name`) and content negotiation,
 * as short printable values that don't look like tokens.
 */
function areSafeHeaders(headers) {
  if (headers === undefined) return true;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    return false;
  return Object.entries(headers).every(
    ([name, value]) =>
      SAFE_HEADERS.has(name.toLowerCase()) &&
      typeof value === 'string' &&
      /^[\x20-\x7e]{1,100}$/.test(value) &&
      !TOKEN_VALUE.test(value),
  );
}

/** Whether the app may fetch and display an entry. */
export function isUsableEntry(entry) {
  const headers = entry?.access?.headers;
  return (
    ID_PATTERN.test(entry?.id || '') &&
    entry.health?.status === 'verified' &&
    entry.licence?.display === true &&
    FORMATS.has(entry.format) &&
    isSafeSourceUrl(entry.access?.url) &&
    areSafeHeaders(headers) &&
    Object.values(entry.access?.related || {}).every(isSafeSourceUrl) &&
    (entry.access?.redirectHosts || []).every((host) =>
      isSiblingHost(host, entry.access.url),
    ) &&
    (entry.licence.url === null ||
      (isWebLink(entry.licence.url) && !hasCredential(entry.licence.url)))
  );
}

/**
 * Names and providers are third-party text that reaches credits, layer status
 * and the assistant: printable characters only, at most 120 of them.
 */
const cleanText = (value) =>
  String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')
    .trim()
    .slice(0, TEXT_MAX);

function cleanDirectory(directory) {
  return {
    ...directory,
    entries: directory.entries.map((e) => ({
      ...e,
      name: cleanText(e?.name),
      provider: cleanText(e?.provider),
    })),
  };
}

const countByDomain = (entries) => {
  const counts = new Map();
  for (const e of entries)
    counts.set(e?.domain, (counts.get(e?.domain) || 0) + 1);
  return counts;
};

/**
 * Merge a newly fetched directory into the one in use, domain by domain: a
 * domain whose entry count drops by more than 20 %, or more than doubles once
 * it has 50 entries, keeps its current entries. Returns null when the new
 * copy is malformed or empty, or when every domain in it was refused.
 */
export function mergeDirectory(next, current) {
  if (!next || !Array.isArray(next.entries) || !next.entries.length)
    return null;
  if (!current?.entries?.length) return next;
  const before = countByDomain(current.entries);
  const after = countByDomain(next.entries);
  const kept = new Set();
  for (const [domain, was] of before) {
    const now = after.get(domain) || 0;
    if (now < was * 0.8 || (was >= 50 && now > was * 2)) kept.add(domain);
  }
  if ([...after.keys()].every((domain) => kept.has(domain))) return null;
  return {
    ...next,
    entries: [
      ...next.entries.filter((e) => !kept.has(e?.domain)),
      ...current.entries.filter((e) => kept.has(e?.domain)),
    ],
  };
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
 *   refreshMs?: number}} [options] `url` may be a `file:` URL.
 */
export function createSourceDirectory({
  fetchImpl = fetch,
  url = SOURCE_DIRECTORY_URL,
  snapshot = readSnapshot(),
  refreshMs = SOURCE_DIRECTORY_REFRESH_MS,
} = {}) {
  let current = mergeDirectory(snapshot, null)
    ? cleanDirectory(snapshot)
    : { entries: [] };
  // The size guard compares live copies only: a bundled snapshot can be far
  // older than the live directory, which grows, and must not pin the app to it.
  let live = false;
  let etag = null;
  let timer = null;
  let usable = current.entries.filter(isUsableEntry);

  // A `file:` URL is a local build of the directory (fetch() can't read one).
  async function load() {
    if (url.startsWith('file:'))
      return {
        body: JSON.parse(await fs.promises.readFile(new URL(url), 'utf8')),
        tag: null,
      };
    const response = await fetchImpl(url, {
      headers: etag ? { 'If-None-Match': etag } : {},
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 304 || !response.ok) return null;
    return { body: await response.json(), tag: response.headers.get('etag') };
  }

  async function refresh() {
    try {
      const loaded = await load();
      if (!loaded) return false;
      const next = mergeDirectory(loaded.body, live ? current : null);
      if (!next) return false;
      current = cleanDirectory(next);
      live = true;
      usable = current.entries.filter(isUsableEntry);
      etag = loaded.tag;
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
