import * as Cesium from 'cesium';

/**
 * Pure readout math for the intel HUD (src/hud.js). Every number the HUD
 * prints is either computed here from the live camera, the scene and the
 * clock, or is fixed theme text that does not pretend to measure anything.
 */

/**
 * Metres of ground per pixel, per metre of distance to the ground: the HUD's
 * notional sensor resolves 0.375 mm per metre of range (GSD 0.23 m at 627 m).
 */
export const GSD_PER_METRE_RANGE = 0.000375;

/**
 * Ground sample distance at the view centre, from the slant range to it.
 * Looking 60° off straight down doubles the range and so the GSD; reading it
 * from the altitude alone made oblique views look twice as sharp as they are.
 * @param {number} rangeM Camera-to-ground distance along the view axis.
 * @returns {number} Metres per pixel, at least 0.01.
 */
export function gsdFromRangeM(rangeM) {
  return Math.max(
    0.01,
    (Number.isFinite(rangeM) ? rangeM : 0) * GSD_PER_METRE_RANGE,
  );
}

/**
 * Slant range when the view centre hits nothing (sky): the altitude stretched
 * by the off-nadir angle, capped so a near-horizon view stays finite.
 * @param {number} altM Camera height above the ground datum.
 * @param {number} onaDeg Off-nadir angle (0 = straight down).
 * @returns {number}
 */
export function slantRangeFromAltitudeM(altM, onaDeg) {
  const cos = Math.cos(Cesium.Math.toRadians(Math.min(onaDeg, 85)));
  return Math.max(0, altM) / Math.max(cos, Math.cos(Cesium.Math.toRadians(85)));
}

/**
 * NIIRS from GSD by the simplified General Image Quality Equation, clamped to
 * the 0–9 scale.
 * @param {number} gsdM
 * @returns {number}
 */
export function niirsFromGsd(gsdM) {
  return Math.max(0, Math.min(9, 10.25 - 3.32 * Math.log10(gsdM * 39.37)));
}

/** Off-nadir angle from camera pitch: -90° pitch (straight down) is 0°. */
export function offNadirDeg(pitchRad) {
  return Math.max(0, 90 + Cesium.Math.toDegrees(pitchRad));
}

const scratchSunInertial = new Cesium.Cartesian3();
const scratchSunFixed = new Cesium.Cartesian3();
const scratchMatrix = new Cesium.Matrix3();
const scratchToSun = new Cesium.Cartesian3();
const scratchUp = new Cesium.Cartesian3();

/**
 * Sun elevation above the local horizon at a point on Earth, from Cesium's
 * planetary model (the same one the celestial ring draws the sun with), not a
 * day-of-year approximation that drifted several degrees. The inertial-to-
 * fixed rotation is the pseudo-fixed one (Earth rotation only): it needs no
 * IAU data download, and it was within 0.4° of the full ICRF transform at
 * Austin, Tokyo, London and Sydney (2026-10-13).
 * @param {Cesium.Cartesian3} position Earth-fixed point.
 * @param {Cesium.JulianDate} [time] Defaults to now.
 * @returns {number|null} Degrees; null without a position.
 */
export function sunElevationDeg(position, time = Cesium.JulianDate.now()) {
  if (!position) return null;
  Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    time,
    scratchSunInertial,
  );
  const matrix = Cesium.Transforms.computeTemeToPseudoFixedMatrix(
    time,
    scratchMatrix,
  );
  Cesium.Matrix3.multiplyByVector(matrix, scratchSunInertial, scratchSunFixed);
  Cesium.Cartesian3.subtract(scratchSunFixed, position, scratchToSun);
  Cesium.Cartesian3.normalize(scratchToSun, scratchToSun);
  Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(position, scratchUp);
  const sin = Cesium.Cartesian3.dot(scratchToSun, scratchUp);
  return Cesium.Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, sin))));
}

/** The imaging band a render style simulates. */
export function bandForStyle(style) {
  if (style === 'thermal') return 'IR';
  if (style === 'surveillance') return 'NV';
  return 'PAN';
}

/** Compass heading, 0–359°, from a camera heading in radians. */
export function headingDeg(headingRad) {
  const deg = Math.round(Cesium.Math.toDegrees(headingRad)) % 360;
  return deg < 0 ? deg + 360 : deg;
}

/** "850m" / "12.4km": a range compact enough for the HUD corner. */
export function formatRange(rangeM) {
  if (!Number.isFinite(rangeM)) return '--';
  return rangeM < 1000
    ? `${Math.round(rangeM)}m`
    : `${(rangeM / 1000).toFixed(rangeM < 100_000 ? 1 : 0)}km`;
}

const HUD_IDS_KEY = 'gev:hud-ids:v1';

/**
 * The theme's mission and sensor designators. They are flavour, not data, so
 * they are drawn once and kept: a number that changed on every reload read as
 * a live value.
 * @param {{getItem: Function, setItem: Function}|null} storage
 * @param {() => number} [random]
 * @returns {{missionId: string, sensorId: string}}
 */
export function stableHudIds(storage, random = Math.random) {
  try {
    const saved = JSON.parse(storage?.getItem(HUD_IDS_KEY) ?? 'null');
    if (
      /^KH11-\d{4}$/.test(saved?.missionId) &&
      /^OPS-\d{4}$/.test(saved?.sensorId)
    )
      return saved;
  } catch {
    /* fall through to a fresh pair */
  }
  const ids = {
    missionId: `KH11-${4000 + Math.floor(random() * 200)}`,
    sensorId: `OPS-${4100 + Math.floor(random() * 100)}`,
  };
  try {
    storage?.setItem(HUD_IDS_KEY, JSON.stringify(ids));
  } catch {
    /* private mode: the pair lasts this session */
  }
  return ids;
}

/**
 * The AIS line when no vessel is selected: say how to get one rather than
 * show "--" beside ships on screen.
 * @param {{enabled: boolean, count: number}} vessels
 * @returns {string}
 */
export function aisIdleText({ enabled, count }) {
  if (!enabled) return 'AIS: --';
  if (!count) return 'AIS: no vessels in feed';
  return `AIS: ${count} vessels · click one`;
}
