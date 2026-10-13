/** Browser-free layout vocabulary shared by UI and server-side voice tools. */
export const HUD_LAYOUTS = Object.freeze([
  'professional',
  'tactical',
  'operator',
  'minimal',
  'cyber',
]);

/**
 * Professional: the spy-satellite chrome (classification banner, mission and
 * sensor designators, scope) is fiction on public data, so the default shows
 * only measured readouts on plain plates. Tactical keeps the original look.
 */
export const DEFAULT_HUD_LAYOUT = 'professional';

/**
 * Layouts whose four corner readouts sit beside the panel rails, so the rails
 * collapse later panels rather than cover them. Professional keeps Tactical's
 * corners; only their styling differs.
 * @param {unknown} layout
 * @returns {boolean}
 */
export function railsYieldToHudCorners(layout) {
  return layout === 'tactical' || layout === 'professional';
}
