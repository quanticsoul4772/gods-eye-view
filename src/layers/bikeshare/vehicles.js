import * as Cesium from 'cesium';
import {
  CAMERA_DEBOUNCE_MS,
  MAX_TOTAL_VEHICLES,
  VEHICLE_ENTER_ALTITUDE_M,
  VEHICLE_EXIT_ALTITUDE_M,
  VEHICLE_HEIGHT_OFFSET_M,
  VEHICLE_ICON_PX,
} from './policy.js';
import {
  SHARED_VEHICLE_COLORS,
  sharedVehicleGlyph,
  sharedVehicleIcon,
} from '../../data/sharedVehicleIcons.js';

/** Whether a mode draws stations / vehicles. */
export const modeHasStations = (mode) => mode !== 'vehicles';
export const modeHasVehicles = (mode) => mode === 'vehicles' || mode === 'both';

/**
 * Free-floating shared vehicles (directory `sharedmobility.vehicles` systems
 * through `/api/sharedmobility`). Systems activate by camera centre and their
 * own radius below a lower altitude gate than stations; each keeps only its
 * latest snapshot. Every arrival rebuilds ONE pool of billboards, reused by
 * index: merged, same-operator duplicates dropped, nearest first, capped.
 * Vehicles carry no ids, so nothing follows one vehicle across polls.
 */
export function createVehicles({ state: layerState, services, parts, source }) {
  const { governorRequestRender } = services.render;
  const ground = services.ground || null;
  let reheightTimer = null;
  const scratch = new Cesium.Cartographic();

  const wanted = () => layerState._enabled && modeHasVehicles(layerState._mode);
  const supported = () =>
    typeof source?.getVehicleSystems === 'function' &&
    typeof source?.getVehicles === 'function';

  function init(viewer) {
    layerState._vehicleCollection = new Cesium.BillboardCollection({
      scene: viewer.scene,
    });
    viewer.scene.primitives.add(layerState._vehicleCollection);
    services.sprites.registerSpriteCollection(
      'bikeshare-vehicles',
      layerState._vehicleCollection,
    );
    layerState._vehicleCollection.show = false;
  }

  /** Load the system list once; resolves when known. */
  function loadSystems() {
    if (!supported()) {
      layerState._vehicleSystemsReady = true;
      return Promise.resolve();
    }
    layerState._vehicleSystemsLoading ??= source
      .getVehicleSystems()
      .then((systems) => {
        layerState._vehicleSystems = new Map(
          systems
            .filter(
              (s) =>
                typeof s?.id === 'string' &&
                Number.isFinite(s.centerLat) &&
                Number.isFinite(s.centerLon) &&
                Number.isFinite(s.loadRadiusKm),
            )
            .map((s) => [s.id, Object.freeze({ ...s })]),
        );
      })
      .catch((error) => {
        console.warn('[Data:Bikeshare] shared vehicle systems:', error);
        layerState._vehicleError = 'Shared vehicle systems unavailable';
      })
      .finally(() => {
        layerState._vehicleSystemsReady = true;
        layerState._vehicleSystemsLoading = null;
      });
    return layerState._vehicleSystemsLoading;
  }

  /** Show or hide the vehicles for the current mode; loads systems on first need. */
  function sync() {
    if (layerState._vehicleCollection)
      layerState._vehicleCollection.show = wanted();
    if (!wanted()) {
      deactivateAll();
      return;
    }
    if (!layerState._vehicleSystemsReady && !layerState._vehicleSystemsLoading)
      void loadSystems().then(() => {
        if (wanted()) void parts.viewport.runProximityCheck();
      });
  }

  function gateOpen(altitude) {
    if (!Number.isFinite(altitude)) return (layerState._vehicleGate = false);
    if (layerState._vehicleGate) {
      if (altitude >= VEHICLE_EXIT_ALTITUDE_M) layerState._vehicleGate = false;
    } else if (altitude <= VEHICLE_ENTER_ALTITUDE_M) {
      layerState._vehicleGate = true;
    }
    return layerState._vehicleGate;
  }

  /** Activate the systems around the camera; called on every settled camera. */
  function proximity(center, altitude) {
    if (!wanted() || !gateOpen(altitude) || !center) {
      if (!wanted() || !layerState._vehicleGate) deactivateAll();
      return;
    }
    const next = parts.viewport.computeInRangeCities(
      center,
      layerState._vehicleSystems,
      0,
    );
    let changed = false;
    for (const id of [...layerState._activeVehicleIds])
      if (!next.has(id)) {
        deactivate(id);
        changed = true;
      }
    for (const id of next)
      if (!layerState._activeVehicleIds.has(id)) {
        layerState._activeVehicleIds.add(id);
        void fetchSystem(id);
      }
    if (changed) rebuild();
  }

  async function fetchSystem(id) {
    if (layerState._inFlightVehicles.has(id)) return;
    const controller = new AbortController();
    layerState._inFlightVehicles.set(id, controller);
    parts.ingestion.beginLoading();
    try {
      const snapshot = await source.getVehicles(id, {
        signal: controller.signal,
      });
      if (!wanted() || !layerState._activeVehicleIds.has(id)) return;
      const system = layerState._vehicleSystems.get(id);
      layerState._vehicleSnapshots.set(id, {
        vehicles: Array.isArray(snapshot?.vehicles) ? snapshot.vehicles : [],
        expiresAt:
          Date.now() + 1000 * Math.max(0, Number(snapshot?.expiresInS) || 0),
      });
      if (system && !layerState._creditedVehicleSystems.has(id)) {
        layerState._creditedVehicleSystems.add(id);
        if (layerState._viewer)
          services.credits?.registerDynamicCredit(
            layerState._viewer,
            services.credits.gbfsSystemCredit({ ...system, city: system.name }),
          );
      }
      layerState._vehicleError = null;
      layerState._lastUpdate = Date.now();
      rebuild();
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.warn(`[Data:Bikeshare] ${id} vehicles:`, error);
      layerState._vehicleError = 'Shared vehicle feed error';
    } finally {
      if (layerState._inFlightVehicles.get(id) === controller)
        layerState._inFlightVehicles.delete(id);
      parts.ingestion.endLoading();
    }
  }

  /** Refetch active systems whose snapshot has expired (the layer's update tick). */
  function poll() {
    if (!wanted()) return Promise.resolve();
    const now = Date.now();
    const due = [...layerState._activeVehicleIds].filter(
      (id) => !(layerState._vehicleSnapshots.get(id)?.expiresAt > now),
    );
    return Promise.all(due.map(fetchSystem));
  }

  function deactivate(id) {
    layerState._inFlightVehicles.get(id)?.abort();
    layerState._inFlightVehicles.delete(id);
    layerState._vehicleSnapshots.delete(id);
    layerState._activeVehicleIds.delete(id);
  }

  function deactivateAll() {
    if (
      !layerState._activeVehicleIds.size &&
      !layerState._vehicleRenderMap.size
    )
      return;
    for (const id of [...layerState._activeVehicleIds]) deactivate(id);
    for (const controller of layerState._inFlightVehicles.values())
      controller.abort();
    layerState._inFlightVehicles.clear();
    rebuild();
  }

  /** Height above the drawn surface: the terrain globe, else the 3D-tiles ground floor. */
  function heightAt(lat, lon) {
    const globe = layerState._viewer?.scene?.globe;
    if (globe?.show === true) {
      Cesium.Cartographic.fromDegrees(lon, lat, 0, scratch);
      const h = globe.getHeight?.(scratch);
      if (Number.isFinite(h)) return { h: h + VEHICLE_HEIGHT_OFFSET_M };
    }
    const floor = ground?.cachedGroundFloor?.(lat, lon);
    if (Number.isFinite(floor)) return { h: floor + VEHICLE_HEIGHT_OFFSET_M };
    return { h: VEHICLE_HEIGHT_OFFSET_M, missing: true };
  }

  /** Merge, drop same-operator duplicates, keep the nearest, draw. */
  function rebuild() {
    const collection = layerState._vehicleCollection;
    if (!collection) return;
    const selected = layerState._vehicleRenderMap.get(layerState._selectedKey);
    if (selected) parts.selection._clearSelection();

    const center = layerState._center;
    const seen = new Map();
    const rows = [];
    for (const [id, snapshot] of layerState._vehicleSnapshots) {
      if (!layerState._activeVehicleIds.has(id)) continue;
      const system = layerState._vehicleSystems.get(id);
      const operator = system?.provider || system?.name || '';
      for (const v of snapshot.vehicles) {
        if (!Number.isFinite(v?.lat) || !Number.isFinite(v?.lon)) continue;
        // Overlapping regional and local feeds of one operator list the
        // same vehicles; within one feed, vehicles parked together all stay.
        const key = `${operator}|${v.lat}|${v.lon}|${v.formFactor}`;
        const owner = seen.get(key);
        if (owner && owner !== id) continue;
        seen.set(key, id);
        rows.push({
          v,
          system,
          operator,
          d: center
            ? parts.model.haversineKm(center.lat, center.lon, v.lat, v.lon)
            : 0,
        });
      }
    }
    rows.sort((a, b) => a.d - b.d);
    const shown = rows.slice(0, MAX_TOTAL_VEHICLES);

    layerState._vehicleRenderMap = new Map();
    const missing = [];
    for (let i = 0; i < shown.length; i += 1) {
      const { v, system, operator } = shown[i];
      const key = `veh:${i}`;
      let billboard = collection.length > i ? collection.get(i) : null;
      const { h, missing: noFloor } = heightAt(v.lat, v.lon);
      if (noFloor) missing.push({ lat: v.lat, lon: v.lon });
      const position = Cesium.Cartesian3.fromDegrees(v.lon, v.lat, h);
      const glyph = sharedVehicleGlyph(v.formFactor);
      const color = Cesium.Color.fromCssColorString(
        SHARED_VEHICLE_COLORS[v.formFactor] || SHARED_VEHICLE_COLORS.unknown,
      );
      if (!billboard) {
        billboard = collection.add({
          id: key,
          position,
          image: sharedVehicleIcon(glyph),
          color,
          width: VEHICLE_ICON_PX,
          height: VEHICLE_ICON_PX,
          scaleByDistance: new Cesium.NearFarScalar(200, 1.2, 15000, 0.5),
          disableDepthTestDistance: 2500,
        });
        billboard._gevGlyph = glyph;
      } else {
        billboard.position = position;
        if (billboard._gevGlyph !== glyph) {
          billboard.image = sharedVehicleIcon(glyph);
          billboard._gevGlyph = glyph;
        }
        billboard.color = color;
        billboard.show = true;
      }
      layerState._vehicleRenderMap.set(key, {
        key,
        kind: 'vehicle',
        point: billboard,
        lat: v.lat,
        lon: v.lon,
        formFactor: v.formFactor,
        propulsion: v.propulsion ?? null,
        reportedAt: v.reportedAt ?? null,
        operator,
        systemName: system?.name || null,
      });
    }
    for (let i = shown.length; i < collection.length; i += 1)
      collection.get(i).show = false;
    layerState._vehicleCount = shown.length;

    if (selected) {
      // Parked vehicles don't move: find the same one again, else drop the card.
      for (const record of layerState._vehicleRenderMap.values())
        if (
          record.lat === selected.lat &&
          record.lon === selected.lon &&
          record.formFactor === selected.formFactor
        ) {
          parts.selection._selectStation(record.key);
          break;
        }
    }
    if (missing.length && ground?.warmGroundFloor) {
      ground.warmGroundFloor(missing);
      clearTimeout(reheightTimer);
      reheightTimer = setTimeout(reheight, 4 * CAMERA_DEBOUNCE_MS);
    }
    governorRequestRender('bikeshare-vehicles');
  }

  /** Lift vehicles once the ground floor under them has been resolved. */
  function reheight() {
    reheightTimer = null;
    for (const record of layerState._vehicleRenderMap.values()) {
      const { h, missing } = heightAt(record.lat, record.lon);
      if (!missing)
        record.point.position = Cesium.Cartesian3.fromDegrees(
          record.lon,
          record.lat,
          h,
        );
    }
    governorRequestRender('bikeshare-vehicles');
  }

  function disable() {
    clearTimeout(reheightTimer);
    reheightTimer = null;
    deactivateAll();
    layerState._vehicleGate = false;
    layerState._vehicleError = null;
    if (layerState._vehicleCollection)
      layerState._vehicleCollection.show = false;
  }

  function destroy(viewer) {
    disable();
    if (layerState._vehicleCollection) {
      services.sprites.unregisterSpriteCollection?.(
        'bikeshare-vehicles',
        layerState._vehicleCollection,
      );
      viewer.scene.primitives.remove(layerState._vehicleCollection);
      layerState._vehicleCollection = null;
    }
  }

  return {
    init,
    sync,
    loadSystems,
    proximity,
    poll,
    rebuild,
    deactivateAll,
    disable,
    destroy,
    has: (key) => layerState._vehicleRenderMap.has(key),
  };
}
