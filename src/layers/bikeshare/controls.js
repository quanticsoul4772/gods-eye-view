import { msg, t, tn } from '../../i18n/index.js';
import {
  BIKESHARE_MODES,
  STATUS_POLL_MS,
  VEHICLE_ACTIVATION_ALTITUDE_M,
  VEHICLE_ENTER_ALTITUDE_M,
} from './policy.js';
import { listedSourcesText } from '../../sources/sourceDirectory.js';
import { modeHasStations, modeHasVehicles } from './vehicles.js';
import { sharedVehicleLabel } from './selection.js';

// English data; the chips translate them when drawn.
const MODE_CHIPS = Object.freeze({
  stations: {
    label: msg('Stations'),
    title: msg('Docking stations and their bikes'),
  },
  vehicles: {
    label: msg('Vehicles'),
    title: msg('Free-floating bikes, scooters and other shared vehicles'),
  },
  both: {
    label: msg('Both'),
    title: msg('Stations and free-floating vehicles'),
  },
});

const compact = (n) =>
  n >= 10_000
    ? `${Math.round(n / 1000)}K`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}K`
      : String(n);

export function createControls({ state: layerState, services, parts, source }) {
  const methods = {
    id: 'bikeshare',

    name: 'Bikeshare',

    icon: '🚲',

    source: 'GBFS',

    updateInterval: STATUS_POLL_MS,

    /**
     * What the layer's mode can show at the current view, read now rather
     * than from the debounced proximity state: whether a docking system (in
     * stations mode) or a shared-vehicle system (in vehicles mode) covers the
     * view centre, the same range tests the layer loads by, and, when none
     * does, how many listed sources there can't be shown (null when unknown).
     * The altitude gate is open when a covering part of the mode would show
     * at this height (vehicles show only lower down).
     * @returns {Promise<{covered: boolean, listed: number|null, altitudeGateOpen: boolean, center?: {lat: number, lon: number}}>}
     */
    async coverageHere() {
      const mode = layerState._mode;
      const viewer = layerState._viewer;
      const altitude = parts.viewport.getCameraAltitude(viewer);
      const center = parts.viewport.getCameraCenterLatLon(viewer);
      if (!center)
        return { covered: false, listed: null, altitudeGateOpen: false };
      let stations = false;
      let vehicles = false;
      let altitudeGateOpen = false;
      if (modeHasStations(mode)) {
        await layerState._systemsLoaded;
        stations = parts.viewport.computeInRangeCities(center).size > 0;
        if (stations)
          altitudeGateOpen = parts.viewport.shouldActivateAtAltitude(altitude);
      }
      if (modeHasVehicles(mode)) {
        // The list as the layer has it: wait for a load under way, start one
        // if none was made, but don't re-ask before a failure's retry time.
        if (
          !layerState._vehicleSystemsReady &&
          layerState._vehicleSystemsRetryAt <= Date.now()
        )
          await (layerState._vehicleSystemsLoading ??
            parts.vehicles.loadSystems());
        vehicles =
          parts.viewport.computeInRangeCities(
            center,
            layerState._vehicleSystems,
            0,
          ).size > 0;
        if (vehicles && altitude <= VEHICLE_ENTER_ALTITUDE_M)
          altitudeGateOpen = true;
      }
      const covered = stations || vehicles;
      if (covered) return { covered, listed: null, altitudeGateOpen, center };
      return {
        covered,
        listed:
          (await source.listed?.requestSettled(center.lat, center.lon)) ?? null,
        altitudeGateOpen,
        center,
      };
    },

    /** Saved and URL-restored options: what the layer draws. */
    getParams() {
      return { mode: layerState._mode };
    },

    /**
     * Switch between stations, vehicles and both. Stored while the layer is
     * off (saved options apply before enable); while on, the part the new
     * mode leaves out is torn down and the camera check runs again.
     * @returns {boolean|undefined} false only for an unknown mode.
     */
    setParams(params = {}) {
      if (params.mode === undefined) return undefined;
      if (!BIKESHARE_MODES.includes(params.mode)) return false;
      if (params.mode === layerState._mode) return true;
      layerState._mode = params.mode;
      if (!layerState._enabled) return true;
      layerState._proximityGeneration++;
      if (!modeHasStations(layerState._mode)) {
        parts.selection._clearSelection();
        parts.viewport.deactivateAllCities();
        layerState._cityRuntime.clear();
        layerState._count = 0;
        layerState._failedCityIds.clear();
      }
      if (layerState._pointCollection)
        layerState._pointCollection.show = modeHasStations(layerState._mode);
      parts.vehicles.sync();
      void parts.viewport.runProximityCheck();
      return true;
    },

    /** Stations | Vehicles | Both chips on the layer row. */
    getRowControls() {
      return {
        chips: BIKESHARE_MODES.map((mode) => ({
          id: `mode-${mode}`,
          label: t(MODE_CHIPS[mode].label),
          title: t(MODE_CHIPS[mode].title),
          active: layerState._mode === mode,
          params: { mode },
        })),
      };
    },

    /**
     * Return a sampled array of detectable station and vehicle objects for HUD overlay rendering.
     * @param {Object} [options] - Sampling options (maxCount, seed).
     * @returns {Array<{ position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean }>}
     */
    getDetectableObjects(options = {}) {
      return parts.queries.collectDetectableStations(options);
    },

    /**
     * Snapshot loaded bikeshare stations as plain JSON-safe records for the analyst
     * query engine. On demand only (once per spoken query); [] while the
     * layer is off.
     * @param {number} [maxCount=Infinity] Most records to return.
     * @returns {Array<Object>} {id, kind, name, city, lat, lon, bikesAvailable,
     *   docksAvailable, capacity, renting, formFactor, propulsion, operator}:
     *   stations first, then free-floating vehicles (no vehicle ids).
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!layerState._enabled) return [];
      const num = (v) => (Number.isFinite(v) ? v : null);
      const result = [];
      for (const record of layerState._stationRenderMap.values()) {
        if (result.length >= maxCount) break;
        const info = layerState._stationInfoCache
          .get(record.cityId)
          ?.get(record.stationId);
        if (!Number.isFinite(info?.lat) || !Number.isFinite(info?.lon))
          continue;
        result.push({
          id: record.stationName || `Dock ${record.stationId}`,
          kind: 'station',
          name: record.stationName || null,
          city: record.cityId || null,
          lat: info.lat,
          lon: info.lon,
          bikesAvailable: num(record.bikesAvailable),
          docksAvailable: num(record.docksAvailable),
          capacity: num(record.capacity),
          renting: record.isRenting !== false,
          formFactor: null,
          propulsion: null,
          operator: null,
        });
      }
      for (const record of layerState._vehicleRenderMap.values()) {
        if (result.length >= maxCount) break;
        result.push({
          id: sharedVehicleLabel(record),
          kind: 'vehicle',
          name: null,
          city: record.systemName || null,
          lat: record.lat,
          lon: record.lon,
          bikesAvailable: null,
          docksAvailable: null,
          capacity: null,
          renting: null,
          formFactor: record.formFactor,
          propulsion: record.propulsion,
          operator: record.operator || null,
        });
      }
      return result;
    },

    /**
     * Return current layer statistics for the UI status display.
     * @returns {{ count: number, lastUpdate: number|null, loading: boolean, loadingLabel?: string, error?: string, degraded?: boolean, stale?: boolean }}
     */
    getStats() {
      const mode = layerState._mode;
      const withStations = modeHasStations(mode);
      const withVehicles = modeHasVehicles(mode);
      const stations = withStations ? layerState._count : 0;
      const vehicles = withVehicles ? layerState._vehicleCount : 0;
      const stats = {
        count: stations + vehicles,
        // What the count is of, for captions and voice answers.
        countOf:
          mode === 'vehicles'
            ? 'shared vehicles'
            : mode === 'both'
              ? 'stations and shared vehicles'
              : 'stations',
        lastUpdate: layerState._lastUpdate,
        loading: layerState._loading,
      };
      if (mode === 'both' && stations && vehicles)
        stats.countLabel = `${compact(stations)} st · ${compact(vehicles)} veh`;
      if (layerState._loading) {
        const feeds =
          (withStations ? layerState._activeCityIds.size : 0) +
          (withVehicles ? layerState._activeVehicleIds.size : 0);
        stats.loadingLabel =
          feeds > 0
            ? tn(feeds, 'syncing {count} feed...', 'syncing {count} feeds...')
            : t('scanning nearby systems...');
      }
      // Stations: a failed city is only the layer's failure when it left
      // nothing on the map. While other cities (or, in Both, vehicles) still
      // render, the partial failure reads DEGRADED; when every in-range city
      // failed and only previously drawn points remain, they read STALE.
      let stationError = null;
      if (withStations && layerState._failedCityIds.size > 0) {
        const nothingDrawn =
          layerState._stationRenderMap.size === 0 &&
          (mode === 'stations' || layerState._vehicleCount === 0);
        if (nothingDrawn) {
          stationError = msg('GBFS fetch error');
        } else {
          stats.degraded = true;
          const allFailed = Array.from(layerState._activeCityIds).every(
            (cityId) => layerState._failedCityIds.has(cityId),
          );
          if (allFailed && layerState._stationRenderMap.size > 0)
            stats.stale = true;
        }
      }
      // Vehicles: in Both, a vehicle failure only counts once no vehicles are
      // drawn at all.
      const error =
        stationError ||
        (withVehicles &&
          layerState._vehicleError &&
          (mode === 'vehicles' || layerState._vehicleCount === 0) &&
          layerState._vehicleError) ||
        null;
      if (error) {
        stats.error = error;
        return stats;
      }
      if (layerState._loading) return stats;
      const stationsEmpty =
        layerState._altitudeGateEnabled &&
        layerState._systemsReady &&
        layerState._activeCityIds.size === 0;
      const vehiclesEmpty =
        layerState._vehicleGate &&
        layerState._vehicleSystemsReady &&
        layerState._activeVehicleIds.size === 0;
      if (mode === 'vehicles' && !layerState._vehicleGate) {
        stats.status = 'zoom-in';
        stats.statusMessage = t('Fly below {km} km for shared vehicles', {
          km: Math.round(VEHICLE_ACTIVATION_ALTITUDE_M / 1000),
        });
      } else if (
        mode === 'vehicles'
          ? vehiclesEmpty
          : stationsEmpty &&
            (mode === 'stations' || vehiclesEmpty || !layerState._vehicleGate)
      ) {
        stats.status = 'empty';
        stats.statusMessage =
          mode === 'vehicles'
            ? t('No shared vehicles here')
            : `${t('No system here')}${listedSourcesText(
                source.listed?.count(
                  layerState._center?.lat,
                  layerState._center?.lon,
                ),
              )}`;
      }
      return stats;
    },
  };

  return { methods };
}
