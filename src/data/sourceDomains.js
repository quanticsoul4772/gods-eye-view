/**
 * The source-directory domains the app knows, in one place: the decoder
 * format each needs, whether the app shows it or only refers to it, the
 * `find_data_sources` topic that asks for it, the noun an answer names it by,
 * and the coverage class that bounds how large its area may be. Adding a
 * domain starts here. App-owned on purpose: the directory's own coverage
 * classes never widen these limits.
 */
export const TRANSIT_DOMAIN = 'transit.vehicles';
export const BIKESHARE_DOMAIN = 'bikeshare.stations';
export const CAMERAS_DOMAIN = 'cameras.stills';
export const SHAREDMOBILITY_DOMAIN = 'sharedmobility.vehicles';
export const EARTHQUAKES_DOMAIN = 'hazards.earthquakes';
export const DISASTERS_DOMAIN = 'hazards.disasters';
export const FIRES_DOMAIN = 'hazards.fires';
export const PERIMETERS_DOMAIN = 'hazards.perimeters';
export const AIRQUALITY_DOMAIN = 'airquality.sensors';

/**
 * Largest plausible area per coverage class, [latitude, longitude] in degrees;
 * null = the whole globe. Shared with the directory through the conformance
 * cases (`src/data/sourceConformance.json`).
 */
export const COVERAGE_LIMITS = Object.freeze({
  regional: Object.freeze([20, 30]),
  national: Object.freeze([60, 90]),
  global: null,
});

export const SOURCE_DOMAINS = Object.freeze([
  Object.freeze({
    domain: TRANSIT_DOMAIN,
    format: 'gtfs-rt.vehicle-positions',
    topic: 'transit',
    noun: 'transit',
    shown: true,
    // National feeds are answered per view (Amtrak spans about 52°).
    coverage: 'national',
  }),
  Object.freeze({
    domain: BIKESHARE_DOMAIN,
    format: 'gbfs.station-status',
    topic: 'bikeshare',
    noun: 'bike-share',
    shown: true,
    coverage: 'regional',
  }),
  Object.freeze({
    domain: SHAREDMOBILITY_DOMAIN,
    format: 'gbfs.vehicle-status',
    topic: 'sharedmobility',
    noun: 'shared vehicle',
    shown: true,
    coverage: 'regional',
  }),
  // Referral only: the camera lists the directory carries duplicate the
  // built-in CCTV packs, so the app names them but never draws them.
  Object.freeze({
    domain: CAMERAS_DOMAIN,
    format: 'cameras.list',
    topic: 'cameras',
    noun: 'traffic camera',
    shown: false,
    coverage: 'regional',
    note: 'duplicates the built-in CCTV packs',
  }),
  // Worldwide domains are named when asked for hazards, never for a place.
  Object.freeze({
    domain: EARTHQUAKES_DOMAIN,
    format: 'geojson.earthquakes',
    topic: 'hazards',
    noun: 'earthquake feed',
    shown: false,
    coverage: 'global',
    note: "shown by the app's earthquake layer",
  }),
  Object.freeze({
    domain: DISASTERS_DOMAIN,
    format: 'geojson.gdacs-events',
    topic: 'hazards',
    noun: 'disaster alert',
    shown: false,
    coverage: 'global',
    note: "listed for reference; the app doesn't draw it",
  }),
  // NASA FIRMS's public 24 h files: the Active Fires layer's keyless source.
  Object.freeze({
    domain: FIRES_DOMAIN,
    format: 'csv.firms-active-fire',
    topic: 'hazards',
    noun: 'active-fire feed',
    shown: true,
    coverage: 'global',
  }),
  // Provincial fire perimeters (BC, Alberta, Ontario): drawn in the Fire Perimeters
  // layer beside NIFC WFIGS. Regional, so place answers name them.
  Object.freeze({
    domain: PERIMETERS_DOMAIN,
    format: 'geojson.fire-perimeters',
    topic: 'hazards',
    noun: 'fire perimeter feed',
    shown: true,
    coverage: 'regional',
  }),
  // Sensor.Community's volunteer particulate sensors (mostly Europe): the
  // Air quality (PM sensors) layer's source.
  Object.freeze({
    domain: AIRQUALITY_DOMAIN,
    format: 'json.sensor-community',
    topic: 'environment',
    noun: 'air-quality sensor feed',
    shown: true,
    coverage: 'global',
  }),
]);

const rowOf = (domain) => SOURCE_DOMAINS.find((d) => d.domain === domain);

/** The decoder format the app shows a domain with, or undefined (not shown). */
export const formatOfDomain = (domain) => {
  const known = rowOf(domain);
  return known?.shown ? known.format : undefined;
};

/** The domains a `find_data_sources` topic asks for ([] = any). */
export const domainsOfTopic = (topic) =>
  SOURCE_DOMAINS.filter((d) => d.topic === topic).map((d) => d.domain);

/** The domain a one-domain topic asks for, or undefined (any, or several). */
export const domainOfTopic = (topic) => {
  const domains = domainsOfTopic(topic);
  return domains.length === 1 ? domains[0] : undefined;
};

/** The word an answer names a domain by. */
export const nounOfDomain = (domain) => rowOf(domain)?.noun || domain;

/** Why a referral-only domain is listed but not drawn, or null. */
export const noteOfDomain = (domain) => rowOf(domain)?.note || null;

/** A domain's coverage class (regional when the app doesn't know it). */
export const coverageClassOfDomain = (domain) =>
  rowOf(domain)?.coverage || 'regional';

/**
 * Worldwide: left out of place answers unless asked for, shown or not. A
 * worldwide entry's area matches every point, so it would top every answer.
 */
export const isWorldwideReference = (domain) =>
  rowOf(domain)?.coverage === 'global';

/** `find_data_sources` topics, each once. */
export const SOURCE_TOPICS = Object.freeze([
  ...new Set(SOURCE_DOMAINS.map((d) => d.topic)),
  'any',
]);
