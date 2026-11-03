import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { installVueDom } from '../testSupport/vueDom.mjs';

let PanelNavigation;
let createUiRuntime;
let nextTick;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ nextTick } = await import('vue'));
  ({ PanelNavigation } = await import('./panelNavigation.js'));
  ({ createUiRuntime } = await import('./vueRuntime.js'));
});
after(() => uninstall());

function panel(id, { collapsed = true, hidden = false, title = '' } = {}) {
  const element = document.createElement('div');
  element.id = id;
  element.dataset.panelId = id;
  element.className = collapsed
    ? 'panel-collapsible collapsed'
    : 'panel-collapsible';
  // Data Layers shows only while `active` (the `f` shortcut toggles it).
  if (id === 'data-panel') element.classList.add('active');
  element.hidden = hidden;
  if (title) element.innerHTML = `<span class="panel-title">${title}</span>`;
  return element;
}

function setup() {
  document.body.innerHTML = '';
  const left = document.createElement('div');
  left.id = 'left-panel-stack';
  left.append(panel('data-panel', { collapsed: false }), panel('scene-panel'));
  const right = document.createElement('div');
  right.id = 'right-context-rail';
  right.append(
    panel('pp-toggles'),
    panel('weather-panel', { hidden: true }),
    panel('global-context-panel'),
    panel('host-panel', { title: 'HOST' }),
  );
  document.body.append(left, right);
  const calls = [];
  const ui = createUiRuntime();
  const navigation = new PanelNavigation({
    ui,
    stacks: { left, right },
    setPanelCollapsed: (...args) => calls.push(args),
  });
  navigation.init();
  return { left, right, calls, ui, navigation };
}

const railItems = (stack) =>
  [...stack.querySelectorAll('.gev-panel-rail [data-rail-item]')].map(
    (button) => [button.dataset.railItem, button.getAttribute('aria-pressed')],
  );

test('each stack gets a rail of its offered panels, marking the open one', async () => {
  const { left, right, ui, navigation } = setup();
  await nextTick();
  assert.equal(
    left.firstElementChild.className,
    'gev-panel-rail gev-panel-rail--left',
  );
  assert.deepEqual(railItems(left), [
    ['data-panel', 'true'],
    ['scene-panel', 'false'],
  ]);
  // Hidden panels are not offered; a host's panel gets a generic item.
  assert.deepEqual(railItems(right), [
    ['pp-toggles', 'false'],
    ['global-context-panel', 'false'],
    ['host-panel', 'false'],
  ]);
  assert.equal(
    right
      .querySelector('[data-rail-item="host-panel"]')
      .getAttribute('aria-label'),
    'HOST',
  );
  assert.equal(
    left.querySelector('nav').getAttribute('aria-label'),
    'Left panels',
  );
  navigation.destroy();
  ui.destroy();
});

test('selecting an item toggles its panel explicitly', async () => {
  const { left, calls, ui, navigation } = setup();
  await nextTick();
  left.querySelector('[data-rail-item="scene-panel"]').click();
  left.querySelector('[data-rail-item="data-panel"]').click();
  assert.deepEqual(calls, [
    ['scene-panel', false, { explicit: true }],
    ['data-panel', true, { explicit: true }],
  ]);
  navigation.destroy();
  ui.destroy();
});

test('selecting right after a same-task collapse reads the panel, not the store', async () => {
  const { left, calls, ui, navigation } = setup();
  await nextTick();
  // A host collapses Data Layers and selects its item in one task, before
  // the store follows the class change.
  left.querySelector('#data-panel').classList.add('collapsed');
  navigation.select('data-panel');
  assert.deepEqual(calls, [['data-panel', false, { explicit: true }]]);
  navigation.destroy();
  ui.destroy();
});

test('the rails follow disclosure and availability changes', async () => {
  const { left, right, ui, navigation } = setup();
  document.getElementById('data-panel').classList.add('collapsed');
  document.getElementById('scene-panel').classList.remove('collapsed');
  document.getElementById('weather-panel').hidden = false;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.deepEqual(railItems(left), [
    ['data-panel', 'false'],
    ['scene-panel', 'true'],
  ]);
  assert.deepEqual(railItems(right), [
    ['pp-toggles', 'false'],
    ['weather-panel', 'false'],
    ['global-context-panel', 'false'],
    ['host-panel', 'false'],
  ]);
  // `f` hides Data Layers outright, so the rail stops offering it.
  document.getElementById('data-panel').classList.remove('active');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.deepEqual(railItems(left), [['scene-panel', 'true']]);
  navigation.destroy();
  ui.destroy();
});

test('destroy removes the rails and stops following the stacks', async () => {
  const { left, right, calls, ui, navigation } = setup();
  navigation.destroy();
  navigation.destroy();
  assertSameNode(left.querySelector('.gev-panel-rail'), null);
  assertSameNode(right.querySelector('.gev-panel-rail'), null);
  navigation.select('data-panel');
  assert.deepEqual(calls, []);
  ui.destroy();
});

/**
 * Rails whose disclosure acts on the panels' classes, as PanelChrome's does,
 * with peeking on unless `peek` says otherwise.
 */
function peekSetup({ peek = () => true } = {}) {
  document.body.innerHTML = '';
  const left = document.createElement('div');
  left.append(panel('data-panel'), panel('scene-panel'));
  document.body.append(left);
  const calls = [];
  const ui = createUiRuntime();
  const navigation = new PanelNavigation({
    ui,
    stacks: { left, right: null },
    setPanelCollapsed: (panelId, collapsed, options) => {
      calls.push([panelId, collapsed, options]);
      // One open panel per side.
      for (const other of left.querySelectorAll('[data-panel-id]'))
        if (!collapsed && other.id !== panelId)
          other.classList.add('collapsed');
      document.getElementById(panelId).classList.toggle('collapsed', collapsed);
    },
    peekOnHover: peek,
  });
  navigation.init();
  return { left, calls, ui, navigation };
}

const PEEK = { persist: false, syncShare: false };
const pointer = (target, type, relatedTarget = null) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget }));

test('resting on a rail item peeks its panel open; leaving closes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { left, calls, ui, navigation } = peekSetup();
  await nextTick();
  const item = left.querySelector('[data-rail-item="scene-panel"]');
  pointer(item, 'pointerover');
  t.mock.timers.tick(199);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [['scene-panel', false, PEEK]]);
  pointer(item, 'pointerout', document.body);
  t.mock.timers.tick(599);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(calls.at(-1), ['scene-panel', true, PEEK]);
  navigation.destroy();
  ui.destroy();
});

test('leaving the item before the delay opens nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { left, calls, ui, navigation } = peekSetup();
  await nextTick();
  const item = left.querySelector('[data-rail-item="scene-panel"]');
  pointer(item, 'pointerover');
  t.mock.timers.tick(100);
  pointer(item, 'pointerout', document.body);
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, []);
  navigation.destroy();
  ui.destroy();
});

test('a peeked panel stays open while the pointer is on it, and once pressed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { left, calls, ui, navigation } = peekSetup();
  await nextTick();
  const item = left.querySelector('[data-rail-item="scene-panel"]');
  const scene = document.getElementById('scene-panel');
  pointer(item, 'pointerover');
  t.mock.timers.tick(200);
  // Item to panel, across the gap between them.
  pointer(item, 'pointerout', left);
  t.mock.timers.tick(300);
  pointer(scene, 'pointerover');
  t.mock.timers.tick(1000);
  assert.equal(calls.length, 1);
  pointer(scene, 'pointerdown');
  pointer(scene, 'pointerout', document.body);
  t.mock.timers.tick(1000);
  // Pressing keeps it as if the person had opened it: saved and shared.
  assert.deepEqual(calls, [
    ['scene-panel', false, PEEK],
    ['scene-panel', false, { explicit: true }],
  ]);
  assert.equal(scene.classList.contains('collapsed'), false);
  navigation.destroy();
  ui.destroy();
});

test('selecting a peeked item keeps its panel open, explicitly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { left, calls, ui, navigation } = peekSetup();
  await nextTick();
  const item = left.querySelector('[data-rail-item="scene-panel"]');
  pointer(item, 'pointerover');
  t.mock.timers.tick(200);
  item.click();
  pointer(item, 'pointerout', document.body);
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [
    ['scene-panel', false, PEEK],
    ['scene-panel', false, { explicit: true }],
  ]);
  navigation.destroy();
  ui.destroy();
});

test('no peek outside Professional, or over a panel the person opened', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let active = false;
  const { left, calls, ui, navigation } = peekSetup({ peek: () => active });
  await nextTick();
  const scene = left.querySelector('[data-rail-item="scene-panel"]');
  pointer(scene, 'pointerover');
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, []);
  active = true;
  left.querySelector('[data-rail-item="data-panel"]').click();
  pointer(scene, 'pointerover');
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [['data-panel', false, { explicit: true }]]);
  navigation.destroy();
  ui.destroy();
});

test('crossing another item on the way out opens nothing and closes the peek', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { left, calls, ui, navigation } = peekSetup();
  await nextTick();
  const scene = left.querySelector('[data-rail-item="scene-panel"]');
  const data = left.querySelector('[data-rail-item="data-panel"]');
  pointer(scene, 'pointerover');
  t.mock.timers.tick(200);
  pointer(scene, 'pointerout', data);
  pointer(data, 'pointerover');
  t.mock.timers.tick(50);
  pointer(data, 'pointerout', document.body);
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [
    ['scene-panel', false, PEEK],
    ['scene-panel', true, PEEK],
  ]);
  navigation.destroy();
  ui.destroy();
});

test('clicking an open panel’s item closes it for good', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { left, calls, ui, navigation } = peekSetup();
  await nextTick();
  const item = left.querySelector('[data-rail-item="scene-panel"]');
  item.click();
  pointer(item, 'pointerover');
  t.mock.timers.tick(100);
  item.click();
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [
    ['scene-panel', false, { explicit: true }],
    ['scene-panel', true, { explicit: true }],
  ]);
  navigation.destroy();
  ui.destroy();
});
