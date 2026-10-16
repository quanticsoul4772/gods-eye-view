import { fireDetectionKey, isMutedStatic } from '../../data/firmsLabels.js';
import { formatNumber, t, tn } from '../../i18n/index.js';
import { REFRESH_INTERVAL_MS } from './policy.js';

export function createQueries({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { id, name, icon, source } = config;

  const methods = {
    /** Return the selected detection as a plain record for application consumers. */
    getSelectedInfo() {
      const fire = layerState._selectedFire;
      if (!fire) return null;
      return {
        id: fireDetectionKey(fire),
        label: t('Fire · FRP {frp} MW', {
          frp: components.model.formatFrp(fire.frp),
        }),
        latitude: fire.lat,
        longitude: fire.lon,
        frp: fire.frp,
        confidencePct: Number.isFinite(fire.confidence)
          ? fire.confidence * 100
          : null,
        observedAt:
          Number.isFinite(fire.acqMs) && fire.acqMs > 0 ? fire.acqMs : null,
        source: fire.sensor || fire.satellite || null,
      };
    },

    id,

    name,

    icon,

    source,

    // The one data-layer control a provider key gates: the proxy answers
    // 503 {error:'no_key'} without a FIRMS key. Declared as a key-registry id
    // rather than an env-var string, so the panel can name the key from the
    // one place that owns what each key is called.
    requiresKeyId: 'firms',

    // Live layer: the manager calls update() every 10 minutes while enabled,
    // which refetches through the /api/firms proxy (the proxy's 30 min TTL —
    // not this interval — is what protects the upstream FIRMS quota).
    updateInterval: REFRESH_INTERVAL_MS,

    /**
     * Layer stats for the data panel. Degraded feed states surface through
     * `error` (established qa-failstate pattern: a dead feed must never look
     * like a healthy empty layer) with a matching human `loadingLabel`:
     * 'LIVE · updated Xm ago' fresh, 'STALE · cached Xh' when the proxy
     * served past-TTL cache, 'KEY REQUIRED' keyless.
     */
    getStats() {
      const now = Date.now();
      const staleText = layerState._lastUpdate
        ? t('STALE · cached {age}', {
            age:
              components.model.formatAge(now - layerState._lastUpdate) || '<1h',
          })
        : t('STALE');
      let loadingLabel = '';
      if (layerState._loading) {
        loadingLabel = layerState._allFires.length
          ? t('refreshing...')
          : t('loading...');
      } else if (layerState._keyRequired) {
        loadingLabel = t('KEY REQUIRED');
      } else if (layerState._stale) {
        loadingLabel = staleText;
      } else if (layerState._error) {
        loadingLabel = layerState._error;
      } else if (layerState._lastUpdate) {
        loadingLabel = t('LIVE · updated {age}', {
          age: components.model.formatAgoMinutes(now - layerState._lastUpdate),
        });
      }
      const hiddenStatic = layerState._hideStatic ? layerState._staticCount : 0;
      return {
        count: layerState._count,
        // English data for the assistant: what `count` leaves out.
        ...(hiddenStatic
          ? {
              hiddenStatic,
              countOf: `fire detections, excluding ${hiddenStatic} at known solar farms or industrial sites (likely not fires)`,
            }
          : {}),
        cells: layerState._cellCount,
        lastUpdate: layerState._lastUpdate,
        loading: layerState._loading,
        stale: layerState._stale,
        // The machine-readable half of the keyless state, ahead of the human
        // strings below: without it "no key configured" is indistinguishable
        // from a broken feed, and the row reads as a fault instead of a step
        // the operator can take.
        keyRequired: layerState._keyRequired,
        error: layerState._keyRequired
          ? t('KEY REQUIRED')
          : layerState._stale
            ? staleText
            : layerState._error,
        loadingLabel,
      };
    },

    /**
     * Strongest currently-loaded detection (by FRP) for voice targeting
     * ("take me to the biggest fire").
     * @returns {{latitude: number, longitude: number, frp: number, label: string}|null}
     */
    getStrongestFire() {
      // Never a likely static source, whatever the chip shows: the biggest
      // "fire" is otherwise often a steel works or a gas flare.
      const strongest =
        layerState._allFiresByFrp.find((fire) => !isMutedStatic(fire)) || null;
      if (!strongest) return null;
      return {
        latitude: strongest.lat,
        longitude: strongest.lon,
        frp: strongest.frp,
        label: t('Fire · FRP {frp} MW', {
          frp: components.model.formatFrp(strongest.frp),
        }),
      };
    },

    /**
     * Detection-overlay seam, shaped like the other layers' detectable
     * objects (traffic/flights). NOT yet registered in initDetection's layer
     * list — wiring fires through the detection/label-arbiter pipeline is a
     * deliberate post-PR#1 task; when that happens the arbiter replaces this
     * layer's greedy declutter as the SELECTOR and the shared overlay remains
     * the renderer. Walks the FRP-sorted index so the strongest fires come first.
     * @param {{maxCount?: number}} [options]
     * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string}>}
     */
    getDetectableObjects(options = {}) {
      if (!layerState._enabled || !layerState._firesByFrp.length) return [];
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : 250;
      const result = [];
      for (const fire of layerState._firesByFrp) {
        result.push({
          position: components.model.firePosition(fire),
          id: `FIRE-${String(fire.index).padStart(5, '0')}`,
          type: 'FIRE',
        });
        if (result.length >= maxCount) break;
      }
      return result;
    },

    /**
     * Snapshot the layer's in-memory fire records as plain JSON-safe
     * objects for the analyst query engine. Walks the FRP-sorted index so
     * truncation keeps the STRONGEST fires (200k+ detections can be live —
     * the cap is load-bearing, not cosmetic). On-demand only (called at
     * most once per spoken query) — zero per-frame cost, no listeners, no
     * caching. Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!layerState._enabled || !layerState._allFiresByFrp.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      // One rule for every assistant path, whatever the chip shows: likely
      // static sources are left out (getStats().countOf says how many).
      for (const fire of layerState._allFiresByFrp) {
        if (isMutedStatic(fire)) continue;
        result.push(components.model.mapAnalystRecord(fire));
        if (result.length >= limit) break;
      }
      return result;
    },

    /** The one persisted option: hide likely static sources (default true). */
    getParams() {
      return { hideStatic: layerState._hideStatic };
    },

    /**
     * Apply `{hideStatic}`. Works before any data or viewer exists (boot
     * restore); re-derives the drawn set, deselects a detection that becomes
     * hidden (a user deselect, not an eviction), and redraws when enabled.
     */
    setParams(params) {
      if (!params || typeof params !== 'object') return false;
      if (typeof params.hideStatic !== 'boolean') return true;
      if (params.hideStatic === layerState._hideStatic) return true;
      layerState._hideStatic = params.hideStatic;
      components.ingestion.applyStaticFilter();
      if (layerState._hideStatic && isMutedStatic(layerState._selectedFire))
        components.selection.clearFireSelection();
      layerState._currentLodIndex = -1;
      if (layerState._enabled) components.rendering.renderCurrentLod(true);
      return true;
    },

    /** Data-panel chip: show or hide detections at known solar/industrial sites. */
    getRowControls() {
      const n = layerState._staticCount;
      if (!layerState._maskAvailable || !n) return { chips: [] };
      const count =
        n >= 1000
          ? `${formatNumber(n / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })}K`
          : String(n);
      return {
        chips: [
          {
            id: 'static',
            label: tn(
              n,
              'SOLAR & INDUSTRIAL · {count}',
              'SOLAR & INDUSTRIAL · {count}',
              {
                count,
              },
            ),
            active: !layerState._hideStatic,
            title: tn(
              n,
              '{count} detection at a known solar farm (daytime sun glint) or industrial site such as a kiln, steel works or gas flare. Usually not a wildfire, so hidden. Turn on to show it in grey. Site maps: solar to 2024, industrial to 2021.',
              '{count} detections at known solar farms (daytime sun glint) and industrial sites such as kilns, steel works and gas flares. Usually not wildfires, so hidden. Turn on to show them in grey. Site maps: solar to 2024, industrial to 2021.',
              { count },
            ),
            params: { hideStatic: !layerState._hideStatic },
          },
        ],
      };
    },

    /** Test seam that binds the production click path and indexes. */
    _bindInteractionForTest(viewer, fires = []) {
      layerState._viewer = viewer;
      layerState._enabled = true;
      layerState._allFires = fires;
      layerState._allFiresByFrp = [...fires];
      layerState._fires = fires;
      layerState._firesByFrp = [...fires];
      layerState._pickIndexById.clear();
      layerState._labelLodDistance = 1e7;
      layerState._labelCandidates = fires.map((fire) => {
        layerState._pickIndexById.set(`firms-${fire.index}`, fire);
        return { fire, position: components.model.firePosition(fire) };
      });
      components.cards.rebuildAmbientLabels();
      components.selection.installClickHandler();
      return layerState._clickHandler;
    },
  };

  return { methods };
}
