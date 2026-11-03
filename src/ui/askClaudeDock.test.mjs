import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';
import { useVoiceStore } from './stores/voice.js';
import { useAskClaudeStore } from './stores/askClaude.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import VoiceControl from './views/panels/VoiceControl.vue';
import { installAskClaude } from './askClaude.js';

const $ = (id) => document.getElementById(id);
const flush = async () => {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
};

/**
 * The dock's voice control on its own store, with Ask Claude installed over
 * a scripted /api/claude/ask.
 */
function harness(t, { replies = [], install = true } = {}) {
  document.body.replaceChildren();
  const pinia = createPinia();
  let ui = createTestVoiceUi({ pinia });
  const voiceStore = useVoiceStore(pinia);
  const store = useAskClaudeStore(pinia);
  const panelStore = usePanelChromeStore(pinia);
  const app = createApp({
    render: () =>
      voiceStore.view &&
      h(VoiceControl, { view: voiceStore.view, key: voiceStore.view.id }),
  }).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const cardEvents = [];
  const requests = [];
  let voiceOn = false;
  let listener = null;
  const session = {
    subscribe(fn) {
      listener = fn;
      return () => (listener = null);
    },
  };
  const previews = [];
  // The voice commands facade: its parts are read on each use.
  const voice = {
    session,
    isActive: () => voiceOn,
    voiceCard: { handle: (event) => cardEvents.push(event), hold() {} },
    voicePanel: { select: (view, options) => previews.push([view, options]) },
    previewEnabled: true,
    getVoicePreferences: () => ({ previewEnabled: voice.previewEnabled }),
  };
  const options = {
    viewer: { camera: {} },
    dataManager: { isEnabled: () => true },
    run: async () => ({ ok: true }),
    voice,
    documentRef: document,
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      const next = replies.shift() ?? { answer: 'Done.' };
      return { status: 200, json: async () => next };
    },
    store,
    panelStore,
    voiceStore,
  };
  const remove = install ? installAskClaude(options) : null;
  if (remove) t.after(remove);
  return {
    pinia,
    store,
    panelStore,
    cardEvents,
    requests,
    previews,
    voice,
    remove,
    options,
    setVoiceOn(on) {
      voiceOn = on;
      listener?.({ type: 'state', state: on ? 'listening' : 'idle' });
    },
    replaceVoiceControl() {
      ui = createTestVoiceUi({ pinia });
    },
    ui: () => ui,
  };
}

test('the type button renders with the voice control, whenever it renders', async (t) => {
  const { remove, options } = harness(t, { install: false });
  await flush();
  assert.equal($('gev-ask-button'), null, 'nothing before Ask Claude installs');
  // Installing before the dock renders is the order the app starts in; the
  // button follows the store, not the element present at install.
  const removeAsk = installAskClaude(options);
  t.after(removeAsk);
  await flush();
  assert.ok($('gev-voice-control').contains($('gev-ask-button')));
  assert.equal(remove, null);
});

test('a newer voice control keeps the type button and an open composer', async (t) => {
  const { replaceVoiceControl } = harness(t);
  await flush();
  $('gev-ask-button').click();
  await flush();
  replaceVoiceControl();
  await flush();
  assert.ok($('gev-ask-button'));
  assert.equal($('gev-ask-composer').hidden, false);
  assert.ok($('gev-voice-control').classList.contains('composer-open'));
});

test('the button and / open the composer; Escape closes it', async (t) => {
  harness(t);
  await flush();
  assert.equal($('gev-ask-composer').hidden, true);
  $('gev-ask-button').click();
  await flush();
  assert.equal($('gev-ask-composer').hidden, false);
  assert.equal($('gev-ask-button').getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, $('gev-ask-input'));
  $('gev-ask-input').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await flush();
  assert.equal($('gev-ask-composer').hidden, true);
  assert.equal(document.activeElement, $('gev-ask-button'));
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: '/', bubbles: true }),
  );
  await flush();
  assert.equal($('gev-ask-composer').hidden, false);
});

test('a typed turn runs in the voice card under CLAUDE and clears the composer', async (t) => {
  const { cardEvents, requests } = harness(t, {
    replies: [{ answer: 'Flights are on.' }],
  });
  await flush();
  $('gev-ask-button').click();
  await flush();
  $('gev-ask-input').value = 'Turn on flights';
  $('gev-ask-composer').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[0].content, 'Turn on flights');
  assert.deepEqual(
    cardEvents.map((event) => [event.type, event.role, event.text]),
    [
      ['interruption', undefined, undefined],
      ['transcript', 'user', 'Turn on flights'],
      ['transcript', 'assistant', 'Flights are on.'],
    ],
  );
  assert.equal(
    document.querySelector('.gev-voice-card-kicker').textContent,
    'CLAUDE',
  );
  assert.ok($('gev-voice-control').hasAttribute('data-typed'));
  assert.equal($('gev-ask-input').value, '');
  assert.equal(document.querySelector('.gev-ask-new').dataset.turns, '1');
});

test('typing waits while a voice session is live, and voice puts its labels back', async (t) => {
  const { setVoiceOn } = harness(t);
  await flush();
  $('gev-ask-button').click();
  await flush();
  setVoiceOn(true);
  await flush();
  const send = $('gev-ask-composer').querySelector('button[type="submit"]');
  assert.equal(send.disabled, true);
  assert.match($('gev-ask-composer').textContent, /Voice is on/);
  assert.equal(
    document.querySelector('.gev-voice-card-kicker').textContent,
    'VOICE',
  );
  setVoiceOn(false);
  await flush();
  assert.equal(send.disabled, false);
  assert.doesNotMatch($('gev-ask-composer').textContent, /Voice is on/);
});

test('a dock popover opening closes the composer; a pinned tray does not', async (t) => {
  const { panelStore } = harness(t);
  await flush();
  const token = panelStore.connect({});
  $('gev-ask-button').click();
  await flush();
  panelStore.publish(token, 'location-bar', { collapsed: false, pinned: true });
  await flush();
  assert.equal($('gev-ask-composer').hidden, false);
  panelStore.publish(token, 'control-panel', { collapsed: false });
  await flush();
  assert.equal($('gev-ask-composer').hidden, true);
});

test('removing Ask Claude takes the button and composer away', async (t) => {
  const { remove } = harness(t);
  await flush();
  remove();
  await flush();
  assert.equal($('gev-ask-button'), null);
  assert.equal($('gev-ask-composer'), null);
  assert.equal($('gev-ask-cockpit'), null);
});

test('a typed turn opens the Voice panel preview, unless Preview is off', async (t) => {
  const { previews, voice } = harness(t, {
    replies: [{ answer: 'One.' }, { answer: 'Two.' }],
  });
  await flush();
  $('gev-ask-button').click();
  await flush();
  const ask = async (text) => {
    $('gev-ask-input').value = text;
    $('gev-ask-composer').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
  };
  await ask('first');
  assert.deepEqual(previews, [['preview', { automatic: true }]]);
  voice.previewEnabled = false;
  await ask('second');
  assert.equal(previews.length, 1);
});

test('after the voice provider changes, turns reach the new card and session', async (t) => {
  const { voice, cardEvents, setVoiceOn } = harness(t, {
    replies: [{ answer: 'New card.' }],
  });
  await flush();
  const newEvents = [];
  let newListener = null;
  voice.voiceCard = { handle: (event) => newEvents.push(event), hold() {} };
  voice.session = {
    subscribe(fn) {
      newListener = fn;
      return () => (newListener = null);
    },
  };
  $('gev-ask-button').click();
  await flush();
  $('gev-ask-input').value = 'hello';
  $('gev-ask-composer').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.equal(cardEvents.length, 0);
  assert.equal(newEvents.at(-1).text, 'New card.');
  // The new session's events now put the voice labels back.
  assert.ok(newListener);
  newListener({ type: 'state', state: 'listening' });
  await flush();
  assert.equal(
    document.querySelector('.gev-voice-card-kicker').textContent,
    'VOICE',
  );
  setVoiceOn(false);
});

test('a provider change mid-turn follows the new session, whose voice stops the turn', async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { voice, cardEvents, replaceVoiceControl, options } = harness(t, {
    install: false,
  });
  // A server that answers only when released, so the turn is still running.
  t.after(
    installAskClaude({
      ...options,
      fetchImpl: async (url, init) => {
        await held;
        init.signal?.throwIfAborted();
        return { status: 200, json: async () => ({ answer: 'late' }) };
      },
    }),
  );
  await flush();
  $('gev-ask-button').click();
  await flush();
  $('gev-ask-input').value = 'slow question';
  $('gev-ask-composer').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  // The provider changes: a new session, presented with a new control.
  let newListener = null;
  voice.session = {
    subscribe(fn) {
      newListener = fn;
      return () => (newListener = null);
    },
  };
  replaceVoiceControl();
  await flush();
  assert.ok(newListener, 'the new session is followed without a new turn');
  newListener({ type: 'state', state: 'connecting' });
  release();
  await flush();
  assert.equal(cardEvents.at(-1).text, 'Cancelled.');
});

test('a turn finishing after removal does not bring the composer back', async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { options, store } = harness(t, { install: false });
  const remove = installAskClaude({
    ...options,
    fetchImpl: async () => {
      await held;
      return { status: 200, json: async () => ({ answer: 'late' }) };
    },
  });
  await flush();
  $('gev-ask-button').click();
  await flush();
  $('gev-ask-input').value = 'question';
  $('gev-ask-composer').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  remove();
  release();
  await flush();
  assert.equal(store.view, null);
  assert.equal($('gev-ask-button'), null);
});
