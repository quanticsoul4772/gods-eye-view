export const HUD_LAYOUTS = Object.freeze(['tactical', 'minimal', 'cyber']);

/** The layout a first run and an absent share-link field mean. */
export const DEFAULT_HUD_LAYOUT = 'tactical';

/**
 * Layouts whose four corner readouts sit beside the panel rails, so the rails
 * collapse later panels rather than cover them.
 * @param {unknown} layout
 * @returns {boolean}
 */
export function railsYieldToHudCorners(layout) {
  return layout === 'tactical';
}
