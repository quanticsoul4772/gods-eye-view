/**
 * The keyless source directory, as the server exposes it for referral
 * (`/api/sources/directory`): sources covering a point, usable ones first.
 */
export function createSourceDirectorySource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
    /**
     * @param {{lat?: number, lon?: number, domain?: string, usable?: boolean,
     *   limit?: number, signal?: AbortSignal}} query
     * @returns {Promise<{generatedAt: string|null, total: number, sources: object[]}>}
     */
    async find({ lat, lon, domain, usable, limit = 10, signal } = {}) {
      signal?.throwIfAborted();
      const params = new URLSearchParams();
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        params.set('lat', String(lat));
        params.set('lon', String(lon));
      }
      if (domain) params.set('domain', domain);
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

/**
 * How many sources the directory lists, but the app can't show, around a
 * point in one domain: one request per 0.5° cell, one in flight at a time,
 * each cell's count kept for the page's lifetime.
 * @param {{domain: string, directory?: ReturnType<typeof createSourceDirectorySource>}} options
 */
export function createListedSourceCounter({
  domain,
  directory = createSourceDirectorySource(),
}) {
  const counts = new Map();
  let inFlight = null;
  const cell = (lat, lon) => {
    const row = Math.floor(lat / LISTED_SOURCES_CELL_DEG);
    const col = Math.floor(lon / LISTED_SOURCES_CELL_DEG);
    return {
      key: `${row}:${col}`,
      lat: (row + 0.5) * LISTED_SOURCES_CELL_DEG,
      lon: (col + 0.5) * LISTED_SOURCES_CELL_DEG,
    };
  };
  return {
    /** The count for a point's cell, or null until it has been asked. */
    count(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return counts.get(cell(lat, lon).key) ?? null;
    },
    /** Ask for a point's cell unless known or a request is out; resolves true when a count arrived. */
    async request(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || inFlight)
        return false;
      const target = cell(lat, lon);
      if (counts.has(target.key)) return false;
      inFlight = target.key;
      try {
        const { total } = await directory.find({
          lat: target.lat,
          lon: target.lon,
          domain,
          usable: false,
          limit: 1,
        });
        counts.set(target.key, total);
        return true;
      } catch {
        // A failed count is asked again on the next settled camera.
        return false;
      } finally {
        inFlight = null;
      }
    },
  };
}

/** The status suffix for a count: "" until known or when nothing is listed. */
export function listedSourcesText(count) {
  if (!Number.isFinite(count) || count <= 0) return '';
  return ` · ${count} listed source${count === 1 ? '' : 's'}`;
}
