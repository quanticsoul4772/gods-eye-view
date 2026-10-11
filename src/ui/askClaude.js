import * as Cesium from 'cesium';

const ASK_URL = '/api/claude/ask';
const STYLE = `
#ask-claude { position: fixed; left: 12px; bottom: 160px; z-index: 40;
  width: min(420px, calc(100vw - 24px)); font: 13px/1.4 system-ui, sans-serif;
  color: #e8eef2; background: rgba(8, 14, 20, 0.88);
  border: 1px solid rgba(120, 200, 255, 0.35); border-radius: 6px; padding: 8px; }
#ask-claude form { display: flex; gap: 6px; }
#ask-claude input { flex: 1; min-width: 0; font: inherit; color: inherit;
  background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px; padding: 5px 7px; }
#ask-claude button { font: inherit; color: inherit; cursor: pointer;
  background: rgba(120, 200, 255, 0.18); border: 1px solid rgba(120, 200, 255, 0.45);
  border-radius: 4px; padding: 5px 10px; }
#ask-claude button[disabled] { opacity: 0.5; cursor: wait; }
#ask-claude output { display: block; white-space: pre-wrap; margin-top: 6px;
  max-height: 22vh; overflow-y: auto; }
#ask-claude output:empty { display: none; }
/* Above the map credits, which must stay visible, and hidden until the
   loading cover has gone so a click never lands on it. */
body.ui-clean-view #ask-claude, body.ui-embed #ask-claude,
body:has(#loading-screen:not(.hidden)) #ask-claude { display: none; }
`;

/** Where the camera is, in degrees and metres, or null before the scene is ready. */
function cameraPosition(viewer) {
  const position = viewer?.camera?.positionCartographic;
  if (!position) return null;
  return {
    lat: Cesium.Math.toDegrees(position.latitude),
    lon: Cesium.Math.toDegrees(position.longitude),
    altitude_m: position.height,
  };
}

/** Turn on the view's layers (leaving the others as they are) and fly to it. */
async function showView(view, { viewer, dataManager, run }) {
  for (const layerId of view.layers ?? []) {
    if (!dataManager.isEnabled(layerId))
      await run('set_layer_visibility', { layerId, enabled: true });
  }
  const camera = view.camera;
  if (!camera) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      camera.lon,
      camera.lat,
      camera.altitude_m,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(camera.heading_deg ?? 0),
      pitch: Cesium.Math.toRadians(camera.pitch_deg ?? -90),
    },
    duration: 2,
  });
}

/**
 * A typed question box answered by Claude through /api/claude/ask. Returns a
 * function that removes it.
 */
export function installAskClaude({
  viewer,
  dataManager,
  run,
  documentRef = globalThis.document,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  const style = documentRef.createElement('style');
  style.textContent = STYLE;
  const root = documentRef.createElement('section');
  root.id = 'ask-claude';
  root.setAttribute('aria-label', 'Ask Claude');
  const form = documentRef.createElement('form');
  const input = documentRef.createElement('input');
  input.type = 'text';
  input.maxLength = 500;
  input.placeholder = 'Ask Claude about what is on the map';
  input.setAttribute('aria-label', 'Question for Claude');
  const button = documentRef.createElement('button');
  button.type = 'submit';
  button.textContent = 'Ask';
  const output = documentRef.createElement('output');
  output.setAttribute('aria-live', 'polite');
  form.append(input, button);
  root.append(form, output);
  documentRef.head.append(style);
  documentRef.body.append(root);

  // Keys typed here must not reach the app's keyboard shortcuts.
  const stopKeys = (event) => event.stopPropagation();
  input.addEventListener('keydown', stopKeys);

  const onSubmit = async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || button.disabled) return;
    button.disabled = true;
    output.textContent = 'Asking Claude…';
    try {
      const response = await fetchImpl(ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, camera: cameraPosition(viewer) }),
      });
      const payload = await response.json().catch(() => ({}));
      output.textContent =
        payload.answer ||
        payload.error ||
        `Request failed (${response.status})`;
      if (payload.answer && payload.view)
        await showView(payload.view, { viewer, dataManager, run });
    } catch {
      output.textContent = 'Could not reach the app server.';
    } finally {
      button.disabled = false;
    }
  };
  form.addEventListener('submit', onSubmit);

  return () => {
    form.removeEventListener('submit', onSubmit);
    input.removeEventListener('keydown', stopKeys);
    root.remove();
    style.remove();
  };
}
