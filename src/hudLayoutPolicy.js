export const HUD_LAYOUTS = Object.freeze([
  'tactical',
  'minimal',
  'cyber',
  'professional',
]);

/** The layout a first run uses. */
export const DEFAULT_HUD_LAYOUT = 'professional';

/**
 * The layout a share link without a layout field means. Links written before
 * Professional existed were authored in Tactical, so this stays frozen.
 */
export const SHARE_ABSENT_HUD_LAYOUT = 'tactical';

/**
 * Layouts whose four corner readouts sit beside the panel rails, so the rails
 * collapse later panels rather than cover them.
 * @param {unknown} layout
 * @returns {boolean}
 */
export function railsYieldToHudCorners(layout) {
  return layout === 'tactical' || layout === 'professional';
}
