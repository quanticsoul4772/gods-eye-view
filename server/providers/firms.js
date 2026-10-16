import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';
import { FIRES_DOMAIN } from '../../src/data/sourceDomains.js';
import { readResponseTextCapped } from './common/http.js';
import { publicOnlyFetch } from './sourceDirectory.js';

/**
 * NASA FIRMS live active-fire proxy with a memory + disk cache.
 * Upstream: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/2
 *
 * Merges three VIIRS NRT sources (NOAA-20, NOAA-21, Suomi-NPP — independent
 * satellites, no cross-source dedup) plus MODIS_NRT (combined Terra+Aqua,
 * ~1 km, numeric 0-100 confidence), fetched sequentially (quota courtesy)
 * with `days=2` (`days=1` means "current UTC day", nearly empty just after
 * 00:00Z) and clamps to the trailing 24 h via src/data/firmsCsv.js. FIRMS
 * quota is 5,000 transactions / 10 min per MAP_KEY, so the cache is the point:
 * TTL 30 min, single-flight refresh, serve-stale-on-failure, and a
 * fresh-enough disk cache (.gev-cache/firms.json) prevents ANY upstream
 * fetch across dev-server restarts. Pattern mirrors celestrakProxy.
 *
 * Routes:
 *   GET /api/firms        → {fetchedAt, stale, ttlMs, sources, count, fires}
 *   GET /api/firms/status → {hasKey, lastFetch, count, stale, ttlMs, transactions}
 *
 * Keyless (no FIRMS_MAP_KEY): the source directory's usable `hazards.fires`
 * entries (NASA's public 24 h CSVs, MODIS + VIIRS NOAA-20/21) are fetched
 * instead, through `directoryFetch` (public addresses only, redirects
 * returned as failures), with the same cache, single-flight and stale rules;
 * status says {hasKey:false, keyless:true}. With neither a key nor a usable
 * entry: /api/firms → 503 {error:'no_key'} and nothing is fetched. A cache
 * entry remembers which mode filled it and is never served to the other.
 *
 * @param {{directory?: ?{usable: Function, ready?: Function},
 *   directoryFetch?: Function}} [options]
 * @returns {import('vite').Plugin}
 */
export function firmsProxy({
  directory = null,
  directoryFetch = publicOnlyFetch,
} = {}) {
  const TTL_MS = 30 * 60_000;
  const STATUS_TTL_MS = 5 * 60_000;
  const SOURCES = [
    'VIIRS_NOAA20_NRT',
    'VIIRS_NOAA21_NRT',
    'VIIRS_SNPP_NRT',
    'MODIS_NRT',
  ];
  /**
   * Per-source body cap. A VIIRS world/2 pull is ~130k rows x ~100 B, about
   * 13 MB per satellite in heavy fire season (MODIS runs smaller), so this is a
   * bound, not a budget.
   */
  const FIRMS_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'firms.json');

  /** How long a keyless request waits for the directory's first live load. */
  const DIRECTORY_WAIT_MS = 15_000;

  /** @type {?{at: number, mode: 'keyed'|'keyless', sources: Array<object>, fires: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** Single-flight refresh per mode: a keyed request never gets keyless data. */
  const inflight = { keyed: null, keyless: null };
  /** @type {?{at: number, transactions: ?{used: number, limit: number}}} mapkey_status cache */
  let statusCache = null;
  /** @type {?Promise<?{used: number, limit: number}>} */
  let statusInflight = null;

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Array.isArray(parsed?.sources) &&
        Array.isArray(parsed?.fires)
      ) {
        // Caches written before keyless mode were all keyed.
        mem = {
          ...parsed,
          mode: parsed.mode === 'keyless' ? 'keyless' : 'keyed',
        };
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[firms-proxy] cache write failed:', err?.message || err);
    }
  }

  /**
   * Fetch + parse one FIRMS source. Throws on HTTP error or a non-CSV body
   * (FIRMS reports errors as HTML/plain text, never CSV). Never log the URL —
   * it embeds the MAP_KEY.
   */
  async function fetchSource(key, source) {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
    const signal = AbortSignal.timeout(60_000);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = parseFirmsCsv(
      await readResponseTextCapped(res, FIRMS_MAX_RESPONSE_BYTES, signal),
    );
    if (records === null) throw new Error('non-CSV upstream response');
    return records;
  }

  /**
   * Refresh all sources sequentially (quota courtesy — never in parallel).
   * Partial success (≥1 source ok) still produces a cacheable entry with the
   * failed sources marked ok:false; total failure throws so the caller can
   * serve stale.
   */
  async function refreshUpstream(key) {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const source of SOURCES) {
      try {
        const records = filterTrailing24h(await fetchSource(key, source), now);
        // NOT fires.push(...records): spread passes each record as an argument,
        // and a world/2 VIIRS pull exceeds V8's argument limit (~125k) at
        // ~131k records — RangeError, and the whole source is silently dropped.
        for (const record of records) fires.push(record);
        sources.push({ source, count: records.length, ok: true });
      } catch (err) {
        console.warn(
          `[firms-proxy] ${source} fetch failed:`,
          err?.message || err,
        );
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
    return { at: now, sources, fires };
  }

  /** The directory's usable keyless fire entries, after its first live load. */
  async function keylessEntries() {
    if (!directory) return [];
    if (typeof directory.ready === 'function') {
      let timer;
      await Promise.race([
        directory.ready(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, DIRECTORY_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    return directory.usable(FIRES_DOMAIN);
  }

  /**
   * Fetch + parse one keyless directory entry. A redirect is a failure
   * (directoryFetch returns it unfollowed, and it is not ok).
   */
  async function fetchKeyless(entry) {
    const signal = AbortSignal.timeout(60_000);
    const res = await directoryFetch(entry.access.url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = parseFirmsCsv(
      await readResponseTextCapped(res, FIRMS_MAX_RESPONSE_BYTES, signal),
    );
    if (records === null) throw new Error('non-CSV upstream response');
    return records;
  }

  /**
   * Keyless counterpart of refreshUpstream, with the same partial-success
   * rule, one entry at a time. Each file holds the previous UTC day plus
   * today, so the trailing-24 h trim is what keeps it a 24 h layer.
   */
  async function refreshKeyless(entries) {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const entry of entries) {
      try {
        const records = filterTrailing24h(await fetchKeyless(entry), now);
        for (const record of records) fires.push(record); // no spread: see refreshUpstream
        sources.push({ source: entry.id, count: records.length, ok: true });
      } catch (err) {
        console.warn(
          `[firms-proxy] ${entry.id} fetch failed:`,
          err?.message || err,
        );
        sources.push({ source: entry.id, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok))
      throw new Error('all keyless FIRMS sources failed');
    return { at: now, sources, fires };
  }

  /**
   * Cache entry → response payload. Fires are RE-filtered to the trailing
   * 24 h at serve time so a stale cache never serves >24h-old detections.
   */
  function buildPayload(entry, stale) {
    const fires = filterTrailing24h(entry.fires, Date.now());
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      sources: entry.sources,
      count: fires.length,
      fires,
    };
  }

  /** mapkey_status transactions, cached 5 min, best-effort (null on failure). */
  function getTransactions(key) {
    const now = Date.now();
    if (statusCache && now - statusCache.at < STATUS_TTL_MS) {
      return Promise.resolve(statusCache.transactions);
    }
    if (!statusInflight) {
      statusInflight = (async () => {
        try {
          const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          const used = Number(body?.current_transactions);
          const limit = Number(body?.transaction_limit);
          return Number.isFinite(used) && Number.isFinite(limit)
            ? { used, limit }
            : null;
        } catch (err) {
          console.warn(
            '[firms-proxy] mapkey status failed:',
            err?.message || err,
          );
          return null;
        }
      })()
        .then((transactions) => {
          statusCache = { at: Date.now(), transactions };
          return transactions;
        })
        .finally(() => {
          statusInflight = null;
        });
    }
    return statusInflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/firms', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const subPath = String(req.url || '').split('?')[0];
        const key = mapKey();
        await readDiskOnce();

        const mode = key ? 'keyed' : 'keyless';
        const entries = key ? [] : await keylessEntries();
        const cached = mem?.mode === mode ? mem : null;

        if (subPath === '/status') {
          if (!key) {
            const known = entries.length > 0 && cached;
            sendJson(200, {
              hasKey: false,
              keyless: entries.length > 0,
              lastFetch: known ? cached.at : null,
              count: known ? cached.fires.length : null,
              stale: known ? Date.now() - cached.at >= TTL_MS : false,
              ttlMs: TTL_MS,
              transactions: null,
            });
            return;
          }
          const transactions = await getTransactions(key);
          sendJson(200, {
            hasKey: true,
            lastFetch: cached ? cached.at : null,
            count: cached ? cached.fires.length : null,
            stale: cached ? Date.now() - cached.at >= TTL_MS : false,
            ttlMs: TTL_MS,
            transactions,
          });
          return;
        }

        if (!key && !entries.length) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const entry = cached;
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        // Stale or missing → refresh, single-flight (concurrent requests
        // share one upstream pass). Capture the promise locally BEFORE
        // awaiting: the .finally() nulls `inflight` the moment it settles.
        if (!inflight[mode]) {
          inflight[mode] = (
            key ? refreshUpstream(key) : refreshKeyless(entries)
          )
            .then(async (refreshed) => {
              const fresh = { ...refreshed, mode };
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight[mode] = null;
            });
        }
        const pending = inflight[mode];
        const fresh = await pending;
        if (fresh) {
          sendJson(200, buildPayload(fresh, false));
        } else if (entry) {
          sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
        } else {
          sendJson(502, {
            error: 'firms fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[firms-proxy] error:', err?.message || err);
        sendJson(500, { error: 'firms proxy error' });
      }
    });
  };
  return {
    name: 'firms-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
