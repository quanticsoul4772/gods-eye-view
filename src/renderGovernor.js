/**
 * Idle render governor — the wave-2 flagship of the 2026-08-05 perf
 * investigation.
 *
 * The problem: Cesium's default render loop repaints every vsync forever, so
 * the app burned ~60% GPU + ~54% of a core with ZERO layers enabled and a
 * parked camera. The fix: flip the scene into Cesium's `requestRenderMode`
 * whenever nothing animates per frame, and return to the continuous loop the
 * moment something does.
 *
 * Architecture — three modes driven by identity-keyed holds:
 *
 * - **Continuous mode** (`requestRenderMode = false`, today's behavior)
 *   while ANY hold is registered. Every per-frame animator — fleet
 *   interpolation, traffic sim, satellite motion, tracked-entity follow,
 *   style crossfades, CCTV projection — registers a hold for exactly the
 *   lifetime of its scene-loop listener or animation. While one is active,
 *   behavior is byte-identical to pre-governor main: the locked
 *   interpolation/tracking invariants are preserved by construction.
 * - **Idle mode** (`requestRenderMode = true`) when zero holds. Cesium
 *   auto-renders on camera input and tile loads; every other scene mutation
 *   must call `governorRequestRender()` for its one frame. Discrete
 *   mutators (layer poll ticks, slider writes, annotation changes) route
 *   through that.
 *
 * - **Paced mode** (`requestRenderMode = true`) while only PACED holds
 *   exist. A fixed-step animator — the plane fleet moves every 80 ms — takes
 *   `holdPacedRender(owner, intervalMs)` instead of a continuous hold, and the
 *   governor requests a frame only when one of those steps is due. Rendering
 *   the frames in between redrew an unchanged picture: with Flights on over
 *   Denver an Intel Arc drew 47 frames/s, 36 of them with nothing changed.
 *   Each owner keeps its own due time, so frames from the camera, tiles or
 *   another owner never delay it. Smooth per-frame motion (tracked follow,
 *   camera orbit, interpolated traffic) keeps a continuous hold, which wins.
 *
 * Holds are identity-keyed (a Set of owner ids), NOT a counter — a module
 * that double-holds or double-releases cannot corrupt the mode. Owners are
 * short stable strings ('flights', 'traffic', 'style-anim', …) so the
 * diagnostics read like a story.
 *
 * Per frame the governor does nothing when no paced hold exists, and a scan of
 * the paced owners (a handful) when one does.
 */

let _viewer = null;
let _installed = false;
const _holds = new Set();

/** Shortest paced interval; anything faster is continuous rendering. */
const PACED_MIN_INTERVAL_MS = 16;
/**
 * Owners gate their steps on `Date.now()` (whole milliseconds) inside
 * preRender, against the time of their own last step; the governor times with
 * `performance.now()`. A drawn frame at least `interval + 1 ms` after an
 * owner's last step is sure to pass that gate, so it counts as the owner's
 * step whatever drew it (camera, tiles, another owner). The governor asks for
 * a frame only from `interval + 2 ms`, so a frame it asks for is never one the
 * owner's gate turns away.
 */
const PACED_SERVED_MARGIN_MS = 1;
const PACED_REQUEST_MARGIN_MS = 2;
/** owner id → { intervalMs, last } (`last` step on the `_now()` clock). */
const _paced = new Map();
let _now = () => performance.now();
let _removePacedListeners = null;
/** `?pacedRender=0` turns paced holds back into continuous ones, for comparison. */
let _pacedDisabled = (() => {
  try {
    return (
      new URLSearchParams(globalThis.location?.search ?? '').get(
        'pacedRender',
      ) === '0'
    );
  } catch {
    return false;
  }
})();

/** preUpdate (every tick): ask for a frame when a paced owner's step is due. */
function requestDuePacedFrame() {
  if (!_installed || _holds.size > 0 || _paced.size === 0) return;
  const now = _now();
  for (const entry of _paced.values()) {
    if (now - entry.last >= entry.intervalMs + PACED_REQUEST_MARGIN_MS) {
      _viewer.scene.requestRender?.();
      return;
    }
  }
}

/** preRender (drawn frames only): owners whose step falls in this frame take it. */
function servePacedOwners() {
  if (_paced.size === 0) return;
  const now = _now();
  for (const entry of _paced.values())
    if (now - entry.last >= entry.intervalMs + PACED_SERVED_MARGIN_MS)
      entry.last = now;
}

function detachPacedListeners() {
  for (const remove of _removePacedListeners ?? []) remove?.();
  _removePacedListeners = null;
}

/** Debug trail of the most recent one-shot render requests (idle mode only). */
const _recentRequests = [];
const RECENT_REQUEST_CAP = 16;

function applyMode() {
  if (!_installed || !_viewer?.scene) return;
  const continuous = _holds.size > 0;
  const scene = _viewer.scene;
  if (scene.requestRenderMode === !continuous) return;
  scene.requestRenderMode = !continuous;
  if (!continuous) {
    // Entering idle: render one settling frame so anything the last
    // continuous frame mutated is on screen before the loop stops.
    scene.requestRender?.();
  }
}

/**
 * Install the governor on the viewer. Idempotent. Before install,
 * hold/release still record into the holds set (and apply at install time);
 * requests are safe no-ops — so modules can call all three unconditionally
 * in tests without a viewer.
 * @param {Cesium.Viewer} viewer
 * @returns {void}
 */
export function installRenderGovernor(viewer) {
  if (!viewer?.scene)
    throw new TypeError('installRenderGovernor requires a Cesium viewer');
  if (_viewer !== viewer || !_removePacedListeners) {
    detachPacedListeners();
    // Attached once for the viewer's lifetime and idle without paced holds:
    // adding and removing them per hold could race Cesium's own
    // add-then-remove bookkeeping when a hold changes inside a frame event.
    _removePacedListeners = [
      viewer.scene.preUpdate?.addEventListener(requestDuePacedFrame),
      viewer.scene.preRender?.addEventListener(servePacedOwners),
    ];
  }
  _viewer = viewer;
  _installed = true;
  // Never let Cesium re-render on simulation-time deltas behind our back —
  // idle means idle. All re-renders are camera/tiles (Cesium-native) or
  // explicit requests.
  viewer.scene.maximumRenderTimeChange = Infinity;
  applyMode();
}

/**
 * Register a continuous-render hold. Idempotent per owner.
 * Call where the owner's per-frame work BEGINS (scene listener installed,
 * animation starts, tracking begins).
 * @param {string} ownerId Short stable id, e.g. 'flights', 'traffic'.
 * @returns {void}
 */
export function holdContinuousRender(ownerId) {
  if (!ownerId) return;
  _holds.add(ownerId);
  applyMode();
}

/**
 * Release a hold. Safe when never held.
 * Call where the owner's per-frame work ENDS (listener removed, animation
 * settled, tracking stopped, layer disabled).
 * @param {string} ownerId
 * @returns {void}
 */
export function releaseContinuousRender(ownerId) {
  if (!ownerId) return;
  _holds.delete(ownerId);
  applyMode();
}

/**
 * Register a paced hold: the owner's picture changes every `intervalMs`, so
 * the scene draws a frame when that step is due rather than every frame.
 * Idempotent per owner; holding again changes the interval. Call where the
 * owner's fixed-step work BEGINS (layer enabled).
 * @param {string} ownerId Short stable id, e.g. 'flights'.
 * @param {number} intervalMs The owner's step, e.g. 80.
 * @returns {void}
 */
export function holdPacedRender(ownerId, intervalMs) {
  if (!ownerId || !Number.isFinite(intervalMs) || intervalMs <= 0) return;
  if (_pacedDisabled) {
    holdContinuousRender(ownerId);
    return;
  }
  const interval = Math.max(PACED_MIN_INTERVAL_MS, intervalMs);
  const entry = _paced.get(ownerId);
  if (entry) entry.intervalMs = interval;
  else _paced.set(ownerId, { intervalMs: interval, last: -Infinity });
}

/**
 * Release a paced hold. Safe when never held. When the last paced owner goes
 * (and nothing holds continuous), one settling frame paints its final state.
 * @param {string} ownerId
 * @returns {void}
 */
export function releasePacedRender(ownerId) {
  if (!ownerId) return;
  if (_pacedDisabled) {
    releaseContinuousRender(ownerId);
    return;
  }
  if (!_paced.delete(ownerId)) return;
  if (_paced.size === 0 && _holds.size === 0 && _installed)
    _viewer?.scene?.requestRender?.();
}

/**
 * One-shot render request for a discrete scene mutation (layer tick, slider
 * write, annotation change). Always forwards to scene.requestRender() — in
 * continuous mode that is a harmless flag set (and forwarding closes the
 * request-then-last-release race); only idle-mode requests are recorded in
 * diagnostics. Cheap enough to call unconditionally after any mutation.
 * @param {string} [reason] For diagnostics only.
 * @returns {void}
 */
export function governorRequestRender(reason = 'unspecified') {
  if (!_installed || !_viewer?.scene) return;
  if (_holds.size === 0) {
    _recentRequests.push({ reason, at: Date.now() });
    if (_recentRequests.length > RECENT_REQUEST_CAP) _recentRequests.shift();
  }
  _viewer.scene.requestRender?.();
}

/**
 * @returns {{installed: boolean, mode: 'continuous'|'paced'|'idle',
 *   holds: string[], paced: Record<string, number>,
 *   recentRequests: Array<{reason: string, at: number}>}}
 */
export function getRenderGovernorDiagnostics() {
  return {
    installed: _installed,
    mode: _holds.size > 0 ? 'continuous' : _paced.size > 0 ? 'paced' : 'idle',
    holds: [..._holds].sort(),
    paced: Object.fromEntries(
      [..._paced.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([owner, { intervalMs }]) => [owner, intervalMs]),
    ),
    recentRequests: [..._recentRequests],
  };
}

/** Release the installed viewer after its animation owners have stopped. */
export function uninstallRenderGovernor(viewer) {
  if (_viewer !== viewer) return;
  detachPacedListeners();
  _viewer = null;
  _installed = false;
  _holds.clear();
  _paced.clear();
  _recentRequests.length = 0;
}

/**
 * Test seam: reset module state between unit tests.
 * @param {{now?: () => number, pacedDisabled?: boolean}} [options]
 */
export function _resetRenderGovernorForTest({
  now = () => performance.now(),
  pacedDisabled = false,
} = {}) {
  detachPacedListeners();
  _viewer = null;
  _installed = false;
  _holds.clear();
  _paced.clear();
  _recentRequests.length = 0;
  _now = now;
  _pacedDisabled = pacedDisabled;
}
