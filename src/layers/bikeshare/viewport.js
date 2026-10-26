import * as Cesium from 'cesium';
import {
  ACTIVATION_EXIT_ALTITUDE_M,
  ACTIVATION_ENTER_ALTITUDE_M,
  CITY_RANGE_BASE_KM,
  CAMERA_DEBOUNCE_MS,
} from './policy.js';
import { modeHasStations } from './vehicles.js';
import { CITY_BY_ID } from './registry.js';

export function createViewport({ state: layerState, services, parts, source }) {
  const { governorRequestRender } = services.render;

  /**
   * Get the camera's current altitude in meters above the ellipsoid.
   * @param {Cesium.Viewer} viewer - Cesium viewer instance.
   * @returns {number} Altitude in meters, or Infinity if unavailable.
   */

  function getCameraAltitude(viewer) {
    const carto = viewer?.camera?.positionCartographic;
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  /**
   * Determine the lat/lon the camera is currently looking at.
   * Prefers the center of the computed view rectangle; falls back to the
   * camera's own cartographic position when the rectangle is unavailable.
   * @param {Cesium.Viewer} viewer - Cesium viewer instance.
   * @returns {{ lat: number, lon: number }|null} Center coordinates in degrees, or null.
   */

  function getCameraCenterLatLon(viewer) {
    // The ground point under the screen centre, where the camera looks. The
    // visible rectangle's midpoint reaches toward the horizon in an angled
    // view (300 km out over Denver it fell ~350 km north), so it is only the
    // fallback when the centre ray misses the globe.
    const canvas = viewer?.scene?.canvas;
    const ellipsoid = viewer?.scene?.globe?.ellipsoid;
    const hit =
      canvas?.clientWidth > 0 &&
      canvas.clientHeight > 0 &&
      viewer.camera?.pickEllipsoid?.(
        new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
        ellipsoid,
      );
    if (hit) {
      const carto = (
        ellipsoid || Cesium.Ellipsoid.WGS84
      ).cartesianToCartographic(hit);
      if (carto)
        return {
          lat: Cesium.Math.toDegrees(carto.latitude),
          lon: Cesium.Math.toDegrees(carto.longitude),
        };
    }
    // Fallback: the view rectangle's center
    const rect = viewer?.camera?.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    if (rect) {
      const center = Cesium.Rectangle.center(rect);
      return {
        lat: Cesium.Math.toDegrees(center.latitude),
        lon: Cesium.Math.toDegrees(center.longitude),
      };
    }

    // Fallback: use the camera's own position
    const carto = viewer?.camera?.positionCartographic;
    if (carto) {
      return {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
      };
    }

    return null;
  }

  /**
   * Determine whether the layer should be active at the given camera altitude.
   * Uses hysteresis (separate enter/exit thresholds) to avoid rapid toggling
   * when the camera hovers near the activation boundary.
   * @param {number} altitude - Camera altitude in meters.
   * @returns {boolean} True if the layer should remain/become active.
   */

  function shouldActivateAtAltitude(altitude) {
    if (!Number.isFinite(altitude)) {
      layerState._altitudeGateEnabled = false;
      return false;
    }
    if (layerState._altitudeGateEnabled) {
      // Deactivate only after crossing the higher exit threshold
      if (altitude >= ACTIVATION_EXIT_ALTITUDE_M)
        layerState._altitudeGateEnabled = false;
    } else if (altitude <= ACTIVATION_ENTER_ALTITUDE_M) {
      // Activate when dropping below the lower enter threshold
      layerState._altitudeGateEnabled = true;
    }
    return layerState._altitudeGateEnabled;
  }

  /**
   * Determine which systems are close enough to the camera to warrant loading.
   * Compares haversine distance from the camera center to each system's center
   * against its load radius (at least `baseKm`).
   * @param {{ lat: number, lon: number }} center - Camera center in degrees.
   * @param {Map<string, Object>} [systems] - Station cities by default (the
   *   static registry until the layer's own city map exists).
   * @param {number} [baseKm] - Smallest load radius.
   * @returns {Set<string>} Set of ids currently within load range.
   */

  function computeInRangeCities(
    center,
    systems = layerState._cities ?? CITY_BY_ID,
    baseKm = CITY_RANGE_BASE_KM,
  ) {
    const active = new Set();
    if (!center) return active;

    for (const city of systems.values()) {
      const distance = parts.model.haversineKm(
        center.lat,
        center.lon,
        city.centerLat,
        city.centerLon,
      );
      const radius = Math.max(baseKm, city.loadRadiusKm);
      if (distance <= radius) active.add(city.id);
    }

    return active;
  }

  /**
   * Fully deactivate a single city: abort pending fetches and remove rendered points.
   * @param {string} cityId - City identifier to deactivate.
   */

  function deactivateCity(cityId) {
    governorRequestRender('bikeshare-deactivate');
    parts.ingestion.abortInFlight(layerState._inFlightInfo, cityId);
    parts.ingestion.abortInFlight(layerState._inFlightStatus, cityId);
    parts.rendering.removeCityPoints(cityId);
  }

  /** Deactivate all currently active cities and clear the active set. */

  function deactivateAllCities() {
    const cityIds = Array.from(layerState._activeCityIds);
    for (const cityId of cityIds) deactivateCity(cityId);
    layerState._activeCityIds.clear();
    // A failure belongs to a city in range; none are once everything is off.
    layerState._failedCityIds.clear();
    layerState._count = 0;
  }

  /**
   * Activate a city: fetch station info, create point primitives, fetch status,
   * and apply availability colors. Checks generation at each async boundary
   * to bail out if the proximity context has changed.
   * @param {string} cityId - City identifier to activate.
   * @param {number} generation - Proximity generation at time of invocation.
   */

  async function activateCity(cityId, generation) {
    if (!layerState._enabled || !layerState._activeCityIds.has(cityId)) return;

    try {
      const stationMap = await parts.ingestion.loadCityStationInfo(
        cityId,
        generation,
      );
      // Bail if context changed during fetch
      if (
        !layerState._enabled ||
        !layerState._activeCityIds.has(cityId) ||
        generation !== layerState._proximityGeneration
      )
        return;

      parts.rendering.ensureCityPoints(cityId, stationMap);

      // Apply any cached status immediately for snappier initial rendering
      const cachedStatus = layerState._statusCache.get(cityId)?.statusMap;
      if (cachedStatus) {
        parts.rendering.applyStatusToPoints(cityId, cachedStatus);
      }

      const statusMap = await parts.ingestion.loadCityStationStatus(
        cityId,
        generation,
      );
      if (
        !layerState._enabled ||
        !layerState._activeCityIds.has(cityId) ||
        generation !== layerState._proximityGeneration
      )
        return;
      parts.rendering.applyStatusToPoints(cityId, statusMap);
      layerState._lastUpdate = Date.now();
      layerState._failedCityIds.delete(cityId);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      // A rejection from superseded work must not mark (or tear down) a city
      // that a newer proximity check or re-enable now owns.
      if (
        !layerState._enabled ||
        !layerState._activeCityIds.has(cityId) ||
        generation !== layerState._proximityGeneration
      )
        return;
      console.warn(`[Data:Bikeshare] ${cityId} activate error:`, error);
      layerState._failedCityIds.add(cityId);
      deactivateCity(cityId);
      layerState._activeCityIds.delete(cityId);
    } finally {
      layerState._count = layerState._stationRenderMap.size;
    }
  }

  /**
   * Core proximity check: determines which cities are in camera range at the
   * current altitude, deactivates out-of-range cities, and activates newly
   * in-range ones. Increments the generation counter to invalidate stale work.
   * @returns {Promise<void>}
   */

  async function runProximityCheck() {
    if (!layerState._enabled || !layerState._viewer) return;

    const generation = ++layerState._proximityGeneration;
    const altitude = getCameraAltitude(layerState._viewer);
    const center = getCameraCenterLatLon(layerState._viewer);
    layerState._center = center;
    // Vehicles have their own gate and radius, and run whatever stations do.
    parts.vehicles.proximity(center, altitude);
    // The station gate runs in every mode, so a switch back to stations
    // inside the hysteresis band finds it as the camera left it.
    const stationGate = shouldActivateAtAltitude(altitude);
    if (!modeHasStations(layerState._mode) || !stationGate) {
      deactivateAllCities();
      return;
    }

    if (!center) return;

    // Diff active set against newly computed in-range set
    const nextActive = computeInRangeCities(center);
    for (const cityId of layerState._activeCityIds) {
      if (!nextActive.has(cityId)) {
        deactivateCity(cityId);
      }
    }
    // A failure never outlives its city's range.
    for (const cityId of layerState._failedCityIds) {
      if (!nextActive.has(cityId)) layerState._failedCityIds.delete(cityId);
    }

    layerState._activeCityIds = nextActive;
    if (layerState._activeCityIds.size === 0) {
      layerState._count = 0;
      // No system here: ask what the source directory lists instead.
      if (layerState._systemsReady)
        void source.listed?.request(center.lat, center.lon);
      return;
    }

    // Only activate cities that don't already have rendered points
    const toActivate = [];
    for (const cityId of layerState._activeCityIds) {
      if (!layerState._cityRuntime.has(cityId)) toActivate.push(cityId);
    }
    if (toActivate.length === 0) return;

    await Promise.all(
      toActivate.map((cityId) => activateCity(cityId, generation)),
    );
  }

  /** Schedule a debounced proximity check after camera movement. */

  function scheduleProximityCheck() {
    clearTimeout(layerState._cameraDebounceTimer);
    layerState._cameraDebounceTimer = setTimeout(() => {
      void runProximityCheck();
    }, CAMERA_DEBOUNCE_MS);
  }

  /** Camera change event handler — triggers a debounced proximity check. */

  function onCameraChanged() {
    if (!layerState._enabled) return;
    scheduleProximityCheck();
  }
  return {
    getCameraAltitude,
    getCameraCenterLatLon,
    shouldActivateAtAltitude,
    computeInRangeCities,
    deactivateCity,
    deactivateAllCities,
    activateCity,
    runProximityCheck,
    scheduleProximityCheck,
    onCameraChanged,
  };
}
