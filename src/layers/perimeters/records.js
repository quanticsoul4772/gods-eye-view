/**
 * Normalize a WFIGS feed, skipping individually invalid features.
 * Only a payload that is not a feature collection at all rejects the whole
 * snapshot: a single degenerate incident (ArcGIS emits geometry:null when
 * maxAllowableOffset generalizes a tiny polygon away) must never blank the
 * layer — a failed first update makes the lifecycle disable it entirely.
 */

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const textOrNull = (value) => (typeof value === 'string' ? value : null);

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) return false;
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return false;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return false;
  }
  return true;
}

/** Normalize Polygon/MultiPolygon geometry to an array of polygons (each an
 * array of rings). Returns null on malformed geometry, [] when empty. */
function normalizePolygons(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return null;
  if (!Array.isArray(polygons)) return null;
  const result = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings)) return null;
    if (!rings.length) continue;
    if (!rings.every(validRing)) return null;
    result.push(rings);
  }
  return result;
}

export function normalizeFirePerimeterSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      continue;
    const polygons = normalizePolygons(feature.geometry);
    if (polygons === null || !polygons.length) continue;
    const uniqueId = properties.attr_UniqueFireIdentifier;
    const stableId =
      typeof uniqueId === 'string' && uniqueId !== ''
        ? uniqueId
        : feature.id == null || feature.id === ''
          ? null
          : String(feature.id);
    if (stableId == null || ids.has(stableId)) continue;
    ids.add(stableId);
    rows.push({
      stableId,
      name:
        typeof properties.poly_IncidentName === 'string'
          ? properties.poly_IncidentName
          : null,
      acres: finiteOrNull(properties.attr_IncidentSize),
      containedPct: finiteOrNull(properties.attr_PercentContained),
      state:
        typeof properties.attr_POOState === 'string'
          ? properties.attr_POOState
          : null,
      category:
        typeof properties.attr_IncidentTypeCategory === 'string'
          ? properties.attr_IncidentTypeCategory
          : null,
      discoveredTime: finiteOrNull(properties.attr_FireDiscoveryDateTime),
      updatedTime: finiteOrNull(properties.poly_DateCurrent),
      cause: textOrNull(properties.attr_FireCause),
      behavior: textOrNull(properties.attr_FireBehaviorGeneral),
      personnel: finiteOrNull(properties.attr_TotalIncidentPersonnel),
      county: textOrNull(properties.attr_POOCounty),
      costToDate: finiteOrNull(properties.attr_EstimatedCostToDate),
      complexity: textOrNull(properties.attr_IncidentComplexityLevel),
      complexName: textOrNull(properties.attr_CpxName),
      hectares: Number.isFinite(properties.attr_IncidentSize)
        ? properties.attr_IncidentSize / ACRES_PER_HECTARE
        : null,
      status: null,
      link: null,
      source: 'wfigs',
      attribution: null,
      licenceUrl: null,
      polygons,
    });
  }
  return rows;
}

const ACRES_PER_HECTARE = 2.4710538;

/** Stages of control a provincial feed may report; anything else is unknown. */
export const PERIMETER_STATUSES = Object.freeze([
  'Out of Control',
  'Being Held',
  'Under Control',
  'Out',
]);

/**
 * A mapped date: epoch milliseconds, or `YYYY-MM-DD` (optionally `Z`) read as
 * UTC midnight. Anything else is unknown.
 */
export function mappedTime(value) {
  if (Number.isFinite(value) && value >= 1e12 && value < 1e13) return value;
  if (typeof value !== 'string') return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})Z?$/.exec(value);
  if (!day) return null;
  const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  return Number.isFinite(ms) ? ms : null;
}

/** An incident page from a provincial feed: https on the feed's own site family. */
function incidentLink(value, allowedHost) {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // https, default port, and nothing between "//" and the host (no user info).
  if (url.port || !url.href.startsWith(`https://${url.host}/`)) return null;
  return allowedHost(url.hostname) ? url.href : null;
}

/**
 * Normalize a provincial perimeter feed (a source-directory entry of format
 * `geojson.fire-perimeters`) into the same rows as WFIGS, through the entry's
 * `mapping`. Features sharing a fire number merge into one row (all polygons,
 * the newest mapping date). Ids are `<entry id>/<fire number>`: no `:`, which
 * the layer's pick ids use as a separator.
 * @param {object} geojson
 * @param {{id: string, mapping: object, licence?: object}} entry
 * @param {{allowedLinkHost?: (host: string) => boolean}} [options]
 */
export function normalizeMappedPerimeters(
  geojson,
  entry,
  { allowedLinkHost = () => false } = {},
) {
  if (!Array.isArray(geojson?.features)) return null;
  const mapping = entry.mapping;
  const read = (properties, key) =>
    mapping[key] && Object.hasOwn(properties, mapping[key])
      ? properties[mapping[key]]
      : null;
  const rows = new Map();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      continue;
    const polygons = normalizePolygons(feature.geometry);
    if (polygons === null || !polygons.length) continue;
    const rawId = read(properties, 'id');
    const fireId =
      typeof rawId === 'string' || Number.isFinite(rawId)
        ? String(rawId)
            .replace(/[^!-~]/g, '')
            .replaceAll(':', '-')
            .slice(0, 64)
        : '';
    if (!fireId) continue;
    const stableId = `${entry.id}/${fireId}`;
    const hectares = finiteOrNull(read(properties, 'size_ha'));
    const status = read(properties, 'status');
    const row = {
      stableId,
      name: fireId,
      acres: hectares === null ? null : hectares * ACRES_PER_HECTARE,
      hectares,
      containedPct: null,
      state: mapping.region,
      category: null,
      discoveredTime: null,
      updatedTime: mappedTime(read(properties, 'updated')),
      cause: null,
      behavior: null,
      personnel: null,
      county: null,
      costToDate: null,
      complexity: null,
      complexName: null,
      status: PERIMETER_STATUSES.includes(status) ? status : null,
      link: incidentLink(read(properties, 'url'), allowedLinkHost),
      source: entry.id,
      attribution: textOrNull(entry.licence?.attribution),
      licenceUrl: textOrNull(entry.licence?.url),
      polygons,
    };
    const earlier = rows.get(stableId);
    if (!earlier) {
      rows.set(stableId, row);
      continue;
    }
    // One fire in several features: keep every polygon, and the newest facts.
    const newer =
      (row.updatedTime ?? -Infinity) > (earlier.updatedTime ?? -Infinity)
        ? row
        : earlier;
    rows.set(stableId, {
      ...newer,
      polygons: [...earlier.polygons, ...row.polygons],
    });
  }
  return [...rows.values()];
}
