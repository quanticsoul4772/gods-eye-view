/**
 * Shared-vehicle glyphs for the bike-share layer's vehicles mode, as SVG data
 * URIs for Cesium billboards. Drawn white with a dark hairline, like
 * `transitIcons.js`, so `billboard.color` tints them by form factor; three
 * shapes keep the kinds apart by outline, not only by colour.
 */

const STROKE =
  'stroke="rgba(0,0,0,0.45)" stroke-width="2" stroke-linejoin="round"';

const BODIES = {
  // A bicycle seen from above: two wheels and a frame bar.
  bicycle: `
    <circle cx="16" cy="30" r="11" fill="white" ${STROKE}/>
    <circle cx="48" cy="30" r="11" fill="white" ${STROKE}/>
    <path d="M16,30 L30,18 L48,30 M30,18 L34,30" fill="none" stroke="white"
          stroke-width="5" stroke-linecap="round"/>`,
  // A kick scooter or moped: a deck with a stem.
  scooter: `
    <path d="M10,40 L46,40 L50,14 L56,14" fill="none" stroke="white"
          stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="12" cy="44" r="7" fill="white" ${STROKE}/>
    <circle cx="48" cy="44" r="7" fill="white" ${STROKE}/>`,
  // Anything else (car, other, unknown): a rounded tile.
  other: `
    <rect x="12" y="10" width="40" height="44" rx="10" fill="white" ${STROKE}/>`,
};

/** The glyph kind for a GBFS form factor. */
export function sharedVehicleGlyph(formFactor) {
  if (formFactor === 'bicycle' || formFactor === 'cargo_bicycle')
    return 'bicycle';
  if (
    formFactor === 'scooter_standing' ||
    formFactor === 'scooter_seated' ||
    formFactor === 'moped'
  )
    return 'scooter';
  return 'other';
}

/** Tint per form factor; unknown and other share the neutral grey. */
export const SHARED_VEHICLE_COLORS = Object.freeze({
  bicycle: '#4fc3f7',
  cargo_bicycle: '#26a69a',
  scooter_standing: '#ffca28',
  scooter_seated: '#ffa726',
  moped: '#ff7043',
  car: '#ba68c8',
  other: '#b0bec5',
  unknown: '#b0bec5',
});

const cache = new Map();

/** The data URI for a glyph kind (`bicycle`, `scooter`, `other`). */
export function sharedVehicleIcon(kind) {
  const k = BODIES[kind] ? kind : 'other';
  let uri = cache.get(k);
  if (!uri) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 64 64">${BODIES[k]}</svg>`;
    uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    cache.set(k, uri);
  }
  return uri;
}
