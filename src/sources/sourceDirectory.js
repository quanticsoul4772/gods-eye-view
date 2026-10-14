/**
 * The keyless source directory, as the server exposes it for referral
 * (`/api/sources/directory`): sources covering a point, usable ones first.
 */
export function createSourceDirectorySource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
    /**
     * @param {{lat?: number, lon?: number, domain?: string, limit?: number, signal?: AbortSignal}} query
     * @returns {Promise<{generatedAt: string|null, sources: object[]}>}
     */
    async find({ lat, lon, domain, limit = 10, signal } = {}) {
      signal?.throwIfAborted();
      const params = new URLSearchParams();
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        params.set('lat', String(lat));
        params.set('lon', String(lon));
      }
      if (domain) params.set('domain', domain);
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
      return { generatedAt: body.generatedAt ?? null, sources: body.sources };
    },
  };
}
