/**
 * The source-directory domains the app knows, in one place: the decoder
 * format each needs, whether the app shows it or only refers to it, the
 * `find_data_sources` topic that asks for it, and the noun an answer names it
 * by. Adding a domain starts here.
 */
export const TRANSIT_DOMAIN = 'transit.vehicles';
export const BIKESHARE_DOMAIN = 'bikeshare.stations';
export const CAMERAS_DOMAIN = 'cameras.stills';

export const SOURCE_DOMAINS = Object.freeze([
  Object.freeze({
    domain: TRANSIT_DOMAIN,
    format: 'gtfs-rt.vehicle-positions',
    topic: 'transit',
    noun: 'transit',
    shown: true,
  }),
  Object.freeze({
    domain: BIKESHARE_DOMAIN,
    format: 'gbfs.station-status',
    topic: 'bikeshare',
    noun: 'bike-share',
    shown: true,
  }),
  // Referral only: the camera lists the directory carries duplicate the
  // built-in CCTV packs, so the app names them but never draws them.
  Object.freeze({
    domain: CAMERAS_DOMAIN,
    format: 'cameras.list',
    topic: 'cameras',
    noun: 'traffic camera',
    shown: false,
  }),
]);

/** The decoder format the app shows a domain with, or undefined (not shown). */
export const formatOfDomain = (domain) => {
  const known = SOURCE_DOMAINS.find((d) => d.domain === domain);
  return known?.shown ? known.format : undefined;
};

/** The domain a `find_data_sources` topic asks for, or undefined (any). */
export const domainOfTopic = (topic) =>
  SOURCE_DOMAINS.find((d) => d.topic === topic)?.domain;

/** The word an answer names a domain by. */
export const nounOfDomain = (domain) =>
  SOURCE_DOMAINS.find((d) => d.domain === domain)?.noun || domain;

/** `find_data_sources` topics. */
export const SOURCE_TOPICS = Object.freeze([
  ...SOURCE_DOMAINS.map((d) => d.topic),
  'any',
]);
