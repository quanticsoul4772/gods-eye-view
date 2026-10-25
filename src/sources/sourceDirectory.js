/**
 * The keyless source directory, as the server exposes it for referral
 * (`/api/sources/directory`): sources covering a point, usable ones first.
 */
export function createSourceDirectorySource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
    /**
     * @param {{lat?: number, lon?: number, bbox?: number[], domain?: string, domains?: string[],
     *   usable?: boolean, limit?: number, signal?: AbortSignal}} query
     *   `bbox` is `[south, west, north, east]`: sources overlapping that area.
     * @returns {Promise<{generatedAt: string|null, total: number, sources: object[]}>}
     */
    async find({
      lat,
      lon,
      bbox,
      domain,
      domains,
      usable,
      limit = 10,
      signal,
    } = {}) {
      signal?.throwIfAborted();
      const params = new URLSearchParams();
      if (Array.isArray(bbox) && bbox.length === 4)
        params.set('bbox', bbox.join(','));
      else if (Number.isFinite(lat) && Number.isFinite(lon)) {
        params.set('lat', String(lat));
        params.set('lon', String(lon));
      }
      for (const d of [domain, ...(Array.isArray(domains) ? domains : [])])
        if (d) params.append('domain', d);
      if (typeof usable === 'boolean') params.set('usable', String(usable));
      params.set('limit', String(limit));
      const response = await fetchImpl(`/api/sources/directory?${params}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok)
        throw new Error(`Source directory HTTP ${response.status}`);
      const body = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(body?.sources))
        throw new Error('Malformed source directory');
      return {
        generatedAt: body.generatedAt ?? null,
        total: Number.isFinite(body.total) ? body.total : body.sources.length,
        sources: body.sources,
      };
    },
  };
}

/** Listed-source counts are kept per cell of this many degrees. */
export const LISTED_SOURCES_CELL_DEG = 0.5;
/** A count request gives up after this long, so one stuck request can't block the rest. */
export const LISTED_SOURCES_TIMEOUT_MS = 10_000;

/**
 * How many sources the directory lists, but the app can't show, in the 0.5°
 * cell around a point in one domain: sources whose coverage overlaps the cell.
 * One request per cell, one in flight at a time (the latest point asked
 * meanwhile is asked next), each cell's count kept for the page's lifetime.
 * @param {{domain: string, directory?: ReturnType<typeof createSourceDirectorySource>,
 *   timeoutMs?: number}} options
 */
export function createListedSourceCounter({
  domain,
  directory = createSourceDirectorySource(),
  timeoutMs = LISTED_SOURCES_TIMEOUT_MS,
}) {
  const counts = new Map();
  let inFlight = null;
  let waiting = null;
  const cell = (lat, lon) => {
    const row = Math.floor(lat / LISTED_SOURCES_CELL_DEG);
    const col = Math.floor(lon / LISTED_SOURCES_CELL_DEG);
    return {
      key: `${row}:${col}`,
      bbox: [
        row * LISTED_SOURCES_CELL_DEG,
        col * LISTED_SOURCES_CELL_DEG,
        (row + 1) * LISTED_SOURCES_CELL_DEG,
        (col + 1) * LISTED_SOURCES_CELL_DEG,
      ],
    };
  };
  async function request(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    const target = cell(lat, lon);
    if (counts.has(target.key)) return false;
    if (inFlight) {
      waiting = { lat, lon };
      return false;
    }
    return ask(target);
  }
  async function ask(target) {
    // Settles when this request ends, for callers waiting their turn.
    let done;
    inFlight = new Promise((resolve) => {
      done = resolve;
    });
    try {
      const { total } = await directory.find({
        bbox: target.bbox,
        domain,
        usable: false,
        limit: 1,
        signal: AbortSignal.timeout(timeoutMs),
      });
      counts.set(target.key, total);
      return true;
    } catch {
      // A failed or timed-out count is asked again on a later settled camera.
      return false;
    } finally {
      inFlight = null;
      done();
      if (waiting) {
        const next = waiting;
        waiting = null;
        void request(next.lat, next.lon);
      }
    }
  }
  return {
    /** The count for a point's cell, or null until it has been asked. */
    count(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return counts.get(cell(lat, lon).key) ?? null;
    },
    /** Ask for a point's cell unless known; resolves true when a count arrived. */
    request,
    /**
     * Ask for a point's cell and wait for its count, behind a request for
     * another cell already in flight (which `request` declines). A bounded
     * number of tries, each under the request timeout.
     * @returns {Promise<number|null>} The count, or null if none arrived.
     */
    async requestSettled(lat, lon) {
      for (
        let attempt = 0;
        attempt < 3 && this.count(lat, lon) === null;
        attempt += 1
      ) {
        if (inFlight) await inFlight;
        else await request(lat, lon);
      }
      return this.count(lat, lon);
    },
  };
}

/** The status suffix for a count: "" until known or when nothing is listed. */
export function listedSourcesText(count) {
  if (!Number.isFinite(count) || count <= 0) return '';
  return ` · ${count} listed source${count === 1 ? '' : 's'}`;
}
