/**
 * Transit feeds from the keyless source directory, in the static registry's
 * shape (`src/data/transitFeeds.js`). Pure: the server hands in entries that
 * already passed its URL guards (`server/providers/sourceDirectory.js`).
 */
import { TRANSIT_FEED_ID_PATTERN } from './transitFeeds.js';
import { bboxToCircle } from './geoCircle.js';

export { bboxToCircle };

/** A feed covering more than this radius is answered per view (`?bbox=`). */
export const NATIONAL_FEED_RADIUS_KM = 300;

/**
 * Registry-shaped feed for a usable directory entry, or null.
 * @param {object} entry directory entry (domain transit.vehicles)
 */
export function directoryTransitFeed(entry) {
  if (!TRANSIT_FEED_ID_PATTERN.test(entry?.id || '')) return null;
  if (!Array.isArray(entry.coverage?.bbox)) return null;
  const { center, loadRadiusKm } = bboxToCircle(entry.coverage.bbox);
  return {
    id: entry.id,
    name: entry.name,
    operator: entry.provider,
    region: (entry.coverage.countries || []).join(', ') || entry.provider,
    center,
    loadRadiusKm,
    url: entry.access.url,
    headers: { ...(entry.access.headers || {}) },
    redirectHosts: [...(entry.access.redirectHosts || [])],
    unzip: entry.access.unzip || null,
    license: entry.licence.id,
    licenseUrl: entry.licence.url,
    attribution: entry.licence.attribution || entry.provider,
    defaultMode: 'bus',
    defaultEnabled: true,
    historyRetention: false,
    national: loadRadiusKm > NATIONAL_FEED_RADIUS_KM,
    directory: true,
  };
}

/** The public catalog row for a directory feed (no URL, no headers). */
export function publicDirectoryFeed(feed) {
  return {
    id: feed.id,
    name: feed.name,
    operator: feed.operator,
    region: feed.region,
    center: { ...feed.center },
    loadRadiusKm: feed.loadRadiusKm,
    license: feed.license,
    licenseUrl: feed.licenseUrl,
    attribution: feed.attribution,
    historyRetention: false,
    defaultMode: feed.defaultMode,
    national: feed.national,
    directory: true,
  };
}

/** `minLat,minLon,maxLat,maxLon` → bbox, or null if malformed. */
export function parseBbox(value) {
  const parts = String(value ?? '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [minLat, minLon, maxLat, maxLon] = parts;
  if (minLat > maxLat || minLat < -90 || maxLat > 90) return null;
  if (minLon < -180 || maxLon > 180 || minLon > maxLon) return null;
  return parts;
}

/** A snapshot with only the vehicles inside bbox. */
export function snapshotInBbox(snapshot, [minLat, minLon, maxLat, maxLon]) {
  const vehicles = snapshot.vehicles.filter(
    (v) =>
      v.lat >= minLat && v.lat <= maxLat && v.lon >= minLon && v.lon <= maxLon,
  );
  return { ...snapshot, vehicles, count: vehicles.length };
}
