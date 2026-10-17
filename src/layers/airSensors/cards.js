/** Card and label text for the air-sensors layer. Pure — no Cesium types. */
import { formatNumber, t, tn } from '../../i18n/index.js';
import { AIR_SENSOR_BANDS, HUMID_RH, bandAt, bandColor } from './model.js';

/** An EAQI band name in the UI language. */
export function eaqiBandLabel(index) {
  switch (bandAt(index)?.id) {
    case 'good':
      return t('Good', { context: 'eaqi' });
    case 'fair':
      return t('Fair', { context: 'eaqi' });
    case 'moderate':
      return t('Moderate', { context: 'eaqi' });
    case 'poor':
      return t('Poor', { context: 'eaqi' });
    case 'very-poor':
      return t('Very poor', { context: 'eaqi' });
    case 'extremely-poor':
      return t('Extremely poor', { context: 'eaqi' });
    default:
      return t('No reading');
  }
}

/** The legend: six bands with their PM2.5 limits. */
export function legendEntries() {
  return AIR_SENSOR_BANDS.map((band, index) => ({
    color: band.color,
    label: Number.isFinite(band.pm25)
      ? t('{band} · PM2.5 ≤{limit}', {
          band: eaqiBandLabel(index),
          limit: formatNumber(band.pm25),
        })
      : t('{band} · PM2.5 >{limit}', {
          band: eaqiBandLabel(index),
          limit: formatNumber(AIR_SENSOR_BANDS[index - 1].pm25),
        }),
  }));
}

const value = (number) =>
  formatNumber(number < 10 ? Math.round(number * 10) / 10 : Math.round(number));

/** "PM2.5 23 µg/m³", or null without a value. */
export function pm25Text(pm25) {
  return Number.isFinite(pm25)
    ? t('PM2.5 {value} µg/m³', { value: value(pm25) })
    : null;
}

/** "PM10 31 µg/m³", or "PM10 n/a". */
function pm10Text(pm10) {
  return Number.isFinite(pm10)
    ? t('PM10 {value} µg/m³', { value: value(pm10) })
    : t('PM10 n/a');
}

/** Compact age, "5m" / "3h", in the UI language. */
function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1)
    return t('{count}m', {
      context: 'age',
      count: Math.max(1, Math.floor(deltaMs / 60000)),
    });
  return t('{count}h', { context: 'age', count: hours });
}

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * The selected sensor's card, without `position`.
 * @param {object} reading - From expandReadings.
 * @param {number} nowMs
 * @param {{interactive?: boolean}} [options] - Interactive cards open the
 *   sensor's history on maps.sensor.community.
 */
export function buildSensorCard(reading, nowMs, { interactive = false } = {}) {
  const pm25 = pm25Text(reading.pm25);
  const details = [
    [pm25 ? t('{pm25} (1-h mean)', { pm25 }) : null, pm10Text(reading.pm10)]
      .filter(Boolean)
      .join(' · '),
  ];
  const sensor = [
    t('Sensor #{id}', { id: reading.sensorId }),
    reading.country,
    reading.sensorType,
  ].filter(Boolean);
  const age = formatAge(nowMs - reading.observedMs);
  if (reading.observedMs != null && age)
    sensor.push(t('measured {age} ago', { age }));
  details.push(sensor.join(' · '));
  if (Number.isFinite(reading.rh) && reading.rh > HUMID_RH)
    details.push(
      t('Humidity {rh}% · may read high', { rh: Math.round(reading.rh) }),
    );
  if (reading.unconfirmed)
    details.push(
      t('Implausibly high or far above nearby sensors · possibly faulty'),
    );
  else if (reading.isolated)
    details.push(t('No nearby sensors to compare · unverified'));
  details.push(
    t(
      'Volunteer low-cost sensor, not an official monitor · EEA index bands, PM only',
    ),
  );
  if (interactive)
    details.push(t('Sensor.Community map ↗ · click card to open'));
  const title = t('AIR · {band}', { band: eaqiBandLabel(reading.band) });
  return {
    ...CARD_BASE,
    id: `air-sensors-card:${reading.id}`,
    interactive,
    ...(interactive
      ? {
          accessibilityLabel: t('Open {title} on {site}', {
            title,
            site: 'Sensor.Community',
          }),
        }
      : undefined),
    title,
    details,
    accent: bandColor(reading.band),
  };
}

/** The card for a selected grid cell (continental zoom), without `position`. */
export function buildCellCard(cell) {
  const median = [
    Number.isFinite(cell.pm25) ? pm25Text(cell.pm25) : null,
    Number.isFinite(cell.pm10)
      ? t('PM10 {value} µg/m³', { value: value(cell.pm10) })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    ...CARD_BASE,
    id: `air-sensors-card:cell:${cell.key}`,
    interactive: false,
    title: t('AIR · {band}', { band: eaqiBandLabel(cell.band) }),
    details: [
      tn(cell.count, 'Median of {count} sensor', 'Median of {count} sensors', {
        count: formatNumber(cell.count),
      }),
      median,
      t('Zoom in for single sensors · EEA index bands, PM only'),
    ].filter(Boolean),
    accent: bandColor(cell.band),
  };
}

/** The sensor's page on the Sensor.Community map. */
export function sensorMapUrl(reading) {
  const zoom = 14;
  return `https://maps.sensor.community/#${zoom}/${reading.lat.toFixed(4)}/${reading.lon.toFixed(4)}`;
}
