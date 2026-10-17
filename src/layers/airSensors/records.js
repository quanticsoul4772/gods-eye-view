/**
 * @module layers/airSensors/records
 *
 * Sensor.Community `data.1h.json` → compact rows for the air-sensors proxy.
 * Pure — no network, no catalogs; the server imports it.
 *
 * Each record is one sensor's mean over the last hour. PM sensors report P1
 * (PM10) and P2 (PM2.5) in µg/m³; temperature/humidity sensors share the
 * file, and one at the same `location.id` gives a PM sensor its humidity.
 *
 * Dropped: indoor sensors (anything but `indoor === 0`), bad coordinates,
 * negative values, values at or above 999 (the SDS011's ceiling, a stuck
 * sensor), PM2.5 well above PM10 (PM2.5 is part of PM10, so a fault),
 * all-zero rows (a dead sensor), and readings older than 3 h.
 *
 * Kept but flagged unconfirmed (drawn, never ranked): a PM value over
 * 500 µg/m³ that its neighbours don't back up (an hourly mean that high is
 * almost always a sensor fogged or failing; wildfire smoke raises the
 * sensors around it too), and a PM2.5 over 50 µg/m³ that is over 3× the
 * median of at least 3 sensors within 10 km. Over 500 counts as backed up
 * when at least 3 sensors within 10 km report the same measure with a median
 * of at least a third of it. A PM2.5 over 50 (and not over 500) with fewer
 * than 3 sensors within 10 km can't be compared: flagged isolated, still
 * ranked, and its card says it is unverified.
 */
import { FLAG_ISOLATED, FLAG_UNCONFIRMED, HUMID_RH } from './model.js';

const MAX_AGE_MS = 3 * 60 * 60 * 1000;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const NEIGHBOUR_KM = 10;
const GRID_DEG = 0.1;

const valueOf = (values, type) => {
  const raw = values.find((value) => value?.value_type === type)?.value;
  if (raw === null || raw === undefined || raw === '') return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
};

/** "YYYY-MM-DD HH:MM:SS" in UTC (no zone in the feed), or null. */
export function sensorTimestampMs(text) {
  if (!TIMESTAMP.test(String(text))) return null;
  const ms = Date.parse(`${text.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

const round = (value, places) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/**
 * Normalize one data.1h.json payload.
 * @param {unknown} payload
 * @param {{now?: number, sourceIndex?: number}} [options]
 * @returns {?{rows: Array<Array>, types: string[], dropped: Record<string, number>}}
 *   null when the payload is not a Sensor.Community array.
 */
export function normalizeSensorCommunity(
  payload,
  { now = Date.now(), sourceIndex = 0 } = {},
) {
  if (!Array.isArray(payload)) return null;
  const dropped = {
    indoor: 0,
    position: 0,
    range: 0,
    inverted: 0,
    zero: 0,
    old: 0,
  };
  const humidity = new Map();
  for (const record of payload) {
    const values = Array.isArray(record?.sensordatavalues)
      ? record.sensordatavalues
      : [];
    const rh = valueOf(values, 'humidity');
    if (rh !== null && rh >= 0 && rh <= 100 && record.location?.id != null)
      humidity.set(record.location.id, rh);
  }
  const readings = [];
  const types = [];
  const typeIndex = new Map();
  for (const record of payload) {
    const values = Array.isArray(record?.sensordatavalues)
      ? record.sensordatavalues
      : [];
    const pm10 = valueOf(values, 'P1');
    const pm25 = valueOf(values, 'P2');
    if (pm10 === null && pm25 === null) continue;
    if (Number(record.location?.indoor) !== 0) {
      dropped.indoor++;
      continue;
    }
    const lat = Number(record.location.latitude);
    const lon = Number(record.location.longitude);
    if (
      record.location.latitude === '' ||
      record.location.longitude === '' ||
      !(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
    ) {
      dropped.position++;
      continue;
    }
    if (
      (pm10 !== null && (pm10 < 0 || pm10 >= 999)) ||
      (pm25 !== null && (pm25 < 0 || pm25 >= 999))
    ) {
      dropped.range++;
      continue;
    }
    if (pm10 !== null && pm25 !== null && pm25 > 1.1 * pm10 + 2) {
      dropped.inverted++;
      continue;
    }
    if (!pm10 && !pm25) {
      dropped.zero++;
      continue;
    }
    const observedMs = sensorTimestampMs(record.timestamp);
    if (observedMs === null || now - observedMs > MAX_AGE_MS) {
      dropped.old++;
      continue;
    }
    const type = String(record.sensor?.sensor_type?.name || '').slice(0, 32);
    if (!typeIndex.has(type)) {
      typeIndex.set(type, types.length);
      types.push(type);
    }
    const id = Number(record.sensor?.id);
    readings.push({
      id: Number.isSafeInteger(id) ? id : String(record.sensor?.id ?? ''),
      lat: round(lat, 5),
      lon: round(lon, 5),
      pm25: pm25 === null ? null : round(pm25, 1),
      pm10: pm10 === null ? null : round(pm10, 1),
      observedMs,
      type: typeIndex.get(type),
      country: /^[A-Z]{2}$/.test(record.location.country)
        ? record.location.country
        : null,
      rh: humidity.has(record.location.id)
        ? round(humidity.get(record.location.id), 0)
        : null,
      flags: 0,
    });
  }
  flagUnconfirmed(readings);
  return {
    rows: readings.map((r) => [
      r.id,
      r.lat,
      r.lon,
      r.pm25,
      r.pm10,
      r.observedMs,
      r.type,
      r.flags,
      r.country,
      r.rh,
      sourceIndex,
    ]),
    types,
    dropped,
  };
}

/** Mark readings far above their neighbours' median PM2.5 as unconfirmed. */
function flagUnconfirmed(readings) {
  const lonCells = Math.round(360 / GRID_DEG);
  const wrapLon = (index) => ((index % lonCells) + lonCells) % lonCells;
  const grid = new Map();
  const cellOf = (latIndex, lonIndex) => `${latIndex}:${wrapLon(lonIndex)}`;
  for (const reading of readings) {
    const key = cellOf(
      Math.floor(reading.lat / GRID_DEG),
      Math.floor(reading.lon / GRID_DEG),
    );
    const list = grid.get(key);
    if (list) list.push(reading);
    else grid.set(key, [reading]);
  }
  /**
   * Median of one measure over the sensors within 10 km, and how many.
   * Away from the equator 0.1° of longitude is under 10 km, so the search
   * reaches as many longitude cells as 10 km spans there. `skip` leaves out
   * neighbours that can't vouch for a reading.
   */
  const neighbours = (reading, measure, skip) => {
    const latIndex = Math.floor(reading.lat / GRID_DEG);
    const lonIndex = Math.floor(reading.lon / GRID_DEG);
    const cosLat = Math.cos((reading.lat * Math.PI) / 180);
    const lonReach = Math.min(
      Math.ceil(NEIGHBOUR_KM / (111.2 * Math.max(cosLat, 0.01) * GRID_DEG)),
      lonCells / 2,
    );
    const near = [];
    for (let a = -1; a <= 1; a++)
      for (let b = -lonReach; b <= lonReach; b++)
        for (const other of grid.get(cellOf(latIndex + a, lonIndex + b)) ||
          []) {
          if (other === reading || other[measure] === null || skip(other))
            continue;
          let dLon = other.lon - reading.lon;
          if (dLon > 180) dLon -= 360;
          if (dLon < -180) dLon += 360;
          const dy = (other.lat - reading.lat) * 111.2;
          const dx = dLon * 111.2 * cosLat;
          if (Math.hypot(dx, dy) <= NEIGHBOUR_KM) near.push(other[measure]);
        }
    if (!near.length) return { count: 0, median: null };
    near.sort((x, y) => x - y);
    const mid = near.length >> 1;
    return {
      count: near.length,
      median: near.length % 2 ? near[mid] : (near[mid - 1] + near[mid]) / 2,
    };
  };
  const extreme = (other) => other.pm25 > 500 || other.pm10 > 500;
  for (const reading of readings) {
    // Every measure over 500 needs its own corroboration from sensors that
    // aren't extreme themselves: smoke raises the sensors around it; a fogged
    // or failing sensor is alone. Fog inflates every optical sensor nearby
    // too, so a humid reading is never taken as corroborated smoke.
    for (const measure of ['pm25', 'pm10']) {
      if (!(reading[measure] > 500)) continue;
      const { count, median } = neighbours(reading, measure, extreme);
      if (
        count < 3 ||
        median * 3 < reading[measure] ||
        (Number.isFinite(reading.rh) && reading.rh > HUMID_RH)
      )
        reading.flags |= FLAG_UNCONFIRMED;
    }
  }
  // Then each high PM2.5 against its neighbours, leaving out the ones
  // already judged possibly faulty.
  const faulty = (other) => (other.flags & FLAG_UNCONFIRMED) !== 0;
  for (const reading of readings) {
    if (faulty(reading) || !(reading.pm25 > 50)) continue;
    const { count, median } = neighbours(reading, 'pm25', faulty);
    if (count < 3) reading.flags |= FLAG_ISOLATED;
    else if (reading.pm25 > 3 * median) reading.flags |= FLAG_UNCONFIRMED;
  }
}
