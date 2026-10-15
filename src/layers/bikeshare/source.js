import {
  createListedSourceCounter,
  createSourceDirectorySource,
} from '../../sources/sourceDirectory.js';
import { BIKESHARE_DOMAIN } from '../../data/sourceDomains.js';

/** Read a GBFS station document through the existing bounded server proxy. */
export function createBikeshareSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /** Systems the source directory lists here that the app can't show. */
    listed: createListedSourceCounter({
      domain: BIKESHARE_DOMAIN,
      directory: createSourceDirectorySource({ fetchImpl }),
    }),
    /** Systems the server adds from the keyless source directory. */
    async getSystems({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/gbfs/systems', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!response.ok) throw new Error('GBFS systems HTTP ' + response.status);
      const payload = await response.json();
      return Array.isArray(payload?.systems) ? payload.systems : [];
    },
    /** Free-floating shared-vehicle systems (no feed URLs). */
    async getVehicleSystems({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/sharedmobility/systems', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!response.ok)
        throw new Error('Shared vehicle systems HTTP ' + response.status);
      const payload = await response.json();
      return Array.isArray(payload?.systems) ? payload.systems : [];
    },
    /** One system's free vehicles, by directory entry id. */
    async getVehicles(systemId, { signal } = {}) {
      if (typeof systemId !== 'string' || !systemId)
        throw new TypeError('A shared vehicle system id is required');
      signal?.throwIfAborted();
      const response = await fetchImpl(
        '/api/sharedmobility/vehicles/' + encodeURIComponent(systemId),
        { method: 'GET', headers: { Accept: 'application/json' }, signal },
      );
      if (!response.ok)
        throw new Error('Shared vehicles HTTP ' + response.status);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.vehicles))
        throw new Error('Malformed shared vehicle payload');
      return payload;
    },
    async getStations(upstreamUrl, { signal } = {}) {
      const url = new URL(upstreamUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash)
        throw new TypeError('A public HTTPS GBFS URL is required');
      signal?.throwIfAborted();
      const response = await fetchImpl(
        '/api/gbfs/' + encodeURIComponent(url.href),
        { method: 'GET', headers: { Accept: 'application/json' }, signal },
      );
      if (!response.ok) throw new Error('GBFS HTTP ' + response.status);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!payload || typeof payload !== 'object')
        throw new Error('Malformed GBFS payload');
      return payload;
    },
  };
}
