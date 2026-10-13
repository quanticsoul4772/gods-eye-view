// Rail panels open on hover and close when the pointer leaves, unless the
// panel is pinned (src/ui/panelChrome.js _initRailHoverPanels). The pin rule is
// createHoverDisclosure's `isPinned` option; these drive it with fake timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHoverDisclosure } from './panelDisclosure.js';

function rig({ pinned = () => false } = {}) {
  const timers = new Map();
  let nextId = 1;
  const window = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    performance: { now: () => 10_000 },
  };
  const document = { defaultView: window, activeElement: null };
  const listeners = new Map();
  const classes = new Set(['collapsed']);
  let hovered = false;
  const panel = {
    ownerDocument: document,
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
    matches: (sel) => (sel === ':hover' ? hovered : false),
    contains: () => false,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const changes = [];
  const controller = createHoverDisclosure({
    panel,
    documentRef: document,
    openDelayMs: 200,
    closeDelayMs: 600,
    isPinned: pinned,
    onChange: (collapsed, options) => {
      changes.push({ collapsed, explicit: Boolean(options?.explicit) });
      if (collapsed) classes.add('collapsed');
      else classes.delete('collapsed');
    },
    onEscape: () => {},
  });
  const runTimers = () => {
    for (const [id, t] of [...timers]) {
      timers.delete(id);
      t.fn();
    }
  };
  return {
    controller,
    changes,
    collapsed: () => classes.has('collapsed'),
    enter() {
      hovered = true;
      listeners.get('pointerenter')({ pointerType: 'mouse' });
    },
    leave() {
      hovered = false;
      listeners.get('pointerleave')({ pointerType: 'mouse' });
    },
    runTimers,
  };
}

test('hovering opens a rail panel and leaving closes it', () => {
  const r = rig();
  r.enter();
  r.runTimers();
  assert.equal(r.collapsed(), false, 'hover opens');
  assert.deepEqual(r.changes, [{ collapsed: false, explicit: false }]);
  r.leave();
  r.runTimers();
  assert.equal(r.collapsed(), true, 'leaving closes');
  r.controller.destroy();
});

test('a pinned panel stays open when the pointer leaves', () => {
  let pinned = false;
  const r = rig({ pinned: () => pinned });
  r.enter();
  r.runTimers();
  pinned = true; // pressed inside the open panel
  r.leave();
  r.runTimers();
  assert.equal(r.collapsed(), false, 'pinned panel must stay open');
  r.controller.destroy();
});

test('the default pin is the dock pin class', () => {
  const r = rig({ pinned: undefined });
  r.enter();
  r.runTimers();
  r.leave();
  r.runTimers();
  assert.equal(r.collapsed(), true, 'an unpinned dock tray still closes');
  r.controller.destroy();
});
