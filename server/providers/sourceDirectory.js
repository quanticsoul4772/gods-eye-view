/**
 * The keyless source directory (github.com/quanticsoul4772/gev-open-sources):
 * a published list of live feeds that need no key, each with its decoder,
 * licence decision and health. The server checks it hourly (bundled snapshot
 * first; unchanged files cost a 304), and offers only entries that are verified, cleared for display, of a
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
import {
  COVERAGE_LIMITS,
  coverageClassOfDomain,
  formatOfDomain,
  isWorldwideReference,
} from '../../src/data/sourceDomains.js';
import {
  bboxLonSpan,
  lonInBox,
  lonRangesOverlap,
} from '../../src/data/geoCircle.js';

export const SOURCE_DIRECTORY_URL =
  'https://quanticsoul4772.github.io/gev-open-sources/v1/index.json';
/**
 * How often the index is checked. Unchanged files answer 304 through the
 * per-file ETag cache. While the size guard keeps refusing a refresh the cache
 * isn't advanced, so changed domain files are downloaded again each hour.
 */
export const SOURCE_DIRECTORY_REFRESH_MS = 60 * 60 * 1000;
const SNAPSHOT_URL = new URL('./sourceDirectorySnapshot.json', import.meta.url);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
// The credential rule: a parameter (query, fragment, or `;name=value` in a
// path segment) named like a credential, a path segment after a key-like
// segment (`/key/<key>/`, `/api-key/<key>/`), or a value that looks like a
// token (JWT, AWS, Google, OpenAI, GitHub, Slack, a Bearer header).
const CREDENTIAL_PARAM =
  /key|token|secret|passw|pwd|signature|credential|session|jwt|bearer|authoriz|appid|app_id|app_code|client_id|clientid|^(sig|auth|code|sid|pass|pw|user|username|login|access|k|p)$/i;
const CREDENTIAL_SEGMENT =
  /^(key|keys|token|secret|auth|api[-_]?key|access[-_]?key|access[-_]?token|auth[-_]?token)$/i;
const TOKEN_VALUE = /^(eyJ|AKIA|AIza|sk-|ghp_|xox|[Bb]earer\s)/;
/** A path segment that is only a long hex run: an embedded key. */
const HEX_KEY = /^[0-9a-f]{32,}$/i;
/**
 * A known token format anywhere in the URL; each prefix must start a token
 * (not after a letter, digit, `_` or `-`), so a slug like
 * `transitous-sk-zsr-…` is not an `sk-` key.
 */
const SECRET_VALUE =
  /(?<![\w-])(?:eyJ[\w-]{10,}\.[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|sk-[\w-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[abposr]-[\w-]{10,}|[Bb]earer\s+[\w.~+/=-]{8,})/;
const SAFE_HEADERS = new Set(['et-client-name', 'user-agent', 'accept']);
const TEXT_MAX = 120;
const ATTRIBUTION_MAX = 300;

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
  const raw = String(value ?? '').replace(/&amp;/gi, '&');
  if (SECRET_VALUE.test(raw)) return true;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.username || url.password) return true;
  // Parameters: query, fragment, and path parameters (`name;a=b;c=d`).
  const params = [
    ...url.searchParams,
    ...new URLSearchParams(url.hash.replace(/^#!?\/?/, '')),
  ];
  const segments = [];
  for (const part of url.pathname.split('/').map(decode)) {
    const [name, ...pairs] = part.split(';');
    segments.push(name);
    for (const pair of pairs) {
      const at = pair.indexOf('=');
      params.push(
        at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)],
      );
    }
  }
  if (
    params.some(
      ([name, param]) => CREDENTIAL_PARAM.test(name) || TOKEN_VALUE.test(param),
    )
  )
    return true;
  // A bare run of 32+ hex characters as a path segment is how many APIs
  // embed a key (/gtfs/realtime/<32 hex>); UUIDs, with dashes, don't match.
  return segments.some(
    (segment, i) =>
      TOKEN_VALUE.test(segment) ||
      HEX_KEY.test(segment) ||
      (CREDENTIAL_SEGMENT.test(segment) && segments.slice(i + 1).some(Boolean)),
  );
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

// Parents shared by unrelated owners: a redirect "sibling" under one of these
// could belong to anyone.
const SHARED_PARENTS = new Set([
  'github.io',
  'gitlab.io',
  'amazonaws.com',
  's3.amazonaws.com',
  'cloudfront.net',
  'azurewebsites.net',
  'blob.core.windows.net',
  'core.windows.net',
  'herokuapp.com',
  'appspot.com',
  'firebaseapp.com',
  'web.app',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'workers.dev',
  'googleapis.com',
  'storage.googleapis.com',
]);
// Second-level labels under a country code (bikes.co.uk → co.uk).
const COUNTRY_SECOND_LEVEL = /^(co|com|net|org|gov|ac|edu|or|ne|go|gob|gouv)$/;

/**
 * A redirect host the proxy may follow: a DNS name under the feed host's
 * parent domain (data.example.org → download.example.org), never elsewhere,
 * and never a parent shared by unrelated owners (co.uk, github.io, …).
 */
function isSiblingHost(host, feedUrl) {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || /^[\d.]+$/.test(host))
    return false;
  const labels = new URL(feedUrl).hostname.toLowerCase().split('.').slice(1);
  if (labels.length < 2) return false;
  if (
    labels.length === 2 &&
    labels[1].length === 2 &&
    COUNTRY_SECOND_LEVEL.test(labels[0])
  )
    return false;
  const parent = labels.join('.');
  if (SHARED_PARENTS.has(parent)) return false;
  const name = host.toLowerCase();
  return name === parent || name.endsWith(`.${parent}`);
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
export function areSafeHeaders(headers) {
  if (headers === undefined) return true;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    return false;
  return Object.entries(headers).every(
    ([name, value]) =>
      SAFE_HEADERS.has(name.toLowerCase()) &&
      typeof value === 'string' &&
      /^[\x20-\x7e]{1,100}$/.test(value) &&
      !TOKEN_VALUE.test(value) &&
      !SECRET_VALUE.test(value),
  );
}

/**
 * A coverage box the app can activate a feed by: absent, or
 * [south, west, north, east] in range and no larger than its domain allows.
 * A box with a flipped sign or a stray far-away point (Cayenne's spanning
 * 105° of longitude) would switch the feed on half a world away.
 * @param {number[]|null|undefined} bbox
 * @param {string} [domain]
 */
export function isPlausibleCoverage(bbox, domain) {
  if (bbox === undefined || bbox === null) return true;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite))
    return false;
  const [south, west, north, east] = bbox;
  // The limit is the domain's, from the app table; a class the directory
  // publishes is never read, so upstream data can't widen it.
  const limit = COVERAGE_LIMITS[coverageClassOfDomain(domain)];
  const [maxLat, maxLon] = limit || [180, 360];
  return (
    south >= -90 &&
    north <= 90 &&
    west >= -180 &&
    east <= 180 &&
    south <= north &&
    north - south <= maxLat &&
    bboxLonSpan(west, east) <= maxLon
  );
}

/** Whether the app may fetch and display an entry. */
export function isUsableEntry(entry) {
  const headers = entry?.access?.headers;
  return (
    ID_PATTERN.test(entry?.id || '') &&
    entry.health?.status === 'verified' &&
    entry.licence?.display === true &&
    entry.format === formatOfDomain(entry.domain) &&
    isPlausibleCoverage(entry.coverage?.bbox, entry.domain) &&
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
 * Names, providers and attributions are third-party text that reaches credits,
 * layer status and the assistant: printable characters only, at most 120 of
 * them (300 for an attribution).
 */
const cleanText = (value, max = TEXT_MAX) =>
  String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')
    .trim()
    .slice(0, max);

function cleanDirectory(directory) {
  return {
    ...directory,
    entries: directory.entries.map((e) => ({
      ...e,
      name: cleanText(e?.name),
      provider: cleanText(e?.provider),
      ...(e?.licence && typeof e.licence === 'object'
        ? {
            licence: {
              ...e.licence,
              // Text only: anything else (e.g. a localized list) counts as
              // missing, so credits fall back to the provider.
              attribution:
                typeof e.licence.attribution === 'string'
                  ? cleanText(e.licence.attribution, ATTRIBUTION_MAX) || null
                  : null,
            },
          }
        : {}),
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
 * it has 50 entries, keeps its current entries. A domain missing from the new
 * copy counts as a full drop, so it too keeps its entries: a domain the
 * directory retires stays until the server restarts on a snapshot without it.
 * Returns null when the new copy is malformed or empty, or when every domain
 * in it was refused.
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

// A domain file the v1 index names: a plain file name beside the index.
const INDEX_FILE = /^[a-z0-9][a-z0-9.-]*\.json$/;

/**
 * Read one JSON document, https (conditional on `etag`) or `file:` (a local
 * build; fetch() can't read one). Resolves null when unchanged (304).
 */
async function readJson(url, fetchImpl, etag) {
  if (url.startsWith('file:'))
    return {
      body: JSON.parse(await fs.promises.readFile(new URL(url), 'utf8')),
      tag: null,
    };
  const response = await fetchImpl(url, {
    headers: etag ? { 'If-None-Match': etag } : {},
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 304) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return { body: await response.json(), tag: response.headers.get('etag') };
}

/**
 * Load the directory from `url`: a v1 index, whose domain files are each
 * fetched unless unchanged since `cache` (per-file ETag and entries), or a
 * whole directory file. The full directory file is never fetched through an
 * index. Resolves null when the index (or file) is unchanged; a domain file
 * that can't be read rejects the whole load.
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, cache?: Map<string, {tag: string|null, entries?: object[]}>}} [options]
 * @returns {Promise<{directory: object, cache: Map<string, object>}|null>}
 */
export async function loadDirectory(
  url,
  { fetchImpl = fetch, cache = new Map() } = {},
) {
  const top = await readJson(url, fetchImpl, cache.get(url)?.tag);
  if (!top) return null;
  const next = new Map([[url, { tag: top.tag }]]);
  if (!Array.isArray(top.body?.files))
    return { directory: top.body, cache: next };
  const entries = [];
  for (const file of top.body.files) {
    if (typeof file?.domain !== 'string') continue; // the full file
    if (!INDEX_FILE.test(file.path || '')) {
      console.warn(
        `[sources] index lists an unusable file name: ${String(file.path).slice(0, 80)}`,
      );
      continue;
    }
    const fileUrl = new URL(file.path, url).href;
    if (next.has(fileUrl)) continue; // listed twice
    const known = cache.get(fileUrl);
    const read = await readJson(
      fileUrl,
      fetchImpl,
      known?.entries && known.tag,
    );
    if (read && !Array.isArray(read.body?.entries))
      throw new Error(`${fileUrl}: no entries`);
    // A domain file carries only its own domain.
    const domainEntries = read
      ? read.body.entries.filter((e) => e?.domain === file.domain)
      : known.entries;
    next.set(fileUrl, {
      tag: read ? read.tag : known.tag,
      entries: domainEntries,
    });
    entries.push(...domainEntries);
  }
  return {
    directory: {
      version: top.body.version,
      generated_at: top.body.generated_at,
      entries,
    },
    cache: next,
  };
}

/** Usable entry ids per domain: in a snapshot, the entries that kept `access`. */
function usableIdsByDomain(directory) {
  const out = new Map();
  for (const e of directory?.entries || []) {
    if (!e?.access) continue;
    if (!out.has(e.domain)) out.set(e.domain, new Set());
    out.get(e.domain).add(e.id);
  }
  return out;
}

/**
 * Usable ids lost and gained per domain between two snapshots, and whether
 * the new one may be written: a domain may lose at most min(5, 10 %) of its
 * usable entries (a short upstream outage once hid 10 bike-share systems).
 * No baseline, or a domain new in `next`, never refuses.
 * @param {object|null} previous the committed snapshot
 * @param {object} next the snapshot about to be written
 * @returns {{ok: boolean, domains: Array<{domain: string, before: number,
 *   after: number, lost: string[], gained: string[], refused: boolean}>}}
 */
export function compareSnapshots(previous, next) {
  const before = usableIdsByDomain(previous);
  const after = usableIdsByDomain(next);
  const domains = [];
  for (const domain of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(domain) || new Set();
    const now = after.get(domain) || new Set();
    const lost = [...was].filter((id) => !now.has(id)).sort();
    const gained = [...now].filter((id) => !was.has(id)).sort();
    const allowed = Math.min(5, Math.floor(was.size * 0.1));
    domains.push({
      domain,
      before: was.size,
      after: now.size,
      lost,
      gained,
      refused: was.size > 0 && lost.length > allowed,
    });
  }
  domains.sort((a, b) => a.domain.localeCompare(b.domain));
  return { ok: domains.every((d) => !d.refused), domains };
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
  let cache = new Map();
  let timer = null;
  let usable = current.entries.filter(isUsableEntry);
  // Hourly refreshes would repeat the same warning all day: say each once.
  let lastWarning = null;
  const warnOnce = (message) => {
    if (message === lastWarning) return;
    lastWarning = message;
    console.warn(message);
  };

  async function refresh() {
    try {
      const loaded = await loadDirectory(url, { fetchImpl, cache });
      if (!loaded) return false;
      const next = mergeDirectory(loaded.directory, live ? current : null);
      if (!next) {
        warnOnce(
          `[sources] directory refresh refused by the size guard: ${url} (${loaded.directory?.generated_at || 'no date'})`,
        );
        return false;
      }
      current = cleanDirectory(next);
      live = true;
      usable = current.entries.filter(isUsableEntry);
      cache = loaded.cache;
      lastWarning = null;
      return true;
    } catch (error) {
      warnOnce(
        `[sources] directory refresh failed: ${error?.message || error}`,
      );
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

const URL_MAX = 500;

/** A `south,west,north,east` area, or null. */
export function parseArea(value) {
  const parts = String(value ?? '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [south, west, north, east] = parts;
  return south <= north && west <= east ? { south, west, north, east } : null;
}

/**
 * Every directory entry that covers a point or overlaps an area (or all,
 * without either), for referral: what can be shown now, and what exists.
 * Never returns feed URLs; every text field is cleaned, since rows reach the
 * assistant.
 * @param {object[]} entries
 * @param {{lat?: number, lon?: number, area?: {south: number, west: number,
 *   north: number, east: number}|null, domain?: string, usable?: boolean}} query
 */
function referralRows(
  entries,
  { lat, lon, area, domain, domains, usable } = {},
) {
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);
  const wanted = new Set(
    [domain, ...(Array.isArray(domains) ? domains : [])].filter(Boolean),
  );
  const rows = [];
  for (const e of entries) {
    if (wanted.size ? !wanted.has(e.domain) : isWorldwideReference(e.domain))
      continue;
    if (typeof usable === 'boolean' && isUsableEntry(e) !== usable) continue;
    const b = e.coverage?.bbox;
    // A bad box (flipped sign, stray point) would name the feed half a world away.
    if ((area || hasPoint) && !isPlausibleCoverage(b, e.domain)) continue;
    if (
      area &&
      !(
        Array.isArray(b) &&
        b[0] <= area.north &&
        b[2] >= area.south &&
        lonRangesOverlap(b[1], b[3], area.west, area.east)
      )
    )
      continue;
    if (
      !area &&
      hasPoint &&
      !(b && lat >= b[0] && lat <= b[2] && lonInBox(lon, b[1], b[3]))
    )
      continue;
    const licenceUrl = isWebLink(e.licence?.url) ? String(e.licence.url) : '';
    rows.push({
      id: cleanText(e.id),
      domain: cleanText(e.domain),
      name: e.name,
      provider: e.provider,
      countries: (Array.isArray(e.coverage?.countries)
        ? e.coverage.countries
        : []
      )
        .slice(0, 20)
        .map((c) => cleanText(c, 8)),
      status: cleanText(e.health?.status || 'candidate', 20),
      usable: isUsableEntry(e),
      licence: cleanText(e.licence?.id) || null,
      licenceUrl:
        licenceUrl && licenceUrl.length <= URL_MAX ? licenceUrl : null,
      display: e.licence?.display === true,
    });
  }
  // Usable first, then verified, then the rest.
  const rank = (r) => (r.usable ? 0 : r.status === 'verified' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return rows;
}

/**
 * The first `limit` (1–100) referral rows.
 * @param {object[]} entries
 * @param {{lat?: number, lon?: number, area?: object|null, domain?: string,
 *   usable?: boolean, limit?: number}} query
 */
export function referralEntries(entries, { limit = 25, ...query } = {}) {
  return referralRows(entries, query).slice(0, clampLimit(limit));
}

const clampLimit = (limit) =>
  Math.max(1, Math.min(100, Number.isFinite(limit) ? limit : 25));

/**
 * Vite plugin: loads the directory (snapshot, then daily refresh) and serves
 *   GET /api/sources/directory?lat=&lon=|bbox=s,w,n,e&domain=…&usable=&limit=
 *     (`domain` may repeat; without it, worldwide reference-only domains are left out)
 *     → the first `limit` referral rows, and `total` matching rows
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
      const usable = url.searchParams.get('usable');
      const rows = referralRows(directory.entries(), {
        lat: num('lat'),
        lon: num('lon'),
        area: parseArea(url.searchParams.get('bbox')),
        domains: url.searchParams.getAll('domain').filter(Boolean),
        usable:
          usable === 'true' ? true : usable === 'false' ? false : undefined,
      });
      const body = JSON.stringify({
        generatedAt: cleanText(directory.generatedAt(), 40) || null,
        total: rows.length,
        sources: rows.slice(0, clampLimit(num('limit'))),
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
