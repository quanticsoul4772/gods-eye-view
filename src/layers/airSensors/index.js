import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AIR_SENSOR_UNKNOWN_COLOR,
  AIR_SENSORS_CARD_SOURCE_ID,
  AIR_SENSORS_LABEL_COLLISION_CAPACITY,
  AIR_SENSORS_LABEL_LIMIT,
  AIR_SENSORS_OVERLAY_SOURCE_ID,
  CELL_VIEW_HEIGHT_M,
  aggregateCells,
  bandColor,
  bySeverity,
  mapAnalystRecord,
  newestObservation,
  readingsAreStale,
  worstInView,
} from './model.js';
import {
  buildCellCard,
  buildSensorCard,
  eaqiBandLabel,
  legendEntries,
  pm25Text,
  sensorMapUrl,
} from './cards.js';
export * from './model.js';
export { createAirSensorsSource } from './source.js';

const POINT_PREFIX = 'air-sensors:';
const CELL_PREFIX = 'air-sensors-cell:';
/** Readings listed in the Weather card. */
const READOUT_LIMIT = 5;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Worse bands draw larger so they stay visible among good ones. */
const PIXEL_SIZE = [6, 6, 6, 7, 8, 9];
/** Light bands get a dark outline, dark bands a light one: visible on any imagery. */
const OUTLINE_DARK = Cesium.Color.fromCssColorString('#1b1f24').withAlpha(0.85);
const OUTLINE_LIGHT = Cesium.Color.fromCssColorString('#f4f6f8').withAlpha(0.9);
/** Sensor points sit just above the ellipsoid; depth tests are off within this range. */
const POINT_DEPTH_TEST_OFF_M = 1_500_000;

/**
 * Own the air-sensors display (Sensor.Community, EEA index bands from PM):
 * points when zoomed in, grid cells at continental zoom, the worst
 * confirmed readings as labels, a card for the clicked sensor or cell, and
 * the Weather card's readout.
 */
export function createAirSensorsLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  credits = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air sensors require a snapshot source');
  if (!overlayHost) throw new TypeError('Air sensors require an overlay host');
  let _viewer = null;
  let _points = null;
  let _cells = null;
  let _request = null;
  let _readings = [];
  let _cellList = [];
  let _signature = null;
  /** @type {Map<string, object>} */
  const _readingById = new Map();
  /** @type {Map<string, object>} */
  const _cellByKey = new Map();
  const _credited = new Set();
  let _cellMode = false;
  let _proxyStale = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selected = null;
  let _selectedCardId = null;
  let _moveEndAttached = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();
  const requestRender = () => _viewer?.scene?.requestRender?.();
  const canSelect = () => screenSpaceEventHandlerFactory && picking;

  /** The camera's lon/lat rectangle in degrees, or null when unresolvable. */
  const viewRectangle = () => {
    const rectangle = _viewer?.camera?.computeViewRectangle?.();
    if (!rectangle) return null;
    const toDeg = Cesium.Math.toDegrees;
    return {
      west: toDeg(rectangle.west),
      south: toDeg(rectangle.south),
      east: toDeg(rectangle.east),
      north: toDeg(rectangle.north),
    };
  };

  const cameraHeight = () =>
    _viewer?.camera?.positionCartographic?.height ?? Infinity;

  function rebuildPoints() {
    _points.removeAll();
    // Severity order: the worst are added last and draw on top.
    for (const reading of _readings.slice().sort((a, b) => -bySeverity(a, b))) {
      // A reading far above its neighbours (likely a faulty sensor) is grey
      // and small: its band shows on its card, never as an alarm colour.
      const color = reading.unconfirmed
        ? Cesium.Color.fromCssColorString(AIR_SENSOR_UNKNOWN_COLOR).withAlpha(
            0.7,
          )
        : Cesium.Color.fromCssColorString(bandColor(reading.band));
      _points.add({
        id: `${POINT_PREFIX}${reading.id}`,
        position: Cesium.Cartesian3.fromDegrees(reading.lon, reading.lat, 30),
        pixelSize: reading.unconfirmed ? 5 : (PIXEL_SIZE[reading.band] ?? 6),
        color,
        outlineColor:
          reading.band >= 3 && !reading.unconfirmed
            ? OUTLINE_LIGHT
            : OUTLINE_DARK,
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(10_000, 1.25, 800_000, 0.85),
        disableDepthTestDistance: POINT_DEPTH_TEST_OFF_M,
      });
    }
    _cells.removeAll();
    _cellByKey.clear();
    for (const cell of _cellList.slice().sort((a, b) => a.band - b.band)) {
      if (cell.band < 0) continue;
      _cellByKey.set(cell.key, cell);
      _cells.add({
        id: `${CELL_PREFIX}${cell.key}`,
        position: Cesium.Cartesian3.fromDegrees(cell.lon, cell.lat, 3000),
        pixelSize: Math.min(16, 7 + Math.round(Math.log2(cell.count + 1))),
        color: Cesium.Color.fromCssColorString(bandColor(cell.band)).withAlpha(
          0.9,
        ),
        outlineColor: cell.band >= 3 ? OUTLINE_LIGHT : OUTLINE_DARK,
        outlineWidth: 1,
      });
    }
  }

  function applyMode() {
    if (!_points || !_cells) return;
    _cellMode = cameraHeight() > CELL_VIEW_HEIGHT_M;
    _points.show = _enabled && !_cellMode;
    _cells.show = _enabled && _cellMode;
  }

  /** Labels: the worst confirmed readings in view, when zoomed in. */
  function publishLabels() {
    if (!_enabled || _cellMode) {
      overlayHost.setEntries(AIR_SENSORS_OVERLAY_SOURCE_ID, [], {
        cohortLimit: AIR_SENSORS_LABEL_LIMIT,
        collisionCapacity: AIR_SENSORS_LABEL_COLLISION_CAPACITY,
        moving: false,
      });
      return;
    }
    const entries = worstInView(
      _readings,
      viewRectangle(),
      AIR_SENSORS_LABEL_LIMIT,
    ).map((reading) => ({
      id: reading.id,
      position: Cesium.Cartesian3.fromDegrees(reading.lon, reading.lat, 30),
      variant: 'label',
      title: pm25Text(reading.pm25) || eaqiBandLabel(reading.band),
      accent: bandColor(reading.band),
      // Worse air wins the label budget.
      priority: reading.band * 100_000 + Math.round((reading.pm25 ?? 0) * 10),
      collisionGroup: 'ambient-label',
      paintLane: 'ambient-label',
      interactive: false,
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
      gapPx: 12,
      verticalOnly: true,
      placement: 'above',
    }));
    overlayHost.setEntries(AIR_SENSORS_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: AIR_SENSORS_LABEL_LIMIT,
      collisionCapacity: AIR_SENSORS_LABEL_COLLISION_CAPACITY,
      moving: false,
    });
  }

  function onMoveEnd() {
    if (!_enabled) return;
    const wasCells = _cellMode;
    applyMode();
    if (wasCells !== _cellMode && _selected) clearSelection();
    publishLabels();
    notify();
    requestRender();
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    let card = null;
    let position = null;
    if (_selected?.kind === 'sensor') {
      const reading = _readingById.get(_selected.id);
      if (reading) {
        card = buildSensorCard(reading, Date.now(), {
          interactive: Boolean(openExternal),
        });
        position = Cesium.Cartesian3.fromDegrees(reading.lon, reading.lat, 30);
        if (openExternal) {
          const url = sensorMapUrl(reading);
          card.activate = () => {
            openExternal(url);
            return true;
          };
        }
      }
    } else if (_selected?.kind === 'cell') {
      const cell = _cellByKey.get(_selected.id);
      if (cell) {
        card = buildCellCard(cell);
        position = Cesium.Cartesian3.fromDegrees(cell.lon, cell.lat, 3000);
      }
    }
    if (!card) {
      _selected = null;
      _selectedCardId = null;
      overlayHost.setEntries(AIR_SENSORS_CARD_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      AIR_SENSORS_CARD_SOURCE_ID,
      [{ ...card, position }],
      CARD_HOST_OPTIONS,
    );
  }

  function clearSelection() {
    _selected = null;
    _selectedCardId = null;
    overlayHost.clearSource(AIR_SENSORS_CARD_SOURCE_ID);
  }

  /** A scene pick → {kind, id} of this layer, or null. */
  function pickedTarget(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string') return null;
    if (pickId.startsWith(POINT_PREFIX)) {
      const id = pickId.slice(POINT_PREFIX.length);
      return _readingById.has(id) ? { kind: 'sensor', id } : null;
    }
    if (pickId.startsWith(CELL_PREFIX)) {
      const id = pickId.slice(CELL_PREFIX.length);
      return _cellByKey.has(id) ? { kind: 'cell', id } : null;
    }
    return null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      layer.id,
      (pickedId) =>
        String(pickedId).startsWith(POINT_PREFIX) ||
        String(pickedId).startsWith(CELL_PREFIX),
    );
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        {
          sourceId: AIR_SENSORS_CARD_SOURCE_ID,
        },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        const reading =
          _selected?.kind === 'sensor' ? _readingById.get(_selected.id) : null;
        if (reading && openExternal) openExternal(sensorMapUrl(reading));
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const target = picked ? pickedTarget(picked) : null;
      if (target) {
        _selected = target;
        publishSelectedCard();
        requestRender();
        return;
      }
      // A sibling layer's pick is not empty space: leave the selection alone.
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selected) {
        clearSelection();
        requestRender();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    picking?.unregisterPickOwner?.(layer.id);
  }

  function attachMoveEnd() {
    if (_moveEndAttached || !_viewer?.camera?.moveEnd) return;
    _viewer.camera.moveEnd.addEventListener(onMoveEnd);
    _moveEndAttached = true;
  }

  function detachMoveEnd() {
    if (!_moveEndAttached) return;
    _viewer?.camera?.moveEnd?.removeEventListener(onMoveEnd);
    _moveEndAttached = false;
  }

  const layer = {
    id: 'air-sensors',
    name: 'Air quality (PM sensors)',
    icon: '◌',
    source: 'Sensor.Community',
    updateInterval: 1_200_000,

    init(viewer) {
      if (_viewer) throw new Error('Air sensors layer is already initialized');
      _viewer = viewer;
      _points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      _cells = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      _points.show = false;
      _cells.show = false;
      viewer.scene.primitives.add(_points);
      viewer.scene.primitives.add(_cells);
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(AIR_SENSORS_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(AIR_SENSORS_CARD_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      applyMode();
      overlayHost.setVisible(AIR_SENSORS_OVERLAY_SOURCE_ID, true);
      overlayHost.setVisible(AIR_SENSORS_CARD_SOURCE_ID, true);
      installClickHandler();
      attachMoveEnd();
      publishLabels();
      notify();
      requestRender();
    },

    disable() {
      // A response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      applyMode();
      removeClickHandler();
      detachMoveEnd();
      clearSelection();
      overlayHost.clearSource(AIR_SENSORS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_SENSORS_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(AIR_SENSORS_CARD_SOURCE_ID, false);
      notify();
      requestRender();
    },

    async update() {
      if (!_enabled || !_points) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        for (const feed of snapshot.sources) {
          if (_credited.has(feed.id) || !credits || !_viewer) continue;
          _credited.add(feed.id);
          credits.registerDynamicCredit(
            _viewer,
            credits.airSensorFeedCredit({
              id: feed.id,
              attribution: feed.attribution,
              licenseUrl: feed.licenceUrl,
            }),
          );
        }
        _proxyStale = snapshot.stale;
        _readings = snapshot.readings;
        const signature = _readings
          .map(
            (r) =>
              `${r.id}:${r.band}:${r.pm25}:${r.pm10}:${r.unconfirmed ? 1 : 0}`,
          )
          .join('|');
        _readingById.clear();
        for (const reading of _readings) _readingById.set(reading.id, reading);
        if (signature !== _signature) {
          _cellList = aggregateCells(_readings);
          rebuildPoints();
          _signature = signature;
        }
        applyMode();
        if (_selected) publishSelectedCard();
        publishLabels();
        _count = _readings.length;
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        requestRender();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Air sensor source unavailable');
        console.warn('[Data:AirSensors] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      removeClickHandler();
      detachMoveEnd();
      clearSelection();
      overlayHost.clearSource(AIR_SENSORS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_SENSORS_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(AIR_SENSORS_CARD_SOURCE_ID, false);
      if (_points) viewer?.scene?.primitives?.remove(_points);
      if (_cells) viewer?.scene?.primitives?.remove(_cells);
      _points = null;
      _cells = null;
      _viewer = null;
      _readings = [];
      _cellList = [];
      _signature = null;
      _readingById.clear();
      _cellByKey.clear();
      _credited.clear();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _proxyStale = false;
      rowControlsListener = null;
    },

    /** The Weather card: legend, coverage, caveat and the worst readings in view. */
    getRowControls() {
      const inView = worstInView(_readings, viewRectangle(), READOUT_LIMIT);
      const newest = newestObservation(_readings);
      let status;
      if (_lastError) status = translateFeedError(_lastError);
      else if (_count === 0)
        status =
          _lastUpdate === null
            ? t('No readings available')
            : t('No current readings');
      else if (_proxyStale)
        status = t('Sensor.Community unreachable · showing earlier readings');
      else
        status = tn(
          _count,
          '{count} sensor reporting',
          '{count} sensors reporting',
        );
      return {
        readout: true,
        summary: {
          label: t('Air quality (PM sensors)'),
          coverage: t(
            'Mostly Europe · Sensor.Community volunteer sensors · indicative',
          ),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          detail: t('EEA index bands, PM only · reads high in humid air'),
          status,
          units: 'µg/m³',
        },
        legend: legendEntries(),
        legendCategorical: true,
        list: {
          ariaLabel: t('Highest particulate readings in view'),
          items: inView.map((reading, index) => ({
            id: reading.id,
            ordinal: index + 1,
            lead: pm25Text(reading.pm25) || eaqiBandLabel(reading.band),
            text: [eaqiBandLabel(reading.band), reading.country]
              .filter(Boolean)
              .join(' · '),
            accent: bandColor(reading.band),
          })),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Readings as JSON-safe records for the analyst query engine, worst
     * first. Each carries the `quality` caveat.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_readings.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _readings
        .slice()
        .sort(bySeverity)
        .slice(0, limit)
        .map(mapAnalystRecord);
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        observedAt: newestObservation(_readings),
        stale:
          _lastUpdate !== null && (_proxyStale || readingsAreStale(_readings)),
      };
    },
  };
  return layer;
}
