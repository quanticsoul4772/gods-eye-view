// Pure and dependency-free: the AI tools import it too.

/**
 * Where a product actually has data, when its image extent is padded to 2:1
 * (EUMETSAT's 70°W–70°E disc). Coverage checks, the globe imagery rectangle
 * and detail windows use this; whole images and shells use `bounds`.
 */
export const WEATHER_DATA_BOUNDS = Object.freeze({
  'lightning-eu': Object.freeze({ west: -70, south: -70, east: 70, north: 70 }),
  'radar-ca': Object.freeze({ west: -171, south: 16, east: -49, north: 68 }),
  'precip-global': Object.freeze({
    west: -180,
    south: -90,
    east: 180,
    north: 90,
  }),
  // DWD advertises its own box; this is the fallback (the 180 km range).
  'radar-de': Object.freeze({ west: 1, south: 45.4, east: 19.2, north: 56.5 }),
  'radar-fi': Object.freeze({
    west: 15.3,
    south: 57.1,
    east: 42.7,
    north: 70.8,
  }),
  'radar-nl': Object.freeze({
    west: 0,
    south: 48.9,
    east: 10.86,
    north: 55.98,
  }),
});

/** The box a snapshot has data in: its advertised data bounds, else its bounds. */
export const weatherCoverage = (snapshot) =>
  snapshot?.dataBounds ??
  WEATHER_DATA_BOUNDS[snapshot?.product] ??
  snapshot?.bounds ??
  null;
