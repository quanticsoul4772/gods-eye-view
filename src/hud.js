import { applicationServices } from './services/application.js';
/**
 * @module hud
 * @description Intelligence HUD Overlay — NRO/NGA Satellite Aesthetic.
 *
 * Renders authentic reconnaissance metadata over the Cesium canvas:
 * classification banners, live MGRS/lat-lon coordinates, sensor metrics
 * (GSD, NIIRS, ONA), timestamps, and orbital data — all updating in
 * real-time at configurable cadences.
 *
 * The HUD auto-activates when a military-style shader (NVG, FLIR, CRT) is
 * selected and supports three layout variants: tactical, operator, minimal.
 *
 * Color theming is driven by the active shader mode via CSS custom properties.
 */

import * as Cesium from 'cesium';
import { forward as toMGRS } from 'mgrs';
import { CITY_POIS } from './cityPois.js';
import { composeLocalityTag } from './hudLocality.js';
import { hudQuantity, LOCALIZED_LOCALITY } from './hudLocalityFormat.js';
import {
  aisIdleText,
  bandForStyle,
  formatRange,
  gsdFromRangeM,
  headingDeg,
  niirsFromGsd,
  offNadirDeg,
  slantRangeFromAltitudeM,
  sunElevationDeg,
} from './hudReadouts.js';
import {
  ellipsoidalToMslDisplayM,
  ensureGeoidReady,
  geoidHeight,
} from './data/geoid.js';
import { getBasemapLabelContext } from './voice/gevActions.js';
import {
  hudSummaryMatchesProvenance,
  hudSummaryLayerContext,
  hudTelemetryProvenance,
  isHudSummaryUnconfigured,
} from './hudSummaryResponse.js';
import {
  applyHudUiTheme,
  DEFAULT_HUD_LAYOUT,
  normalizeHudLayout,
} from './hudLayouts.js';
import { formatNumber, msg, t } from './i18n/index.js';
import { localizeLayerName } from './ui/layerPanel.js';

/** Color palettes keyed by shader mode; applied as CSS custom properties. */
const HUD_COLORS = {
  surveillance: {
    main: 'rgba(51, 255, 51, 0.8)',
    glow: 'rgba(51, 255, 51, 0.5)',
    border: 'rgba(51, 255, 51, 0.2)',
  },
  thermal: {
    main: 'rgba(255, 255, 255, 0.7)',
    glow: 'rgba(255, 255, 255, 0.4)',
    border: 'rgba(255, 255, 255, 0.15)',
  },
  retro: {
    main: 'rgba(255, 170, 0, 0.8)',
    glow: 'rgba(255, 170, 0, 0.5)',
    border: 'rgba(255, 170, 0, 0.2)',
  },
  _default: {
    main: 'rgba(0, 255, 255, 0.6)',
    glow: 'rgba(0, 255, 255, 0.4)',
    border: 'rgba(0, 255, 255, 0.15)',
  },
};

/**
 * Mode names per style: the same English as STYLE_STATUS_LABELS
 * (ui/visualPresets.js), so both translate alike.
 */
const MODE_LABELS = Object.freeze({
  normal: msg('NORMAL'),
  retro: msg('CRT'),
  surveillance: msg('NVG'),
  thermal: msg('FLIR'),
  anime: msg('ANIME'),
  noir: msg('NOIR'),
  snow: msg('SNOW'),
});

/** Region ids from _regionLabel() and the name shown for each. */
const REGION_LABELS = Object.freeze({
  ARCTIC: msg('ARCTIC'),
  ANTARCTIC: msg('ANTARCTIC'),
  'NORTH AMERICA': msg('NORTH AMERICA'),
  'SOUTH AMERICA': msg('SOUTH AMERICA'),
  EUROPE: msg('EUROPE'),
  AFRICA: msg('AFRICA'),
  ASIA: msg('ASIA'),
  OCEANIA: msg('OCEANIA'),
  'NORTHERN OCEANIC GRID': msg('NORTHERN OCEANIC GRID'),
  'SOUTHERN OCEANIC GRID': msg('SOUTHERN OCEANIC GRID'),
});

/** Feed-state ids from hudTelemetryProvenance() and the word shown for each. */
const FEED_STATE_LABELS = Object.freeze({
  loading: msg('LOADING'),
  degraded: msg('DEGRADED'),
  stale: msg('STALE'),
  partial: msg('PARTIAL'),
  fallback: msg('FALLBACK'),
  unavailable: msg('UNAVAILABLE'),
});

/**
 * The summary's feed-state suffix in the active language, e.g.
 * `UNAVAILABLE: LIVE AIS VESSELS`. State ids and layer names stay English in
 * layer data; only this line translates them.
 */
function localizedProvenanceTag(provenance) {
  if (!provenance) return null;
  const state = FEED_STATE_LABELS[provenance.state]
    ? t(FEED_STATE_LABELS[provenance.state])
    : provenance.state.toUpperCase();
  if (!provenance.names.length) return state;
  return t('{state} {layers}', {
    state,
    layers: provenance.names
      .map((name) => localizeLayerName(name).toUpperCase())
      .join('/'),
  });
}

/** The name shown for a _viewBand() id. */
function viewBandLabel(band) {
  switch (band) {
    case 'STREET':
      return t('STREET', { context: 'view band' });
    case 'CITY':
      return t('CITY', { context: 'view band' });
    case 'METRO':
      return t('METRO', { context: 'view band' });
    case 'REGIONAL':
      return t('REGIONAL', { context: 'view band' });
    default:
      return t('GLOBAL', { context: 'view band' });
  }
}

/** Shader modes that automatically show the HUD overlay. */
const MILITARY_STYLES = new Set(['retro', 'surveillance', 'thermal']);

const HUD_SUMMARY_INTERVAL_MS = 15000;

/**
 * Cell size (degrees) for the ALT readout's geoid-undulation cache. N changes
 * by well under a metre across 0.01° (~1.1 km), so one lookup per cell keeps
 * the 4 Hz telemetry tick off the EGM96 grid without a visible step.
 */
const HUD_GEOID_CELL_DEG = 0.01;

/** Flattened list of all city POIs for nearest-point lookups. */
const NEARBY_POINTS = Object.values(CITY_POIS).flatMap((city) =>
  city.pois.map((poi) => ({
    city: city.name,
    poi: poi.name,
    lat: poi.lat,
    lon: poi.lon,
  })),
);

/**
 * Full-screen intelligence HUD overlay rendered on top of the Cesium canvas.
 *
 * Displays classification banners, MGRS/lat-lon readouts, sensor metrics
 * (GSD, NIIRS, off-nadir angle), sun elevation, orbital metadata, and a
 * rolling semantic summary line. All values derive from the live camera
 * position and update on independent timer cadences.
 */
/** A view-window side for the summary line, in the active language's units. */
function hudSpan(meters) {
  return meters < 1000
    ? hudQuantity(Math.round(meters), 'm')
    : hudQuantity(meters / 1000, 'km', meters < 100_000 ? 1 : 0);
}

export class IntelHUD {
  /**
   * @param {Cesium.Viewer} viewer - The Cesium Viewer instance used for
   *   camera telemetry and coordinate derivation.
   */
  constructor(
    viewer,
    {
      placeSearch,
      summaryPolicy = {},
      basemapContext = {},
      summaryService = applicationServices.summary,
    } = {},
  ) {
    this.summaryService = summaryService;
    this.summaryPolicy = summaryPolicy;
    this.basemapContext = basemapContext;
    this.placeSearch = placeSearch;
    this.viewer = viewer;
    this._visible = false;
    this._autoMode = true; // auto show/hide based on style
    this._currentStyle = 'normal';
    this._el = null;
    this._variant = DEFAULT_HUD_LAYOUT;
    this._recBlinkState = true;
    this._updateInterval = null;
    this._recBlinkInterval = null;
    this._timestampInterval = null;
    this._summaryInterval = null;
    this._summaryTypingInterval = null;
    /** Set by destroy(): nothing paints after teardown. */
    this._destroyed = false;
    this._latestMetrics = null;
    this._dataManager = null;
    this._dataManagerUnsubscribe = null;
    this._summaryDirty = true;
    this._summaryRequest = null;
    this._lastSummarySignature = '';
    /** @type {{signature: string, text: string}|null} The last AI reply painted. */
    this._lastSummaryReply = null;
    this._summaryRevision = 0;
    // One-shot guards so the very first summary lands immediately instead of
    // waiting for the 15s interval tick: B) swap the "Awaiting telemetry..."
    // placeholder for the deterministic line as soon as metrics exist, then
    // A) kick a real AI summary once the intro fly-to settles.
    this._firstMetricsShown = false;
    this._firstSummaryKicked = false;
    // ALT readout datum: the camera height Cesium reports is ELLIPSOIDAL, the
    // number a viewer reads is MSL. N comes from the same lazy ~2.7 MB EGM96
    // chunk the flight layers use — requested on the first telemetry tick of a
    // VISIBLE HUD, never at construction, so a hidden HUD costs nothing — and
    // cached per coarse cell. Until it resolves, or if it never does,
    // `ellipsoidalToMslDisplayM` passes the raw height straight through.
    this._geoidRequested = false;
    this._geoidReady = false;
    this._geoidCellKey = null;
    this._geoidN = null;
    // Whether the LAST painted tick actually had N. The grid resolves mid-
    // session, so this flips once — and both altitude readouts have to move
    // together when it does (see the repaint in _updateCameraData).
    this._geoidCorrectionApplied = false;
    // A summary built for one view must not land on the next: a request in
    // flight when the camera starts moving is aborted and nothing it ends
    // with paints (the revision moves), a reply still typing stops, and the
    // summary is marked dirty so the next periodic tick asks about the view
    // the camera has moved to.
    // While the camera moves the summary is the plain telemetry line,
    // repainted on each telemetry tick, so a flight never shows the place it
    // left; the AI line returns after the camera settles.
    this._cameraMoving = false;
    this._onCameraMoveStart = () => {
      this._cameraMoving = true;
      this._markSummaryDirty();
      this._summaryRequest?.abort();
      this._stopSummaryTyping();
      if (this._visible) this._setSummaryText(this._composeSummary(), false);
    };
    this._onCameraMoveEnd = () => {
      this._cameraMoving = false;
      this._markSummaryDirty();
      // The 250 ms telemetry timer and 15 s semantic-summary timer must not
      // leave the prior city on-screen after a long CCTV focus flight.
      // Refresh deterministic camera context synchronously on settle; the AI
      // summary can still upgrade it on its normal cadence.
      if (this._visible) {
        this._updateCameraData();
        this._setSummaryText(this._composeSummary(), false);
      }
      // First settled view: request the AI summary now rather than waiting for
      // the periodic tick (saves up to ~15s of "Awaiting telemetry...").
      if (!this._firstSummaryKicked && this._visible && this._latestMetrics) {
        this._firstSummaryKicked = true;
        void this._updateSummary(true, true);
      }
    };

    /** REC blinks only while the app's recording mode is on. */
    this._recording = false;
    this._scratchCenter = new Cesium.Cartesian2();
    this._scratchRay = new Cesium.Ray();
    this._scratchTarget = new Cesium.Cartesian3();

    this._buildDOM();
    this.viewer.camera.moveStart.addEventListener(this._onCameraMoveStart);
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);
    this._startTimers();
  }

  /**
   * Construct the HUD DOM structure inside the existing `#intel-hud` element.
   * Populates corner brackets, classification banners, sensor readouts,
   * edge metadata strips, and the bottom summary bar.
   */
  _buildDOM() {
    this._el = document.getElementById('intel-hud');
    if (!this._el) return;

    // i18n-ignore: sensor codes and a classification banner; the rest uses t()
    this._el.innerHTML = `
      <div class="hud-sonar" aria-hidden="true"></div>

      <div class="hud-corner hud-top-left">
        <div class="hud-content">
          <div class="hud-mode" id="hud-mode">${t(MODE_LABELS.normal)}</div>
          <div class="hud-summary-wrap">
            <div class="hud-summary-label">${t('SUMMARY')}</div>
            <div class="hud-summary" id="hud-summary">${t('Awaiting telemetry...')}</div>
          </div>
        </div>
      </div>

      <div class="hud-corner hud-top-right">
        <div class="hud-content" style="text-align:right">
          <div class="hud-rec"><span id="hud-rec-dot" style="visibility: hidden">●</span> <span id="hud-rec-label" style="visibility: hidden">${t('REC')}</span>  <span id="hud-timestamp">2026-01-01 00:00:00Z</span></div>
          <div class="hud-orbital" id="hud-orient">HDG ---°  RNG --</div>
        </div>
      </div>

      <div class="hud-corner hud-bottom-left">
        <div class="hud-content">
          <div id="hud-mgrs">MGRS: ---</div>
          <div id="hud-latlon">--°--'--"N ---°--'--"W</div>
        </div>
      </div>

      <div class="hud-corner hud-bottom-right">
        <div class="hud-content" style="text-align:right">
          <div id="hud-gsd">GSD: --m  NIIRS: --</div>
          <div id="hud-alt">ALT: --m   SUN: --° EL</div>
          <div><span id="hud-ona">ONA: --°</span>   <span id="hud-band">BAND: PAN</span></div>
          <div id="hud-ais-vessel" class="hud-ais-vessel">${t('AIS: --')}</div>
        </div>
      </div>

      <div class="hud-bottom-bar">
        <span id="hud-bottom-line">LAT: --  LON: --  MGRS: ---</span>
      </div>
    `;
    this._el.dataset.variant = this._variant;
  }

  /**
   * Start all periodic update timers (timestamp, REC blink, camera
   * telemetry, semantic summary). Timers run independently at different
   * cadences and are cleaned up in {@link destroy}.
   */
  _startTimers() {
    // Timestamp — every second
    this._timestampInterval = setInterval(() => {
      const el = document.getElementById('hud-timestamp');
      if (el) el.textContent = this._formatUTC();
    }, 1000);

    // REC blink — every 800ms, and only while recording mode is on
    this._recBlinkInterval = setInterval(() => {
      this._recBlinkState = this._recording && !this._recBlinkState;
      const dot = document.getElementById('hud-rec-dot');
      if (dot)
        dot.style.visibility = this._recBlinkState ? 'visible' : 'hidden';
    }, 800);

    // Camera-derived data — 4 updates/second (250ms)
    this._updateInterval = setInterval(() => {
      if (!this._visible) return;
      this._updateCameraData();
    }, 250);

    // Semantic summary refresh cadence
    this._summaryInterval = setInterval(() => {
      if (!this._visible) return;
      void this._updateSummary(true);
    }, HUD_SUMMARY_INTERVAL_MS);
  }

  /**
   * Format the current wall-clock time as a UTC Zulu string.
   * @returns {string} Timestamp in `YYYY-MM-DD HH:MM:SSZ` format.
   */
  _formatUTC() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const h = String(now.getUTCHours()).padStart(2, '0');
    const mi = String(now.getUTCMinutes()).padStart(2, '0');
    const s = String(now.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}Z`;
  }

  /**
   * Geoid undulation N at the camera subpoint, memoized per coarse cell.
   * @param {number} latDeg - Camera latitude in decimal degrees.
   * @param {number} lonDeg - Camera longitude in decimal degrees.
   * @returns {number|null} N in metres, or null while the grid is unavailable.
   */
  _geoidUndulationM(latDeg, lonDeg) {
    if (!this._geoidReady) {
      if (!this._geoidRequested) {
        this._geoidRequested = true;
        ensureGeoidReady()
          .then(() => {
            this._geoidReady = true;
          })
          .catch(() => {
            /* readout falls back to the uncorrected height */
          });
      }
      return null;
    }
    const key = `${Math.round(latDeg / HUD_GEOID_CELL_DEG)}:${Math.round(lonDeg / HUD_GEOID_CELL_DEG)}`;
    if (key !== this._geoidCellKey) {
      try {
        this._geoidN = geoidHeight(latDeg, lonDeg);
      } catch {
        this._geoidN = null;
      }
      this._geoidCellKey = key;
    }
    return Number.isFinite(this._geoidN) ? this._geoidN : null;
  }

  /**
   * Derive all camera-based telemetry and push values to the DOM.
   * Reads the viewer camera's cartographic position and computes MGRS,
   * lat/lon DMS, GSD, NIIRS, sun elevation, off-nadir angle, and
   * collection timestamp. Stores results in {@link _latestMetrics}.
   */
  _updateCameraData() {
    const camera = this.viewer.camera;
    const cartographic = camera.positionCartographic;
    if (!cartographic) return;

    const lonDeg = Cesium.Math.toDegrees(cartographic.longitude);
    const latDeg = Cesium.Math.toDegrees(cartographic.latitude);
    const altM = cartographic.height;
    const ona = offNadirDeg(camera.pitch);
    // The point at the centre of the view, where the reticle aims. MGRS,
    // lat/lon, range, GSD and the sun are all read there; the camera's own
    // position is ~1 km away at 60° off nadir and 627 m up. With nothing
    // under the centre (sky) they fall back to the camera's position.
    const target = this._viewCenterTarget();
    const targetCarto = target
      ? Cesium.Cartographic.fromCartesian(target)
      : cartographic;
    const targetLatDeg = Cesium.Math.toDegrees(targetCarto.latitude);
    const targetLonDeg = Cesium.Math.toDegrees(targetCarto.longitude);
    const latDMS = this._toDMS(targetLatDeg, 'lat');
    const lonDMS = this._toDMS(targetLonDeg, 'lon');
    let mgrsLabel = '---';

    // MGRS
    try {
      const mgrsStr = toMGRS([targetLonDeg, targetLatDeg], 4); // 4 = 10m precision
      // Format: 18SUJ23370716 → 18S UJ 2337 0716
      const formatted = this._formatMGRS(mgrsStr);
      mgrsLabel = formatted;
      const el = document.getElementById('hud-mgrs');
      // i18n-ignore: sensor codes
      if (el) el.textContent = `MGRS: ${formatted}`;
    } catch {
      const el = document.getElementById('hud-mgrs');
      // i18n-ignore: sensor codes
      if (el) el.textContent = 'MGRS: ---';
    }

    // Lat/Lon DMS
    const llEl = document.getElementById('hud-latlon');
    if (llEl) llEl.textContent = `${latDMS} ${lonDMS}`;
    const bottomEl = document.getElementById('hud-bottom-line');
    if (bottomEl) {
      // i18n-ignore: sensor codes
      bottomEl.textContent = `MGRS: ${mgrsLabel}  LAT: ${latDMS}  LON: ${lonDMS}`;
    }

    // GSD (Ground Sample Distance): the ground one rendered pixel covers at
    // the view centre, from the slant range, the field of view and the
    // drawing-buffer height; NIIRS from GSD by the simplified General Image
    // Quality Equation (hudReadouts.js).
    const rangeM = target
      ? Cesium.Cartesian3.distance(camera.positionWC, target)
      : slantRangeFromAltitudeM(altM, ona);
    const gsd = gsdFromRangeM(
      rangeM,
      camera.frustum.fovy,
      this.viewer.scene.drawingBufferHeight,
    );
    const gsdEl = document.getElementById('hud-gsd');
    if (gsdEl)
      gsdEl.textContent =
        // i18n-ignore: sensor codes
        gsd === null
          ? 'GSD: --m  NIIRS: --'
          : `GSD: ${gsd.toFixed(2)}m  NIIRS: ${niirsFromGsd(gsd).toFixed(1)}`;

    // Altitude — reported as height above MEAN SEA LEVEL. `altM` is the raw
    // ellipsoidal camera height, which reads far below zero wherever the geoid
    // sits under the ellipsoid: a cockpit parked on the SFO deck (N ≈ -32 m)
    // showed "ALT: -15m", and JFK "ALT: -18m". Subtracting N restores the
    // number a viewer expects without touching the camera or any render path.
    const altEl = document.getElementById('hud-alt');
    const geoidN = this._geoidUndulationM(latDeg, lonDeg);
    const altMslM = ellipsoidalToMslDisplayM(altM, geoidN);
    const sunEl = sunElevationDeg(target ?? camera.positionWC);
    if (altEl)
      // i18n-ignore: sensor codes
      altEl.textContent = `ALT: ${Math.round(altMslM)}m   SUN: ${sunEl.toFixed(1)}° EL`;

    // Heading and slant range to the view centre.
    const orientEl = document.getElementById('hud-orient');
    if (orientEl)
      // i18n-ignore: sensor codes
      orientEl.textContent = `HDG ${String(headingDeg(camera.heading)).padStart(3, '0')}°  RNG ${formatRange(rangeM)}`;

    // AIS: a selected vessel's card owns this line (layers/vessels/cards.js);
    // with none selected, say what is there instead of "--".
    const aisEl = document.getElementById('hud-ais-vessel');
    if (
      aisEl &&
      (aisEl.textContent === t('AIS: --') ||
        aisEl.textContent === this._aisIdleShown)
    ) {
      const vessels = this._dataManager?.layers?.get?.('ais-live-vessels');
      const text = aisIdleText({
        enabled: Boolean(this._dataManager?.isEnabled?.('ais-live-vessels')),
        count: Number(vessels?.module?.getStats?.()?.count) || 0,
      });
      aisEl.textContent = text;
      this._aisIdleShown = text;
    }

    // Off-nadir angle (ONA): 0 at nadir, rising toward the horizon.
    const onaEl = document.getElementById('hud-ona');
    // i18n-ignore: sensor codes
    if (onaEl) onaEl.textContent = `ONA: ${ona.toFixed(1)}°`;

    // `altM` stays the raw ellipsoidal camera height the sensor model reads
    // (GSD/NIIRS, view band). `altMslM` is the ADDITIVE display datum — the
    // only one any readout string should print. latDeg/lonDeg are the view
    // centre, like MGRS: the summary's NEAR place, region and UTC offset name
    // what is being looked at, not the ground under an oblique camera.
    this._latestMetrics = {
      latDeg: targetLatDeg,
      lonDeg: targetLonDeg,
      altM,
      altMslM,
      sunEl,
      ona,
      rangeM,
      gsd,
      headingDeg: headingDeg(camera.heading),
      // The ground the view spans at the view centre's scale: GSD times the
      // drawing buffer. Exact looking straight down; tilted, it is the span
      // at the centre, not a lat/lon box that reaches the horizon.
      windowM:
        gsd === null
          ? null
          : {
              width: gsd * this.viewer.scene.drawingBufferWidth,
              height: gsd * this.viewer.scene.drawingBufferHeight,
            },
    };

    // First time we have real telemetry: replace the "Awaiting telemetry..."
    // placeholder with the deterministic summary line instantly (no network),
    // so there's always meaningful context on screen. The AI summary upgrades
    // this within a second via the moveEnd kick / periodic refresh.
    if (!this._firstMetricsShown) {
      this._firstMetricsShown = true;
      this._setSummaryText(this._composeSummary(), false);
    }

    // The EGM96 grid lands mid-session, and the corner readout picks it up on
    // the very next telemetry tick. The summary line has no such cadence — it
    // repaints on camera settle or its own 15 s retry — so without this the
    // corner reads `ALT: 17m` beside a summary still reading `ALT -15M`, for
    // up to fifteen seconds. Repaint the deterministic line in the SAME tick
    // the correction turns on (or off, if a lookup starts failing), and mark
    // the summary dirty so the AI line refreshes on its normal cadence —
    // exactly what a camera settle already does.
    const geoidCorrectionApplied = Number.isFinite(geoidN);
    if (geoidCorrectionApplied !== this._geoidCorrectionApplied) {
      this._geoidCorrectionApplied = geoidCorrectionApplied;
      this._markSummaryDirty();
      this._setSummaryText(this._composeSummary(), false);
    }

    if (this._cameraMoving && this._visible)
      this._setSummaryText(this._composeSummary(), false);
  }

  /**
   * Insert spaces into a raw MGRS string for human-readable display.
   * @param {string} mgrs - Raw MGRS string, e.g. `"18SUJ23370716"`.
   * @returns {string} Formatted string, e.g. `"18S UJ 2337 0716"`.
   */
  _formatMGRS(mgrs) {
    // Regex captures: grid zone designator (1-2 digits + band letter),
    // 100km square ID (2 letters), numeric easting+northing (split in half).
    const match = mgrs.match(/^(\d{1,2}[A-Z])\s*([A-Z]{2})\s*(\d+)$/);
    if (!match) return mgrs;
    const [, zone, square, coords] = match;
    const half = coords.length / 2;
    const easting = coords.slice(0, half);
    const northing = coords.slice(half);
    return `${zone} ${square} ${easting} ${northing}`;
  }

  /**
   * Convert a decimal-degree value to a degrees-minutes-seconds string.
   * @param {number} decimal - Coordinate in decimal degrees.
   * @param {'lat'|'lon'} type - Axis selector; controls hemisphere letter
   *   and zero-padding width (2 digits for lat, 3 for lon).
   * @returns {string} Formatted DMS string, e.g. `"38°53'23.10"N"`.
   */
  _toDMS(decimal, type) {
    const abs = Math.abs(decimal);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = ((minFloat - min) * 60).toFixed(2);

    let dir;
    if (type === 'lat') dir = decimal >= 0 ? 'N' : 'S';
    else dir = decimal >= 0 ? 'E' : 'W';

    const degStr =
      type === 'lon'
        ? String(deg).padStart(3, '0')
        : String(deg).padStart(2, '0');
    return `${degStr}°${String(min).padStart(2, '0')}'${String(sec).padStart(5, '0')}"${dir}`;
  }

  /**
   * Classify the camera altitude into a named observation band.
   * @param {number} altM - Camera altitude in meters.
   * @returns {'STREET'|'CITY'|'METRO'|'REGIONAL'|'GLOBAL'} Band label.
   */
  _viewBand(altM) {
    if (altM < 1200) return 'STREET';
    if (altM < 5000) return 'CITY';
    if (altM < 30000) return 'METRO';
    if (altM < 250000) return 'REGIONAL';
    return 'GLOBAL';
  }

  /**
   * Return a coarse geographic region label based on lat/lon bounding boxes.
   * @param {number} lat - Latitude in decimal degrees.
   * @param {number} lon - Longitude in decimal degrees.
   * @returns {string} Region name (e.g. `"EUROPE"`, `"NORTHERN OCEANIC GRID"`).
   */
  _regionLabel(lat, lon) {
    if (lat > 72) return 'ARCTIC';
    if (lat < -60) return 'ANTARCTIC';
    if (lat >= 5 && lat <= 83 && lon >= -170 && lon <= -50)
      return 'NORTH AMERICA';
    if (lat >= -60 && lat <= 15 && lon >= -90 && lon <= -30)
      return 'SOUTH AMERICA';
    if (lat >= 34 && lat <= 72 && lon >= -25 && lon <= 45) return 'EUROPE';
    if (lat >= -35 && lat <= 38 && lon >= -20 && lon <= 55) return 'AFRICA';
    if (lat >= 5 && lat <= 80 && lon >= 45 && lon <= 180) return 'ASIA';
    if (lat >= -50 && lat <= 5 && lon >= 110 && lon <= 180) return 'OCEANIA';
    return lat >= 0 ? 'NORTHERN OCEANIC GRID' : 'SOUTHERN OCEANIC GRID';
  }

  /**
   * Compute the great-circle distance between two geographic points
   * using the Haversine formula.
   * @param {number} lat1 - Start latitude (decimal degrees).
   * @param {number} lon1 - Start longitude (decimal degrees).
   * @param {number} lat2 - End latitude (decimal degrees).
   * @param {number} lon2 - End longitude (decimal degrees).
   * @returns {number} Distance in kilometers.
   */
  _haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => Cesium.Math.toRadians(deg);
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Find the closest known POI to the given coordinates.
   * @param {number} latDeg - Latitude in decimal degrees.
   * @param {number} lonDeg - Longitude in decimal degrees.
   * @returns {{ city: string, poi: string, lat: number, lon: number, distKm: number }|null}
   *   Nearest point with distance, or null if no POIs are loaded.
   */
  _nearestKnownPoint(latDeg, lonDeg) {
    let best = null;
    for (const point of NEARBY_POINTS) {
      const distKm = this._haversineKm(latDeg, lonDeg, point.lat, point.lon);
      if (!best || distKm < best.distKm) {
        best = { ...point, distKm };
      }
    }
    return best;
  }

  /**
   * Build the one-line semantic summary string from the latest camera metrics.
   * Includes mode, observation band, nearest POI or lat/lon sector, region,
   * altitude, view window dimensions, sun elevation, ONA, and local timezone.
   * @returns {string} Formatted summary line for the HUD summary readout.
   */
  _composeSummary() {
    const m = this._latestMetrics;
    if (!m) return t('Awaiting telemetry...');

    const modeEl = document.getElementById('hud-mode');
    const modeLabel = modeEl?.textContent || t(MODE_LABELS.normal);
    const region = this._regionLabel(m.latDeg, m.lonDeg);
    const nearest = this._nearestKnownPoint(m.latDeg, m.lonDeg);
    const band = this._viewBand(m.altM);
    // Rough local timezone from longitude (15 deg per hour)
    const utcOffset = Math.round(m.lonDeg / 15);
    const localTag = `UTC${utcOffset >= 0 ? '+' : ''}${utcOffset}`;
    // Same MSL datum as the corner ALT readout — the two are on screen
    // together, so they must never disagree. The view band above deliberately
    // keeps the ellipsoidal height: its thresholds were tuned against it.
    const altDisplayM = Number.isFinite(m.altMslM) ? m.altMslM : m.altM;
    // Display only: the AI summary request carries its own context, so this
    // line is built in the active language.
    const altTag =
      altDisplayM >= 1000
        ? hudQuantity(altDisplayM / 1000, 'km', 1)
        : hudQuantity(Math.round(altDisplayM), 'm');
    const winTag = m.windowM
      ? `${hudSpan(m.windowM.width)}x${hudSpan(m.windowM.height)}`
      : t('N/A');
    // NEAR the nearest catalogued POI at metro range; otherwise the lat/lon sector.
    const localityTag = composeLocalityTag(
      nearest,
      m.latDeg,
      m.lonDeg,
      LOCALIZED_LOCALITY,
    );

    const provenance = localizedProvenanceTag(
      hudTelemetryProvenance(this._dataManager?.getAll?.() || []),
    );
    // ALT, SUN and ONA are sensor codes, as in the corner readouts.
    const line = t(
      '{mode} {band} {locality} | {region} | ALT {alt} | WINDOW {window} | SUN {sun}° | ONA {ona}° | {zone}',
      {
        mode: modeLabel,
        band: viewBandLabel(band),
        locality: localityTag,
        region: REGION_LABELS[region] ? t(REGION_LABELS[region]) : region,
        alt: altTag,
        window: winTag,
        sun: formatNumber(Math.round(m.sunEl)),
        ona: formatNumber(Math.round(m.ona)),
        zone: localTag,
      },
    );
    return provenance ? `${line} | ${provenance}` : line;
  }

  /** Stop a summary still typing out, leaving what it has typed so far. */
  _stopSummaryTyping() {
    clearInterval(this._summaryTypingInterval);
    this._summaryTypingInterval = null;
  }

  /**
   * Animate the summary text into the DOM using a typewriter effect
   * (2 characters every 24ms).
   * @param {string} text - Full summary string to type out.
   */
  _typeSummary(text) {
    const el = document.getElementById('hud-summary');
    if (!el) return;
    clearInterval(this._summaryTypingInterval);
    let index = 0;
    el.textContent = '';
    this._summaryTypingInterval = setInterval(() => {
      index += 2;
      if (index >= text.length) {
        el.textContent = text;
        clearInterval(this._summaryTypingInterval);
        this._summaryTypingInterval = null;
        return;
      }
      el.textContent = text.slice(0, index);
    }, 24);
  }

  /**
   * Refresh the summary readout. Optionally animates the text via typewriter.
   * @param {boolean} [animate=false] - If true, types the summary character
   *   by character; otherwise sets it instantly.
   */
  async _updateSummary(animate = false, force = false) {
    const fallbackText = this._composeSummary();
    if (!this._latestMetrics) {
      this._setSummaryText(fallbackText, animate);
      return;
    }
    if (!force && !this._summaryDirty) return;
    if (this.summaryPolicy.canRequest?.() === false) return;

    const revision = this._summaryRevision;
    // Every caller invokes this as `void this._updateSummary(...)`, so nothing
    // owns the returned promise — a rejection escaping from here lands as an
    // unhandled rejection in the console. Building the context walks the live
    // scene (the view-target pick, the layer roster), so it belongs INSIDE a
    // guard rather than in front of one. A summary we cannot build is a
    // fallback line, not a crash.
    let context;
    try {
      context = await this._summaryContext();
    } catch (error) {
      console.warn('[HUD] summary context unavailable:', error);
      // Left dirty on purpose: the next periodic tick retries instead of
      // sticking on the fallback line for the rest of the session. The
      // fallback was composed for this view; a moved camera keeps its own.
      if (revision === this._summaryRevision)
        this._setSummaryText(fallbackText, animate);
      return;
    }
    // Destroyed while the context was built: no request (it costs a call).
    if (this._destroyed || revision !== this._summaryRevision) return;
    const signature = JSON.stringify(context);
    if (!force && signature === this._lastSummarySignature) {
      // Same context as the last reply: repaint it (moveEnd may have
      // painted the plain line over it) instead of paying for a new call.
      if (this._lastSummaryReply?.signature === signature)
        this._setSummaryText(this._lastSummaryReply.text, false);
      this._summaryDirty = false;
      return;
    }
    if (this._summaryRequest) return;

    if (force) this._setSummaryText(fallbackText, false);
    this._summaryDirty = false;
    this._lastSummarySignature = signature;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 5000);
    this._summaryRequest = controller;
    try {
      this.summaryPolicy.onRequest?.();
      const response = await this.summaryService.summarize(context, {
        signal: controller.signal,
      });
      const data = response.data;
      if (revision !== this._summaryRevision) return;
      if (isHudSummaryUnconfigured(response.status, data)) {
        this._setSummaryText(fallbackText, animate);
        return;
      }
      if (!response.ok || !data?.summary) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      const matches = hudSummaryMatchesProvenance(
        data.summary,
        context.feedProvenance,
      );
      this._setSummaryText(matches ? data.summary : fallbackText, animate);
      // The painted AI reply, kept so a later tick over the same context
      // can repaint it without asking again.
      this._lastSummaryReply = matches
        ? { signature, text: data.summary }
        : null;
    } catch (error) {
      // The 5 s timeout is a failure like any other; a move's abort (or
      // destroy's) is not.
      const moved = revision !== this._summaryRevision;
      if (error?.name !== 'AbortError' || timedOut) {
        console.warn('[HUD] AI summary unavailable:', error);
        // Invalidate the committed signature so the next periodic tick
        // retries instead of sticking on the fallback line forever.
        this._lastSummarySignature = null;
        this._summaryDirty = true;
      }
      if (!moved) this._setSummaryText(fallbackText, animate);
    } finally {
      window.clearTimeout(timeout);
      if (this._summaryRequest === controller) this._summaryRequest = null;
      // A request whose answer was dropped (aborted by a move, or a reply
      // that came back after one) committed a signature it never painted;
      // forget it, or the next tick over the same place would skip asking.
      if (revision !== this._summaryRevision) this._lastSummarySignature = null;
    }
  }

  _setSummaryText(text, animate) {
    if (this._destroyed) return;
    if (animate) {
      this._typeSummary(text);
      return;
    }
    // A plain paint replaces any reply still typing.
    this._stopSummaryTyping();
    const el = document.getElementById('hud-summary');
    if (el) el.textContent = text;
  }

  async _summaryContext() {
    const labels = await getBasemapLabelContext(
      this.viewer,
      this.placeSearch,
      this.basemapContext,
    );
    const enabledLayers =
      this._dataManager
        ?.getAll?.()
        ?.filter((layer) => layer.enabled)
        .map((layer) => layer.name) || [];
    return {
      placeLabels: labels.placeLabels,
      streetLabels: labels.streetLabels,
      nearbyPlaceLabels: labels.nearbyPlaceLabels,
      enabledLayerLabels: enabledLayers,
      ...hudSummaryLayerContext(this._dataManager?.getAll?.() || []),
    };
  }

  /**
   * The view changed (a camera move, the geoid flip, show): a request in
   * flight is for the old view (the revision moves). A plain line may now
   * cover the AI one; the next tick repaints the saved reply when the
   * context is unchanged, without a new call.
   */
  _markSummaryDirty() {
    this._summaryDirty = true;
    this._summaryRevision++;
  }

  /**
   * Layer data changed but the view did not: ask on the next tick, and let a
   * reply already on its way land, since it describes this same view.
   */
  _markSummaryContentChanged() {
    this._summaryDirty = true;
  }

  // ── Public API ──────────────────────────

  /**
   * React to a shader-style change. Updates the mode label, HUD color
   * scheme (via CSS custom properties), and auto-shows/hides the overlay
   * when in auto mode.
   * @param {string} styleName - Active style key (e.g. `'surveillance'`,
   *   `'thermal'`, `'retro'`, `'normal'`).
   */
  /**
   * The globe point at the centre of the view, or null when the centre is sky
   * (or the globe is not pickable). globe.pick intersects terrain tiles on the
   * CPU, with no GPU readback.
   * @returns {Cesium.Cartesian3|null}
   */
  _viewCenterTarget() {
    const scene = this.viewer.scene;
    const canvas = scene?.canvas;
    if (!canvas?.clientWidth || typeof scene.globe?.pick !== 'function')
      return null;
    this._scratchCenter.x = canvas.clientWidth / 2;
    this._scratchCenter.y = canvas.clientHeight / 2;
    const ray = this.viewer.camera.getPickRay(
      this._scratchCenter,
      this._scratchRay,
    );
    if (!ray) return null;
    return scene.globe.pick(ray, scene, this._scratchTarget) ?? null;
  }

  /**
   * The HUD's measured readouts, for voice and Ask Claude answers ("what's
   * the GSD?"), or null before the first telemetry tick. Same numbers as the
   * corner readouts; GSD is the rendered pixel's ground footprint at the view
   * centre, NIIRS a GIQE estimate from it.
   * @returns {object|null}
   */
  getReadouts() {
    const m = this._latestMetrics;
    if (!m) return null;
    const round = (value, digits) =>
      Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
    return {
      viewCenter: {
        latitude: round(m.latDeg, 5),
        longitude: round(m.lonDeg, 5),
      },
      rangeToCenterM: round(m.rangeM, 0),
      headingDeg: m.headingDeg,
      offNadirDeg: round(m.ona, 1),
      altitudeMslM: round(m.altMslM, 0),
      sunElevationDeg: round(m.sunEl, 1),
      gsdMetersPerPixel: m.gsd === null ? null : round(m.gsd, 2),
      niirsEstimate: m.gsd === null ? null : round(niirsFromGsd(m.gsd), 1),
      viewSpanM: m.windowM
        ? {
            width: round(m.windowM.width, 0),
            height: round(m.windowM.height, 0),
          }
        : null,
    };
  }

  /**
   * Recording mode on or off (recordingControls.js). REC blinks only while it
   * is on; it used to blink forever.
   * @param {boolean} recording
   */
  setRecording(recording) {
    this._recording = Boolean(recording);
    const label = document.getElementById('hud-rec-label');
    if (label) label.style.visibility = this._recording ? 'visible' : 'hidden';
    if (!this._recording) {
      const dot = document.getElementById('hud-rec-dot');
      if (dot) dot.style.visibility = 'hidden';
    }
  }

  onStyleChange(styleName) {
    this._currentStyle = styleName;

    // Update mode label
    const modeEl = document.getElementById('hud-mode');
    if (modeEl) {
      modeEl.textContent = MODE_LABELS[styleName]
        ? t(MODE_LABELS[styleName])
        : styleName.toUpperCase();
    }
    const bandEl = document.getElementById('hud-band');
    // i18n-ignore: sensor codes
    if (bandEl) bandEl.textContent = `BAND: ${bandForStyle(styleName)}`;
    // Update color scheme
    const colors = HUD_COLORS[styleName] || HUD_COLORS._default;
    if (this._el) {
      this._el.style.setProperty('--hud-color', colors.main);
      this._el.style.setProperty('--hud-glow', colors.glow);
      this._el.style.setProperty('--hud-border', colors.border);
    }

    // Auto show/hide
    if (this._autoMode) {
      if (MILITARY_STYLES.has(styleName)) {
        this.show();
      } else {
        this.hide();
      }
    }
  }

  /** Make the HUD visible and immediately refresh all readouts. */
  show() {
    this._visible = true;
    if (this._el) this._el.classList.add('active');
    this._updateCameraData(); // immediate update
    this._markSummaryDirty();
    void this._updateSummary(false, true);
  }

  /** Hide the HUD overlay. */
  hide() {
    this._visible = false;
    if (this._el) this._el.classList.remove('active');
  }

  /** Toggle HUD visibility and disable auto-mode (user override). */
  toggle() {
    if (this._visible) {
      this._autoMode = false; // user override
      this.hide();
    } else {
      this._autoMode = false;
      this.show();
    }
  }

  /**
   * Explicit HUD mode control for scene/recording playback.
   * @param {'auto'|'on'|'off'} mode - `'auto'` re-enables style-driven
   *   show/hide; `'on'`/`'off'` force visibility and disable auto-mode.
   */
  setMode(mode) {
    if (mode === 'auto') {
      this._autoMode = true;
      this.onStyleChange(this._currentStyle);
      return;
    }

    this._autoMode = false;
    if (mode === 'on') this.show();
    else this.hide();
  }

  /**
   * Switch the HUD layout variant. Falls back to DEFAULT_HUD_LAYOUT if the
   * name is unrecognized. Cyber also applies a coordinated skin to the full
   * application shell; leaving Cyber restores the standard shell tokens.
   * @param {string} variantName - One of HUD_LAYOUTS (src/hudLayoutPolicy.js).
   */
  setVariant(variantName) {
    this._variant = normalizeHudLayout(variantName);
    if (this._el) {
      this._el.dataset.variant = this._variant;
    }
    applyHudUiTheme(document.documentElement, this._variant);
  }

  /**
   * @returns {string} The current HUD layout variant name.
   */
  getVariant() {
    return this._variant;
  }

  /**
   * @returns {'auto'|'on'|'off'} Current HUD mode — `'auto'` when style-driven
   *   show/hide is active, otherwise the explicit visibility override.
   */
  getMode() {
    if (this._autoMode) return 'auto';
    return this._visible ? 'on' : 'off';
  }

  /** @returns {boolean} Whether the HUD is currently visible. */
  get visible() {
    return this._visible;
  }

  attachDataManager(dataManager) {
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._dataManager = dataManager || null;
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        if (
          // data-updated and refresh-failed too: a new count or a feed
          // failing must reach the summary line, not just a layer toggle.
          [
            'visibility',
            'refresh-transition',
            'refresh-cancelled',
            'data-updated',
            'refresh-failed',
          ].includes(change?.type)
        )
          this._markSummaryContentChanged();
      });
    }
    this._markSummaryDirty();
  }

  /** Tear down all running intervals. Call when discarding the HUD instance. */
  destroy() {
    clearInterval(this._updateInterval);
    clearInterval(this._recBlinkInterval);
    clearInterval(this._timestampInterval);
    clearInterval(this._summaryInterval);
    clearInterval(this._summaryTypingInterval);
    this.viewer.camera.moveStart.removeEventListener(this._onCameraMoveStart);
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    this._dataManagerUnsubscribe?.();
    // Before the abort: its catch must not paint (or start typing) after
    // teardown.
    this._destroyed = true;
    this._summaryRequest?.abort();
  }
}
