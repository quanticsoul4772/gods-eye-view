/**
 * The source-directory domains the app can use, in one place: the decoder
 * format each needs, the `find_data_sources` topic that asks for it, and the
 * noun an answer names it by. Adding a domain starts here.
 */
export const TRANSIT_DOMAIN = 'transit.vehicles';
export const BIKESHARE_DOMAIN = 'bikeshare.stations';

export const SOURCE_DOMAINS = Object.freeze([
  Object.freeze({
    domain: TRANSIT_DOMAIN,
    format: 'gtfs-rt.vehicle-positions',
    topic: 'transit',
    noun: 'transit',
  }),
  Object.freeze({
    domain: BIKESHARE_DOMAIN,
    format: 'gbfs.station-status',
    topic: 'bikeshare',
    noun: 'bike-share',
  }),
]);

/** The decoder format the app needs for a domain, or undefined. */
export const formatOfDomain = (domain) =>
  SOURCE_DOMAINS.find((d) => d.domain === domain)?.format;

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
