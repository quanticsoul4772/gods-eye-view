/**
 * Free-floating shared vehicles (GBFS `vehicle_status` / `free_bike_status`)
 * reduced to what the map may show: position, form factor, propulsion and
 * when the vehicle last reported. Pure: no I/O.
 *
 * Privacy: GBFS rotates vehicle ids so riders can't be followed, and its
 * rental links carry permanent vehicle numbers. The output is built field by
 * field, so ids, rental links, pricing and anything else never pass;
 * positions are trimmed to about 11 m and times to the minute.
 */
import { normalizeGbfsBool } from '../sources/gbfsStations.js';
import { lonInBox } from './geoCircle.js';

/** GBFS form factors (v3); anything else is `other`. */
export const FORM_FACTORS = Object.freeze([
  'bicycle',
  'cargo_bicycle',
  'car',
  'moped',
  'scooter_standing',
  'scooter_seated',
  'other',
]);
const FORM_FACTOR_SET = new Set(FORM_FACTORS);
/** GBFS propulsion types; anything else is dropped. */
const PROPULSION = new Set([
  'human',
  'electric_assist',
  'electric',
  'combustion',
  'combustion_diesel',
  'hybrid',
  'plug_in_hybrid',
  'hydrogen_fuel_cell',
]);
export const MAX_VEHICLES_PER_SYSTEM = 5000;
const COORD_DECIMALS = 4;

/** A GBFS form factor in v3 terms (v2 `scooter` → `scooter_standing`). */
export function normalizeFormFactor(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (text === 'scooter') return 'scooter_standing';
  return FORM_FACTOR_SET.has(text) ? text : 'other';
}

/** An entry's own form factors, allow-listed (empty means unknown). */
export function normalizeFormFactors(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map(normalizeFormFactor)
        .filter(Boolean),
    ),
  ].sort();
}

/** A GBFS time as epoch ms: POSIX seconds (≤ v2.3) or RFC 3339 (v3); ≤ 0 or unreadable → null. */
export function parseGbfsTime(value) {
  if (typeof value === 'number') return value > 0 ? value * 1000 : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return parseGbfsTime(Number(value));
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const round = (value, decimals) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};
const toMinute = (ms) => (ms == null ? null : Math.floor(ms / 60_000) * 60_000);

/**
 * `vehicle_types` → Map(vehicle_type_id → {formFactor, propulsion}).
 * @param {object} payload
 */
export function parseVehicleTypes(payload) {
  const types = new Map();
  const list = payload?.data?.vehicle_types;
  if (!Array.isArray(list)) return types;
  for (const type of list) {
    const id = type?.vehicle_type_id;
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    const propulsion = String(type.propulsion_type ?? '').toLowerCase();
    types.set(String(id), {
      formFactor: normalizeFormFactor(type.form_factor),
      propulsion: PROPULSION.has(propulsion) ? propulsion : null,
    });
  }
  return types;
}

/**
 * A vehicle feed reduced to free-floating, available vehicles.
 * @param {object} payload `vehicle_status` (v3) or `free_bike_status` (v1/v2)
 * @param {{types?: Map<string, {formFactor: string|null, propulsion: string|null}>,
 *   formFactors?: string[], bbox?: number[]}} [entry] the system's vehicle
 *   types, its own form factors, and its coverage `[south, west, north, east]`
 * @returns {{lastUpdated: number|null, vehicles: {lat: number, lon: number,
 *   formFactor: string, propulsion: string|null, reportedAt: number|null}[]}}
 */
export function parseVehicleFeed(
  payload,
  { types = new Map(), formFactors = [], bbox = null } = {},
) {
  const data = payload?.data;
  const list = Array.isArray(data?.vehicles)
    ? data.vehicles
    : Array.isArray(data?.bikes)
      ? data.bikes
      : [];
  const lastUpdated = toMinute(parseGbfsTime(payload?.last_updated));
  const fallbackForm =
    formFactors.length === 1 ? normalizeFormFactor(formFactors[0]) : null;
  const box =
    Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
      ? bbox
      : null;
  const vehicles = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    // Docked vehicles belong to the station feed; some feeds send "" on free ones.
    if (typeof v.station_id === 'string' && v.station_id.trim()) continue;
    if (typeof v.station_id === 'number') continue;
    if (normalizeGbfsBool(v.is_disabled, false)) continue;
    if (normalizeGbfsBool(v.is_reserved, false)) continue;
    const lat = Number(v.lat);
    const lon = Number(v.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (lat === 0 && lon === 0) continue;
    if (
      box &&
      !(lat >= box[0] && lat <= box[2] && lonInBox(lon, box[1], box[3]))
    )
      continue;
    const type =
      v.vehicle_type_id != null ? types.get(String(v.vehicle_type_id)) : null;
    vehicles.push({
      lat: round(lat, COORD_DECIMALS),
      lon: round(lon, COORD_DECIMALS),
      formFactor: type?.formFactor || fallbackForm || 'unknown',
      propulsion: type?.propulsion ?? null,
      reportedAt: toMinute(parseGbfsTime(v.last_reported)) ?? lastUpdated,
    });
  }
  // Position order, never the feed's: a feed sorted by vehicle id would
  // otherwise let the k-th vehicle of one poll be matched to the next poll's.
  vehicles.sort(
    (a, b) =>
      a.lat - b.lat ||
      a.lon - b.lon ||
      (a.formFactor < b.formFactor ? -1 : a.formFactor > b.formFactor ? 1 : 0),
  );
  return { lastUpdated, vehicles: vehicles.slice(0, MAX_VEHICLES_PER_SYSTEM) };
}

/** Seconds a feed may be cached: its `ttl` and the entry's minimum, within 60–300. */
export function vehicleFeedTtlS(payload, minIntervalS = 60) {
  const ttl = Number(payload?.ttl);
  const min = Number(minIntervalS);
  return Math.min(
    300,
    Math.max(
      60,
      Number.isFinite(ttl) ? ttl : 0,
      Number.isFinite(min) ? min : 0,
    ),
  );
}
