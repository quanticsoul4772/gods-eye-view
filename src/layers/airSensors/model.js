/**
 * @module layers/airSensors/model
 *
 * Sensor.Community particulate readings, banded on the European Environment
 * Agency's air quality index. Pure — no Cesium, no network, no catalogs.
 *
 * The bands are the EAQI's revised 1-hour bands for PM2.5 and PM10 (ETC HE
 * Report 2024/17, Table 5.2), and a reading's band is the worse of the two,
 * as in the index. The real index also takes NO₂, O₃ and SO₂, which these
 * sensors don't measure, so the layer says "EEA index bands, PM only".
 * The EEA publishes integer limits ("0-5", "6-15"); a value is rounded to
 * the nearest integer before comparing, so 5.49 is Good and 5.5 is Fair.
 *
 * Not comparable with Canada's AQHI (layers/airQuality): different index,
 * different instruments.
 */
// A portable export (package.json): no i18n here; the layer's cards name
// the bands (cards.js).
/** The six EAQI bands, best to worst, with the EEA's colours. */
export const AIR_SENSOR_BANDS = Object.freeze(
  [
    { id: 'good', color: '#50f0e6', pm25: 5, pm10: 15 },
    { id: 'fair', color: '#50ccaa', pm25: 15, pm10: 45 },
    { id: 'moderate', color: '#f0e641', pm25: 50, pm10: 120 },
    { id: 'poor', color: '#ff5050', pm25: 90, pm10: 195 },
    { id: 'very-poor', color: '#960032', pm25: 140, pm10: 270 },
    { id: 'extremely-poor', color: '#7d2181', pm25: Infinity, pm10: Infinity },
  ].map((band) => Object.freeze(band)),
);

/** Colour for a reading with no usable value. */
export const AIR_SENSOR_UNKNOWN_COLOR = '#6b7785';

export const AIR_SENSORS_OVERLAY_SOURCE_ID = 'air-sensors';
export const AIR_SENSORS_CARD_SOURCE_ID = 'air-sensors-card';
/** Labels over the map: the worst confirmed readings in view. */
export const AIR_SENSORS_LABEL_LIMIT = 24;
export const AIR_SENSORS_LABEL_COLLISION_CAPACITY = 24;

/** Above this camera height the sensors are drawn as grid cells. */
export const CELL_VIEW_HEIGHT_M = 800_000;
/** Cell size in degrees. */
export const CELL_DEG = 0.25;

/** A layer whose newest reading is older than this is stale. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
/** Relative humidity above which a low-cost optical sensor can read high. */
export const HUMID_RH = 75;

/** `flags` bit: implausibly high or far above its neighbours, so never ranked. */
export const FLAG_UNCONFIRMED = 1;
/** `flags` bit: high, with too few sensors nearby to compare (still ranked). */
export const FLAG_ISOLATED = 2;

/**
 * Band index (0 = good … 5 = extremely poor) for one reading: the worse of
 * its PM2.5 and PM10 sub-indices, or -1 with neither.
 * @param {?number} pm25
 * @param {?number} pm10
 */
export function bandIndexOf(pm25, pm10) {
  const sub = (value, key) =>
    Number.isFinite(value)
      ? AIR_SENSOR_BANDS.findIndex((band) => Math.round(value) <= band[key])
      : -1;
  return Math.max(sub(pm25, 'pm25'), sub(pm10, 'pm10'));
}

/** The band for an index, or null. */
export const bandAt = (index) => AIR_SENSOR_BANDS[index] || null;

/** Colour for a band index. */
export const bandColor = (index) =>
  AIR_SENSOR_BANDS[index]?.color || AIR_SENSOR_UNKNOWN_COLOR;

/**
 * Expand the proxy's compact rows into readings. Rows are
 * `[sensorId, lat, lon, pm25|null, pm10|null, observedMs, typeIndex, flags,
 * country|null, rh|null, sourceIndex]`.
 * @param {{rows: Array<Array>, types: string[], sources: Array<object>}} payload
 * @returns {Array<object>}
 */
export function expandReadings(payload) {
  const types = Array.isArray(payload?.types) ? payload.types : [];
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  const readings = [];
  for (const row of Array.isArray(payload?.rows) ? payload.rows : []) {
    if (!Array.isArray(row)) continue;
    const [
      id,
      lat,
      lon,
      pm25,
      pm10,
      observedMs,
      type,
      flags,
      country,
      rh,
      src,
    ] = row;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const band = bandIndexOf(pm25, pm10);
    if (band < 0) continue;
    readings.push({
      id: `sc:${id}`,
      sensorId: id,
      lat,
      lon,
      pm25: Number.isFinite(pm25) ? pm25 : null,
      pm10: Number.isFinite(pm10) ? pm10 : null,
      observedMs: Number.isFinite(observedMs) ? observedMs : null,
      sensorType: typeof types[type] === 'string' ? types[type] : null,
      unconfirmed: (flags & FLAG_UNCONFIRMED) !== 0,
      isolated: (flags & FLAG_ISOLATED) !== 0,
      country: typeof country === 'string' ? country : null,
      rh: Number.isFinite(rh) ? rh : null,
      source: sources[src]?.id ?? null,
      band,
    });
  }
  return readings;
}

/** Worst first: band, then PM2.5, then PM10, then id. */
export const bySeverity = (a, b) =>
  b.band - a.band ||
  (b.pm25 ?? -1) - (a.pm25 ?? -1) ||
  (b.pm10 ?? -1) - (a.pm10 ?? -1) ||
  String(a.id).localeCompare(String(b.id));

/** Whether a reading lies in a lon/lat rectangle (null = everywhere). */
export function inRectangle(reading, rect) {
  if (!rect) return true;
  if (reading.lat < rect.south || reading.lat > rect.north) return false;
  return rect.west <= rect.east
    ? reading.lon >= rect.west && reading.lon <= rect.east
    : reading.lon >= rect.west || reading.lon <= rect.east;
}

/**
 * The worst confirmed readings in a rectangle. Unconfirmed readings (far
 * above their neighbours, likely a faulty sensor) never lead a ranking.
 */
export function worstInView(readings, rect, limit) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (!cap || !Array.isArray(readings)) return [];
  return readings
    .filter((reading) => !reading.unconfirmed && inRectangle(reading, rect))
    .sort(bySeverity)
    .slice(0, cap);
}

/**
 * Group readings into CELL_DEG cells: each cell's position is the mean of
 * its sensors and its band the worse of the median PM2.5 and median PM10
 * of its confirmed readings, so one faulty sensor can't colour a cell.
 * @returns {Array<{key: string, lat: number, lon: number, count: number, band: number, pm25: ?number, pm10: ?number}>}
 */
export function aggregateCells(readings) {
  const cells = new Map();
  for (const reading of readings) {
    const key = `${Math.floor((reading.lat + 90) / CELL_DEG)}:${Math.floor((reading.lon + 180) / CELL_DEG)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { key, lat: 0, lon: 0, members: [] }));
    cell.lat += reading.lat;
    cell.lon += reading.lon;
    cell.members.push(reading);
  }
  const median = (values) => {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const out = [];
  for (const cell of cells.values()) {
    const confirmed = cell.members.filter((reading) => !reading.unconfirmed);
    const pool = confirmed.length ? confirmed : cell.members;
    const pm25 = median(pool.map((r) => r.pm25).filter(Number.isFinite));
    const pm10 = median(pool.map((r) => r.pm10).filter(Number.isFinite));
    out.push({
      key: cell.key,
      lat: cell.lat / cell.members.length,
      lon: cell.lon / cell.members.length,
      count: cell.members.length,
      pm25,
      pm10,
      band: bandIndexOf(pm25, pm10),
    });
  }
  return out;
}

/** The newest observation time, or null. */
export function newestObservation(readings) {
  let newest = null;
  for (const reading of readings || [])
    if (
      Number.isFinite(reading.observedMs) &&
      (newest === null || reading.observedMs > newest)
    )
      newest = reading.observedMs;
  return newest;
}

/** Stale when the newest reading is older than STALE_AFTER_MS (or none). */
export function readingsAreStale(readings, now = Date.now()) {
  const newest = newestObservation(readings);
  return newest === null || now - newest > STALE_AFTER_MS;
}

/** The caveat every reading carries into analyst records. */
// Assistant data, English like the other analyst fields.
export const READING_QUALITY =
  'Indicative: volunteer low-cost sensor, uncalibrated; reads high in fog or humid air; EEA index bands from PM only';

/** One reading as a JSON-safe analyst record. */
export function mapAnalystRecord(reading) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id: reading.id,
    pm25: num(reading.pm25),
    pm10: num(reading.pm10),
    band: bandAt(reading.band)?.id ?? null,
    sensorType: reading.sensorType,
    country: reading.country,
    humidity: num(reading.rh),
    // Far above its neighbours: possibly a faulty sensor.
    suspect: reading.unconfirmed === true,
    quality: READING_QUALITY,
    lat: num(reading.lat),
    lon: num(reading.lon),
    observedMs: num(reading.observedMs),
  };
}
