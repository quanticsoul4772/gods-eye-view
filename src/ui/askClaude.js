import * as Cesium from 'cesium';

const ASK_URL = '/api/claude/ask';
/** Server round trips per request; each one can run several app actions. */
const MAX_ROUNDS = 8;
/** A long conversation starts over rather than being trimmed (trimming edits history). */
const MAX_HISTORY_MESSAGES = 160;
const MAX_HISTORY_CHARS = 1_500_000;
/** Longest action result sent back; app state reads can be large. */
const MAX_RESULT_CHARS = 12_000;

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
#ask-claude .ask-reset { display: none; margin-top: 4px; font-size: 12px;
  color: #8fb8d8; background: none; border: none; padding: 0; cursor: pointer; }
#ask-claude.has-history .ask-reset { display: inline; }
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

/** The user's message, with where the camera is so "here" means something. */
export function messageText(text, camera) {
  if (!camera) return text;
  return (
    `${text}\n\n(The globe camera is over ${camera.lat.toFixed(4)}, ` +
    `${camera.lon.toFixed(4)} at ${Math.round(camera.altitude_m)} m.)`
  );
}

/** Readable names for the actions in progress. */
const ACTION_LABELS = Object.freeze({
  fly_to_location: 'Flying',
  set_layer_visibility: 'Switching layers',
  track_entity: 'Tracking',
  control_cockpit: 'Cockpit',
  annotate_map: 'Drawing on the map',
  set_visual_style: 'Changing style',
  move_camera: 'Moving the camera',
  zoom_to_globe: 'Zooming out',
  adjust_camera_zoom: 'Zooming',
  control_scene: 'Scene',
  frame_overhead: 'Framing',
  analyst_query: 'Counting',
  get_entity_context: 'Reading the view',
  get_current_view_state: 'Reading the view',
});
const actionLabel = (name) => ACTION_LABELS[name] || name.replaceAll('_', ' ');

/**
 * A conversation with Claude that can operate the app. `run(name, input)`
 * performs an app action (the voice assistant's runner); `post(body)`
 * reaches /api/claude/ask and resolves to `{ status, payload }`.
 */
export function createClaudeConversation({ post, run }) {
  let history = [];

  const tooLong = () =>
    history.length > MAX_HISTORY_MESSAGES ||
    JSON.stringify(history).length > MAX_HISTORY_CHARS;

  async function runActions(pending, onProgress) {
    const results = [];
    for (const call of pending) {
      onProgress?.(`${actionLabel(call.name)}…`);
      let result;
      try {
        result = await run(call.name, call.input ?? {});
      } catch (error) {
        result = { ok: false, error: error?.message || 'The action failed' };
      }
      let content = JSON.stringify(result ?? { ok: true });
      if (content.length > MAX_RESULT_CHARS)
        content = `${content.slice(0, MAX_RESULT_CHARS)}… (truncated)`;
      results.push({ type: 'tool_result', tool_use_id: call.id, content });
    }
    return results;
  }

  return {
    get length() {
      return history.length;
    },
    reset() {
      history = [];
    },
    /**
     * Send one message and carry out what Claude does with it. Resolves to
     * `{ answer?, error?, view, actions }`, where `actions` counts the app
     * actions that ran.
     */
    async send(text, { camera = null, onProgress } = {}) {
      const startedOver = tooLong();
      if (startedOver) history = [];
      const before = history.length;
      history.push({ role: 'user', content: messageText(text, camera) });
      let actions = 0;
      let view = null;
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        let reply;
        try {
          reply = await post({ messages: history });
        } catch {
          history.length = before;
          return { error: 'Could not reach the app server.', view, actions };
        }
        const { status, payload } = reply;
        if (Array.isArray(payload?.messages)) history = [...payload.messages];
        if (payload?.view) view = payload.view;
        if (payload?.answer)
          return { answer: payload.answer, view, actions, startedOver };
        if (!payload?.pending?.length) {
          // A failed exchange is dropped whole; earlier turns stay as sent.
          history.length = before;
          return {
            error: payload?.error || `Request failed (${status})`,
            view,
            actions,
          };
        }
        const results = await runActions(payload.pending, onProgress);
        actions += results.length;
        history.push({
          role: 'user',
          content: [...(payload.results ?? []), ...results],
        });
      }
      history.length = before;
      return { error: 'Claude needed too many steps to finish', view, actions };
    },
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
 * A typed box where Claude answers questions and operates the app through
 * /api/claude/ask. Returns a function that removes it.
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
  input.placeholder = 'Ask Claude, or tell it what to do on the map';
  input.setAttribute('aria-label', 'Message for Claude');
  const button = documentRef.createElement('button');
  button.type = 'submit';
  button.textContent = 'Send';
  const output = documentRef.createElement('output');
  output.setAttribute('aria-live', 'polite');
  const reset = documentRef.createElement('button');
  reset.type = 'button';
  reset.className = 'ask-reset';
  reset.textContent = 'New chat';
  form.append(input, button);
  root.append(form, output, reset);
  documentRef.head.append(style);
  documentRef.body.append(root);

  const conversation = createClaudeConversation({
    run,
    post: async (body) => {
      const response = await fetchImpl(ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        payload: await response.json().catch(() => ({})),
      };
    },
  });
  const syncHistory = () =>
    root.classList.toggle('has-history', conversation.length > 0);

  // Keys typed here must not reach the app's keyboard shortcuts.
  const stopKeys = (event) => event.stopPropagation();
  input.addEventListener('keydown', stopKeys);

  const onSubmit = async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || button.disabled) return;
    button.disabled = true;
    output.textContent = 'Asking Claude…';
    const outcome = await conversation.send(text, {
      camera: cameraPosition(viewer),
      onProgress: (step) => {
        output.textContent = step;
      },
    });
    output.textContent =
      (outcome.startedOver ? '(Started a new chat.)\n' : '') +
      (outcome.answer || outcome.error);
    if (outcome.answer) input.value = '';
    // When Claude moved the app itself, its own camera work has the last word.
    if (outcome.answer && outcome.view && outcome.actions === 0)
      await showView(outcome.view, { viewer, dataManager, run });
    syncHistory();
    button.disabled = false;
    input.focus();
  };
  const onReset = () => {
    conversation.reset();
    output.textContent = '';
    syncHistory();
    input.focus();
  };
  form.addEventListener('submit', onSubmit);
  reset.addEventListener('click', onReset);

  return () => {
    form.removeEventListener('submit', onSubmit);
    reset.removeEventListener('click', onReset);
    input.removeEventListener('keydown', stopKeys);
    root.remove();
    style.remove();
  };
}
