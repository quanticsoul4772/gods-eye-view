// The Professional HUD layout: the default, carried on <html> so it can style
// the whole shell, and styled only from src/ui/styles/professional.css with
// every rule scoped to it, so the other layouts keep the original look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyHudUiTheme,
  DEFAULT_HUD_LAYOUT,
  HUD_LAYOUTS,
  railsYieldToHudCorners,
} from './hudLayouts.js';
import { shouldHideCollapsedRightPanels } from './ui/panelRailGeometry.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Professional is the default layout', () => {
  assert.equal(DEFAULT_HUD_LAYOUT, 'professional');
  assert.ok(HUD_LAYOUTS.includes('professional'));
  assert.match(
    read('./ui/templates/display-controls.html'),
    /<option value="professional">Professional<\/option>/,
  );
});

test('every layout is exposed on the root element', () => {
  for (const layout of HUD_LAYOUTS) {
    const root = { dataset: {} };
    applyHudUiTheme(root, layout);
    assert.equal(root.dataset.hudLayout, layout);
  }
  const root = { dataset: {} };
  applyHudUiTheme(root, 'nonsense');
  assert.equal(root.dataset.hudLayout, DEFAULT_HUD_LAYOUT);
});

test('Professional keeps Tactical rail behaviour around the corner readouts', () => {
  assert.equal(railsYieldToHudCorners('professional'), true);
  assert.equal(railsYieldToHudCorners('tactical'), true);
  assert.equal(railsYieldToHudCorners('minimal'), false);
  assert.equal(
    shouldHideCollapsedRightPanels({
      hudVariant: 'professional',
      hasExpandedPanel: true,
    }),
    true,
  );
});

test('every Professional rule is scoped to the Professional layout', () => {
  const css = read('./ui/styles/professional.css').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1]);
  assert.ok(rules.length > 5, 'professional.css has no rules');
  for (const selectorList of rules) {
    // Split on top-level commas only (not inside :is(...)).
    for (const selector of selectorList.split(/,(?![^(]*\))/)) {
      assert.match(
        selector.trim(),
        /^:root\[data-hud-layout='professional'\]/,
        `unscoped selector: ${selector.trim()}`,
      );
    }
  }
  assert.match(
    read('../style.css'),
    /@import '\.\/src\/ui\/styles\/professional\.css';/,
  );
});

test('the HUD no longer prints fictional classification or designators', () => {
  const hud = read('./hud.js');
  assert.doesNotMatch(hud, /TOP SECRET|NOFORN|KH11|OPS-|PAGE 1\/1/);
  assert.doesNotMatch(hud, /hud-bracket|hud-classification|hud-system/);
});
