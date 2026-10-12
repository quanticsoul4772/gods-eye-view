import * as Cesium from 'cesium';

const ASK_URL = '/api/claude/ask';
/** Server round trips per request; each one can run several app actions. */
const MAX_ROUNDS = 8;
/** A long conversation starts over rather than being trimmed (trimming edits history). */
const MAX_HISTORY_MESSAGES = 160;
const MAX_HISTORY_CHARS = 1_500_000;
/** Longest action result sent back; app state reads can be large. */
const MAX_RESULT_CHARS = 12_000;
/** Cockpit pop-up: first characters shown before "show more". */
export const COCKPIT_PREVIEW_CHARS = 140;
const COCKPIT_POPUP_MS = 10_000;
/** Statuses that mean Claude cannot be reached at all; shown in the composer. */
const SETUP_STATUSES = new Set([0, 403, 503]);
const VOICE_ON_NOTE = 'Voice is on — turn it off to type.';

const STYLE = `
#gev-voice-control { --gev-composer-h: 2.75rem; }
/* Bottom-right corner, below the voice readout's text row. */
#gev-ask-button { position: absolute; bottom: 0.12rem; right: 0.3rem; z-index: 4;
  width: 1.25rem; height: 0.9rem; padding: 0; display: grid; place-items: center;
  font: 600 0.62rem/1 var(--font-mono, monospace); color: rgba(54, 220, 255, 0.85);
  background: rgba(54, 220, 255, 0.08); border: 1px solid rgba(54, 220, 255, 0.35);
  border-radius: 0.22rem; cursor: pointer; }
#gev-ask-button:hover, #gev-ask-button[aria-expanded='true'] {
  background: rgba(54, 220, 255, 0.2); color: #dff5fa; }
#gev-ask-composer { position: absolute; bottom: calc(100% + 0.7rem); left: 50%;
  z-index: 8; box-sizing: border-box; width: min(22rem, calc(100vw - 1.5rem));
  transform: translateX(-50%); padding: 0.4rem; display: flex; flex-direction: column;
  gap: 0.3rem; background: rgba(7, 22, 31, 0.96);
  border: 1px solid rgba(54, 220, 255, 0.34); border-radius: 0.38rem;
  box-shadow: 0 0.85rem 2rem rgba(0, 0, 0, 0.58); }
#gev-ask-composer[hidden] { display: none; }
#gev-ask-composer .gev-ask-row { display: flex; gap: 0.3rem; align-items: center; }
#gev-ask-composer input { flex: 1; min-width: 0; font: 0.8rem/1.3 system-ui, sans-serif;
  color: #e8f4f8; background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 0.25rem; padding: 0.3rem 0.45rem; }
#gev-ask-composer button { font: 600 0.62rem/1 var(--font-mono, monospace);
  letter-spacing: 0.05rem; color: rgba(223, 245, 250, 0.92); cursor: pointer;
  background: rgba(54, 220, 255, 0.14); border: 1px solid rgba(54, 220, 255, 0.4);
  border-radius: 0.25rem; padding: 0.38rem 0.55rem; }
#gev-ask-composer button[disabled] { opacity: 0.45; cursor: default; }
#gev-ask-composer .gev-ask-new { position: relative; padding: 0.38rem 0.45rem; }
#gev-ask-composer .gev-ask-new[data-turns]::after { content: attr(data-turns);
  position: absolute; top: -0.35rem; right: -0.35rem; min-width: 0.8rem; padding: 0 0.15rem;
  font-size: 0.5rem; line-height: 0.8rem; color: #07161f; background: #36dcff;
  border-radius: 0.4rem; text-align: center; }
#gev-ask-composer .gev-ask-status { font: 0.68rem/1.35 system-ui, sans-serif;
  color: #b8c8d0; display: flex; gap: 0.4rem; align-items: center; }
#gev-ask-composer .gev-ask-status:empty { display: none; }
#gev-ask-composer .gev-ask-status[data-tone='warn'] { color: #ffc46b; }
#gev-ask-composer .gev-ask-cancel { margin-left: auto; padding: 0.25rem 0.45rem; }
#gev-ask-composer .gev-ask-cancel[hidden] { display: none; }
/* The composer stays put while you type; the card lifts above it. */
#gev-voice-control.composer-open .gev-voice-card {
  bottom: calc(100% + 1.1rem + var(--gev-composer-h)); }
#command-dock.dock-has-pinned-tray #gev-ask-composer {
  bottom: calc(100% + 1.7rem + var(--dock-pinned-stack-height)); }
#command-dock.dock-has-pinned-tray #gev-voice-control.composer-open .gev-voice-card {
  bottom: calc(100% + 2.1rem + var(--dock-pinned-stack-height) + var(--gev-composer-h)); }
#command-dock > #gev-voice-control:has(#gev-ask-composer:not([hidden])),
#command-dock > #gev-voice-control[data-typed]:has(.gev-voice-card:not([hidden])) {
  z-index: 101; }
/* A typed answer shows even while voice is in its error state. */
#gev-voice-control[data-typed][data-status='error'] .gev-voice-card:not([hidden]) {
  display: flex; }
#gev-voice-control[data-typed] .gev-voice-card-text { white-space: pre-wrap; }
@media (max-width: 900px) {
  #gev-voice-control .gev-voice-card, #gev-ask-composer {
    left: auto; right: 0; transform: none;
    width: min(22rem, calc(100vw - 1.5rem)); }
}
#gev-ask-cockpit { position: fixed; top: clamp(118px, 15vh, 156px); left: 50%;
  z-index: 60; transform: translateX(-50%); width: min(28vw, 22rem); min-width: 15rem;
  display: flex; flex-direction: column; gap: 0.35rem;
  font: 0.8rem/1.35 system-ui, sans-serif; color: #e8f4f8; }
#gev-ask-cockpit[hidden] { display: none; }
#gev-ask-cockpit input { width: 100%; box-sizing: border-box; font: inherit;
  color: inherit; background: rgba(7, 22, 31, 0.9); border: 1px solid rgba(54, 220, 255, 0.45);
  border-radius: 0.3rem; padding: 0.35rem 0.5rem; }
#gev-ask-cockpit .gev-ask-popup { max-height: 22vh; overflow-y: auto; white-space: pre-wrap;
  background: rgba(7, 22, 31, 0.9); border: 1px solid rgba(54, 220, 255, 0.3);
  border-radius: 0.3rem; padding: 0.4rem 0.55rem; cursor: pointer; }
#gev-ask-cockpit .gev-ask-popup:empty, #gev-ask-cockpit .gev-ask-popup[hidden] { display: none; }
body.ui-clean-view #gev-ask-cockpit, body.ui-embed #gev-ask-cockpit { display: none; }
`;

/** Readable names for actions, used where the voice card is not on screen. */
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
export const actionLabel = (name) =>
  ACTION_LABELS[name] || name.replaceAll('_', ' ');

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

/** `/` opens typing, unless a modifier is held or the user is already typing. */
export function isSlashShortcut(event) {
  if (event?.key !== '/' || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !event.target?.closest?.(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  );
}

/** Cockpit pop-up text: a short preview and whether there is more. */
export function cockpitPreview(text) {
  const clean = String(text || '').trim();
  return clean.length > COCKPIT_PREVIEW_CHARS
    ? { preview: `${clean.slice(0, COCKPIT_PREVIEW_CHARS - 1)}…`, more: true }
    : { preview: clean, more: false };
}

const isAbort = (error) => error?.name === 'AbortError';

/**
 * A conversation with Claude that can operate the app. `run(name, input,
 * { signal })` performs an app action (the voice assistant's runner);
 * `post(body, { signal })` reaches /api/claude/ask and resolves to
 * `{ status, payload }`.
 */
export function createClaudeConversation({ post, run }) {
  let history = [];

  const tooLong = () =>
    history.length > MAX_HISTORY_MESSAGES ||
    JSON.stringify(history).length > MAX_HISTORY_CHARS;

  async function runActions(
    pending,
    { signal, onActionStart, onActionResult },
  ) {
    const results = [];
    for (const call of pending) {
      signal?.throwIfAborted();
      onActionStart?.(call);
      let result;
      try {
        result = await run(call.name, call.input ?? {}, { signal });
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw error;
        result = { ok: false, error: error?.message || 'The action failed' };
      }
      onActionResult?.(call, result ?? { ok: true });
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
    /** Questions asked in this conversation. */
    get turns() {
      return history.filter(
        (message) =>
          message.role === 'user' && typeof message.content === 'string',
      ).length;
    },
    reset() {
      history = [];
    },
    /**
     * Send one message and carry out what Claude does with it. Resolves to
     * `{ answer? | error? | cancelled?, status?, setup?, view, actions,
     * startedOver }`. `setup` marks errors where Claude could not be
     * reached at all.
     */
    async send(
      text,
      { camera = null, signal, onActionStart, onActionResult } = {},
    ) {
      const startedOver = tooLong();
      if (startedOver) history = [];
      const before = history.length;
      history.push({ role: 'user', content: messageText(text, camera) });
      let actions = 0;
      let view = null;
      const fail = (fields) => {
        history.length = before;
        return { ...fields, view, actions, startedOver };
      };
      try {
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          let reply;
          try {
            reply = await post({ messages: history }, { signal });
          } catch (error) {
            if (isAbort(error) || signal?.aborted) throw error;
            return fail({
              error: 'Could not reach the app server.',
              status: 0,
              setup: true,
            });
          }
          const { status, payload } = reply;
          if (Array.isArray(payload?.messages)) history = [...payload.messages];
          if (payload?.view) view = payload.view;
          if (payload?.answer)
            return { answer: payload.answer, view, actions, startedOver };
          if (!payload?.pending?.length)
            return fail({
              error: payload?.error || `Request failed (${status})`,
              status,
              setup: SETUP_STATUSES.has(status),
            });
          const results = await runActions(payload.pending, {
            signal,
            onActionStart,
            onActionResult,
          });
          actions += results.length;
          history.push({
            role: 'user',
            content: [...(payload.results ?? []), ...results],
          });
        }
        return fail({ error: 'Claude needed too many steps to finish' });
      } catch (error) {
        if (isAbort(error) || signal?.aborted) return fail({ cancelled: true });
        throw error;
      }
    },
  };
}

/**
 * One typed turn, reported as voice-card events: a new turn, your message,
 * each action as a step, and Claude's reply. Errors where Claude could not be
 * reached are left to the caller (the composer shows them); refusals and
 * other turn errors become the reply line.
 */
export async function runTypedTurn({
  conversation,
  text,
  camera = null,
  emit,
  hold = () => {},
  isVoiceActive = () => false,
  signal,
}) {
  if (isVoiceActive()) return { refused: true };
  hold(true);
  try {
    emit({ type: 'interruption' });
    emit({ type: 'transcript', role: 'user', text, final: true, full: true });
    const outcome = await conversation.send(text, {
      camera,
      signal,
      onActionStart: (call) =>
        emit({
          type: 'action-call',
          callId: call.id,
          name: call.name,
          arguments: call.input ?? {},
        }),
      onActionResult: (call, result) =>
        emit({
          type: 'action-result',
          callId: call.id,
          name: call.name,
          result,
        }),
    });
    const reply = outcome.answer
      ? outcome.answer
      : outcome.cancelled
        ? 'Cancelled.'
        : outcome.setup
          ? null
          : outcome.error;
    if (reply)
      emit({
        type: 'transcript',
        role: 'assistant',
        text: outcome.startedOver ? `(Started a new chat.)\n${reply}` : reply,
        final: true,
        full: true,
      });
    return outcome;
  } finally {
    hold(false);
  }
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
 * Typing to Claude as the keyboard twin of the voice mic: a button in the
 * voice control and `/` open a composer above the dock; answers render in the
 * voice card. In Cockpit, which hides the dock, `/` opens a small field with a
 * short pop-up instead. Returns a function that removes everything.
 */
export function installAskClaude({
  viewer,
  dataManager,
  run,
  voiceCard = null,
  session = null,
  documentRef = globalThis.document,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  const control = documentRef.getElementById('gev-voice-control');
  if (!control) return () => {};
  const make = (tag, props = {}) =>
    Object.assign(documentRef.createElement(tag), props);

  const style = make('style', { textContent: STYLE });
  documentRef.head.append(style);

  // Dock: the type button and the composer live inside the voice control,
  // so Clean-UI and recording mode hide them with it.
  const typeButton = make('button', {
    id: 'gev-ask-button',
    type: 'button',
    textContent: '⌨',
    title: 'Type to Claude (/)',
  });
  typeButton.setAttribute('aria-label', 'Type to Claude');
  typeButton.setAttribute('aria-expanded', 'false');
  typeButton.setAttribute('aria-controls', 'gev-ask-composer');
  const composer = make('form', { id: 'gev-ask-composer', hidden: true });
  composer.setAttribute('aria-label', 'Type to Claude');
  const input = make('input', {
    type: 'text',
    maxLength: 500,
    placeholder: 'Ask Claude, or tell it what to do',
  });
  input.setAttribute('aria-label', 'Message for Claude');
  const send = make('button', { type: 'submit', textContent: 'SEND' });
  const newChat = make('button', {
    type: 'button',
    className: 'gev-ask-new',
    textContent: '↺',
    title: 'New chat — forget this conversation',
  });
  newChat.setAttribute('aria-label', 'New chat');
  const status = make('div', { className: 'gev-ask-status' });
  status.setAttribute('aria-live', 'polite');
  const statusText = make('span');
  const cancel = make('button', {
    type: 'button',
    className: 'gev-ask-cancel',
    textContent: 'CANCEL',
    hidden: true,
  });
  status.append(statusText, cancel);
  const row = make('div', { className: 'gev-ask-row' });
  row.append(input, send, newChat);
  composer.append(row, status);
  control.querySelector('#gev-voice-button')?.after(typeButton);
  control.append(composer);

  // Cockpit: a small field near the top, below the compass.
  const cockpitBox = make('div', { id: 'gev-ask-cockpit', hidden: true });
  const cockpitInput = make('input', {
    type: 'text',
    maxLength: 500,
    placeholder: 'Ask Claude (Esc cancels or closes)',
  });
  cockpitInput.setAttribute('aria-label', 'Message for Claude');
  const popup = make('div', { className: 'gev-ask-popup', hidden: true });
  popup.setAttribute('aria-live', 'polite');
  cockpitBox.append(cockpitInput, popup);
  documentRef.body.append(cockpitBox);

  const conversation = createClaudeConversation({
    run,
    post: async (body, { signal } = {}) => {
      const response = await fetchImpl(ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      return {
        status: response.status,
        payload: await response.json().catch(() => ({})),
      };
    },
  });

  let turn = null; // { controller, timer }
  const voiceActive = () => Boolean(session?.isActive?.());
  const inCockpit = () => documentRef.body.classList.contains('cockpit-mode');
  const setStatus = (text, tone = '') => {
    statusText.textContent = text;
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  };
  const syncGate = () => {
    const blocked = voiceActive();
    send.disabled = blocked || Boolean(turn);
    input.disabled = Boolean(turn);
    // Only the gate's own note is cleared here; a setup error has to stay.
    if (blocked && !turn) setStatus(VOICE_ON_NOTE, 'warn');
    else if (!turn && statusText.textContent === VOICE_ON_NOTE) setStatus('');
  };
  const syncTurns = () => {
    const count = conversation.turns;
    if (count) newChat.dataset.turns = String(count);
    else delete newChat.dataset.turns;
  };

  // Labels: typed turns say CLAUDE; the next voice event puts VOICE/GEV back.
  const kicker = control.querySelector('.gev-voice-card-kicker');
  const assistantWho = control.querySelector(
    '#gev-voice-card-assistant .gev-voice-card-who',
  );
  const setLabels = (typed) => {
    if (kicker) kicker.textContent = typed ? 'CLAUDE' : 'VOICE';
    if (assistantWho) assistantWho.textContent = typed ? 'CLAUDE' : 'GEV';
    if (typed) control.dataset.typed = '';
    else delete control.dataset.typed;
  };
  const unsubscribe = session?.subscribe?.((event) => {
    setLabels(false);
    // Voice starting mid-turn takes over: the typed turn stops.
    if (event.type === 'state' && !['idle', 'error'].includes(event.state))
      turn?.controller.abort();
    syncGate();
  });

  // Pinned trays stay: the composer already sits above the pinned stack.
  const openTrays = () =>
    [...documentRef.querySelectorAll('#location-bar, #control-panel')].filter(
      (tray) =>
        !tray.classList.contains('collapsed') &&
        !tray.classList.contains('dock-pinned'),
    );
  const openComposer = () => {
    // A dock popover and the composer would overlap; the popover gives way.
    for (const tray of openTrays())
      tray.querySelector('.dock-tray-toggle')?.click();
    composer.hidden = false;
    control.classList.add('composer-open');
    typeButton.setAttribute('aria-expanded', 'true');
    syncGate();
    syncTurns();
    input.focus();
  };
  const closeComposer = ({ restoreFocus = true } = {}) => {
    composer.hidden = true;
    control.classList.remove('composer-open');
    typeButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) typeButton.focus();
  };
  // A popover opening later closes the composer and keeps its own focus.
  const trayWatch = new MutationObserver(() => {
    if (!composer.hidden && openTrays().length)
      closeComposer({ restoreFocus: false });
  });
  for (const tray of documentRef.querySelectorAll(
    '#location-bar, #control-panel',
  ))
    trayWatch.observe(tray, { attributes: true, attributeFilter: ['class'] });

  /** Run one turn with progress, cancel and error routing. */
  async function startTurn(text, emit, { onDone } = {}) {
    if (turn || !text) return null;
    const controller = new AbortController();
    const started = Date.now();
    turn = {
      controller,
      timer: setInterval(() => {
        setStatus(`Thinking… ${Math.round((Date.now() - started) / 1000)} s`);
      }, 1000),
    };
    setStatus('Thinking…');
    cancel.hidden = false;
    syncGate();
    let outcome;
    try {
      outcome = await runTypedTurn({
        conversation,
        text,
        camera: cameraPosition(viewer),
        emit,
        hold: (on) => voiceCard?.hold?.(on),
        isVoiceActive: voiceActive,
        signal: controller.signal,
      });
    } finally {
      clearInterval(turn.timer);
      turn = null;
      cancel.hidden = true;
    }
    if (outcome.refused) setStatus(VOICE_ON_NOTE, 'warn');
    else if (outcome.setup) setStatus(outcome.error, 'warn');
    else setStatus('');
    syncGate();
    syncTurns();
    onDone?.(outcome);
    if (outcome.answer && outcome.view && outcome.actions === 0)
      await showView(outcome.view, { viewer, dataManager, run });
    return outcome;
  }

  const emitToCard = (event) => voiceCard?.handle?.(event);
  const onSubmit = async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      closeComposer();
      return;
    }
    setLabels(true);
    const outcome = await startTurn(text, emitToCard);
    if (outcome?.refused) setLabels(false);
    if (outcome?.answer) input.value = '';
    if (!composer.hidden) input.focus();
  };
  const onInputKey = (event) => {
    event.stopPropagation(); // keep typed keys away from app shortcuts
    if (event.key === 'Escape') {
      event.preventDefault();
      closeComposer();
    }
  };
  const onNewChat = () => {
    conversation.reset();
    syncTurns();
    setStatus('New chat.');
    input.focus();
  };
  const onTypeButton = () =>
    composer.hidden ? openComposer() : closeComposer();

  // Cockpit field: one-line progress, then a short reply that expands.
  let popupTimer = null;
  let popupFull = '';
  const showPopup = (text) => {
    popupFull = String(text || '');
    const { preview, more } = cockpitPreview(popupFull);
    popup.textContent = preview;
    popup.dataset.more = String(more);
    popup.title = more ? 'Click to show the whole answer' : '';
    popup.hidden = !preview;
    clearTimeout(popupTimer);
    if (preview)
      popupTimer = setTimeout(function hide() {
        if (popup.matches(':hover')) popupTimer = setTimeout(hide, 2000);
        else popup.hidden = true;
      }, COCKPIT_POPUP_MS);
  };
  const emitToPopup = (event) => {
    if (event.type === 'action-call') showPopup(`${actionLabel(event.name)}…`);
    if (event.type === 'transcript' && event.role === 'assistant')
      showPopup(event.text);
  };
  // A cockpit turn can end the cockpit ("exit cockpit"); what is left of it
  // then shows in the voice card, opened with the message that started it.
  const emitFromCockpit = (text) => {
    let inCard = false;
    return (event) => {
      if (!inCard && inCockpit()) return emitToPopup(event);
      if (!inCard) {
        inCard = true;
        setLabels(true);
        emitToCard({ type: 'interruption' });
        emitToCard({
          type: 'transcript',
          role: 'user',
          text,
          final: true,
          full: true,
        });
      }
      emitToCard(event);
    };
  };
  const openCockpitField = () => {
    cockpitBox.hidden = false;
    cockpitInput.focus();
  };
  const closeCockpitField = () => {
    cockpitBox.hidden = true;
    popup.hidden = true;
    cockpitInput.blur();
  };
  // Cockpit has no Cancel button: Escape cancels a running turn first, then
  // closes the field.
  let cockpitTurn = false;
  const onCockpitKey = async (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (cockpitTurn) turn?.controller.abort();
      else closeCockpitField();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = cockpitInput.value.trim();
    if (!text) return;
    if (voiceActive()) {
      showPopup(VOICE_ON_NOTE);
      return;
    }
    if (turn) return;
    cockpitTurn = true;
    showPopup('Thinking… Esc cancels.');
    let outcome;
    try {
      outcome = await startTurn(text, emitFromCockpit(text));
    } finally {
      cockpitTurn = false;
    }
    if (outcome?.setup) showPopup(outcome.error);
    if (outcome?.answer) cockpitInput.value = '';
  };
  const onPopupClick = () => {
    if (popup.dataset.more === 'true') {
      popup.textContent = popupFull;
      popup.dataset.more = 'false';
    }
  };
  const onCockpitChange = (event) => {
    if (!event.detail?.active) closeCockpitField();
  };

  const onDocumentKey = (event) => {
    if (!isSlashShortcut(event)) return;
    event.preventDefault();
    if (inCockpit()) openCockpitField();
    else openComposer();
  };

  composer.addEventListener('submit', onSubmit);
  input.addEventListener('keydown', onInputKey);
  newChat.addEventListener('click', onNewChat);
  cancel.addEventListener('click', () => turn?.controller.abort());
  typeButton.addEventListener('click', onTypeButton);
  cockpitInput.addEventListener('keydown', onCockpitKey);
  popup.addEventListener('click', onPopupClick);
  documentRef.addEventListener('keydown', onDocumentKey);
  globalThis.addEventListener?.('gev:cockpit-mode-changed', onCockpitChange);

  return () => {
    turn?.controller.abort();
    clearTimeout(popupTimer);
    trayWatch.disconnect();
    unsubscribe?.();
    documentRef.removeEventListener('keydown', onDocumentKey);
    globalThis.removeEventListener?.(
      'gev:cockpit-mode-changed',
      onCockpitChange,
    );
    setLabels(false);
    typeButton.remove();
    composer.remove();
    cockpitBox.remove();
    style.remove();
  };
}
