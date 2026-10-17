import { readResponseTextCapped } from './common/http.js';
import { readWindBody as readBytesCapped } from '../../src/sources/windBody.js';

const BASE = 'https://nowcoast.noaa.gov/geoserver/observations/';
const EUMETVIEW = 'https://view.eumetsat.int/geoserver/';
const HOUR = 3600_000;
const PRODUCTS_BY_ID = {
  lightning: Object.freeze({
    service: 'lightning_detection',
    layer: 'ldn_lightning_strike_density',
    style: 'lightning_density',
    title: 'Lightning density · 15 min',
    coverage:
      'Pacific and Americas: 110°E across the dateline to 0°, 25°S–80°N; not global coverage.',
    description:
      'Observed 15-minute lightning strike density on an approximately 8 km grid, scaled as strikes/km²/min ×10³. Ground-network density, not individual GLM flashes.',
    attribution: 'NOAA/NWS nowCOAST; derived from Vaisala NLDN/GLD360',
    metadataTtlMs: 600_000,
    image: Object.freeze({ width: 4096, height: 2048 }),
  }),
  radar: Object.freeze({
    service: 'weather_radar',
    layer: 'conus_base_reflectivity_mosaic',
    style: 'weather_radar_base_reflectivity',
    title: 'CONUS radar reflectivity',
    coverage:
      'Contiguous United States; gaps do not establish absence of precipitation.',
    description:
      'Observed MRMS radar base reflectivity (dBZ), approximately 1 km and 4-minute updates; not a rainfall forecast.',
    image: Object.freeze({ width: 4096, height: 2048 }),
  }),
  clouds: Object.freeze({
    service: 'satellite',
    layer: 'global_longwave_imagery_mosaic',
    style: 'reflectance',
    title: 'Global satellite infrared',
    coverage:
      'Global mosaic with incomplete polar coverage; nominal coverage 60°S–60°N.',
    description:
      'Longwave infrared cloud and land/sea temperature patterns, approximately 3 km; hourly updates with 2–3 hour source latency. Not a cloud-only mask.',
    image: Object.freeze({ width: 2048, height: 1024 }),
  }),
  'clouds-regional': Object.freeze({
    service: 'satellite',
    layer: 'goes_longwave_imagery',
    style: 'goes-lir',
    title: 'GOES regional satellite infrared',
    coverage:
      'GOES East/West regional North American coverage; not a global image.',
    description:
      'GOES-19/18 longwave infrared Band 14 cloud and surface temperature patterns, approximately 2 km and 5-minute updates. Not a cloud-only mask.',
    image: Object.freeze({ width: 4096, height: 2048 }),
  }),
  // EUMETSAT's MTG-I Lightning Imager, Accumulated Flash Area: "Core" data,
  // Free and Unrestricted under CC BY 4.0 (EUMETSAT Data Policy, Articles 4,
  // 5.1 and 6.3). Capabilities come from the per-layer endpoint (a few KB),
  // which names the layer without its workspace.
  'lightning-eu': Object.freeze({
    capabilitiesUrl: `${EUMETVIEW}mtg_fd/li_afa/ows`,
    mapUrl: `${EUMETVIEW}ows`,
    layer: 'mtg_fd:li_afa',
    capabilitiesName: 'li_afa',
    style: 'mtg_li_afa',
    title: 'Satellite lightning · 5 min',
    coverage:
      'Meteosat 0° disc: Europe, Africa, the Atlantic and eastern South America, 70°W–70°E, 70°S–70°N; not global coverage.',
    description:
      'MTG-I Lightning Imager accumulated flash area: optical total lightning (cloud and ground flashes) seen from geostationary orbit, as flashes per ~2 km pixel per 5 minutes. Not ground-sensor strikes.',
    source: 'EUMETSAT EUMETView',
    attribution: 'Contains modified EUMETSAT Meteosat product',
    attributionYear: true,
    // A nearestValue WMS answers a missing step with a neighbour; refuse it.
    strictTime: true,
    metadataTtlMs: 300_000,
    // The data box is 140°×140°; whole images and shells need 2:1, so the
    // product's extent is padded (transparent outside the data).
    bounds: Object.freeze({ west: -140, south: -70, east: 140, north: 70 }),
    times: 'interval',
    historyStep: 3,
    maxConcurrent: 4,
    image: Object.freeze({ width: 4096, height: 2048 }),
  }),
  // ECCC's North American radar composite, classified by surface
  // precipitation type and intensity (dual-pol radar, particle class and
  // HRDPS surface temperature), every 6 minutes. ECCC Data Services
  // End-use Licence; the composite includes NOAA NEXRAD.
  'radar-ca': Object.freeze({
    capabilitiesUrl:
      'https://geo.weather.gc.ca/geomet?layer=Radar_1km_SfcPrecipType',
    mapUrl: 'https://geo.weather.gc.ca/geomet',
    layer: 'Radar_1km_SfcPrecipType',
    style: 'SfcPrecipType_Dis',
    title: 'Precipitation type · North America',
    coverage:
      'Canada and the United States where radars reach; gaps do not establish absence of precipitation.',
    description:
      'ECCC North American 1 km radar composite classified by surface precipitation type (rain, snow, mixed, freezing rain, hail) and intensity, every 6 minutes; not a forecast.',
    source: 'ECCC MSC GeoMet',
    attribution:
      'Data Source: Environment and Climate Change Canada and NOAA/NWS',
    metadataTtlMs: 120_000,
    // ECCC advertises the whole northern band (180°W–180°E, 18°N–90°N);
    // whole images use the 2:1 globe and coverage uses where radars are.
    bounds: Object.freeze({ west: -180, south: -90, east: 180, north: 90 }),
    // Where ECCC's radar coverage mask has data (170.1°W–50°W, 16.1°N–67°N).
    dataBounds: Object.freeze({ west: -171, south: 16, east: -49, north: 68 }),
    times: 'interval',
    historyStep: 2,
    // GeoMet rejects fractional seconds in TIME.
    timeFormat: 'seconds',
    maxConcurrent: 4,
    image: Object.freeze({ width: 4096, height: 2048 }),
  }),
  // NASA GPM IMERG Early (near-real-time) multi-satellite precipitation
  // rate through NASA GIBS: a global estimate, not radar, about 7 h
  // behind. GIBS's WMS capabilities are 2.5 MB, so times come from WMTS
  // DescribeDomains (a few hundred bytes).
  'precip-global': Object.freeze({
    metadata: 'describeDomains',
    domainsUrl:
      'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/IMERG_Precipitation_Rate_30min/default/2km/all/',
    mapUrl: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi',
    layer: 'IMERG_Precipitation_Rate_30min',
    style: '',
    title: 'Precipitation estimate · World',
    coverage:
      'Global multi-satellite estimate; coverage thins toward the poles.',
    description:
      'NASA GPM IMERG Early precipitation rate (mm/h), each frame the 30-minute average starting at its time, about 7 hours behind; rain and snow on separate colour ramps; not radar and not a forecast.',
    source: 'NASA GIBS · GPM IMERG',
    attribution: 'NASA GPM IMERG via NASA GIBS',
    metadataTtlMs: 600_000,
    bounds: Object.freeze({ west: -180, south: -90, east: 180, north: 90 }),
    times: 'interval',
    historyStep: 1,
    // GIBS rejects fractional seconds in TIME.
    timeFormat: 'seconds',
    // No strictTime: GIBS answers a gap or future time with a blank PNG and
    // no warning, so the advertised allowedTimes are the only guard.
    // GIBS's servers take about an hour to agree on a new step: the two
    // newest alternate between the image and a blank one (2026-10-17), so
    // they are held back until they settle.
    settleSteps: 2,
    maxConcurrent: 4,
    // Near IMERG's 0.1° grid; 13 frames stay well inside the shared cache.
    image: Object.freeze({ width: 2048, height: 1024 }),
  }),
  // DWD's German radar composite (RV product, 1 km, every 5 minutes), CC BY 4.0.
  'radar-de': Object.freeze({
    capabilitiesUrl: 'https://maps.dwd.de/geoserver/dwd/Niederschlagsradar/wms',
    capabilitiesName: 'Niederschlagsradar',
    mapUrl: 'https://maps.dwd.de/geoserver/dwd/wms',
    layer: 'dwd:Niederschlagsradar',
    style: '',
    title: 'Rain radar · Germany',
    coverage:
      'Germany and its borders where DWD radars reach; grey marks outside radar range.',
    description:
      'DWD German radar composite (RV), precipitation rate in mm/h every 5 minutes; observed frames only, not the DWD nowcast; not a forecast.',
    source: 'DWD GeoServer',
    attribution: 'Deutscher Wetterdienst (CC BY 4.0)',
    metadataTtlMs: 120_000,
    // 2:1 around Germany, with room for the 180 km scan range DWD moves to
    // on 2026-11-24 (about 45.4–56.5° N). Coverage is DWD's advertised box.
    bounds: Object.freeze({ west: -2, south: 45, east: 22, north: 57 }),
    times: 'interval',
    // The time axis runs on into the 2 h nowcast; frames stop at the newest
    // analysis (REFERENCE_TIME's default). A past TIME is that analysis
    // whatever REFERENCE_TIME says, so cached frames stay valid.
    observedEnd: 'REFERENCE_TIME',
    historyStep: 2,
    // No strictTime: an off-grid TIME is a ServiceException, and every map
    // carries "Default value used: REFERENCE_TIME", which is expected.
    maxConcurrent: 3,
    image: Object.freeze({ width: 2048, height: 1024 }),
  }),
  // FMI's Finnish radar composite, rain rate (CAPPI, mm/h) every 5 minutes,
  // CC BY 4.0, drawn in FMI's OPERA-like style.
  'radar-fi': Object.freeze({
    capabilitiesUrl:
      'https://openwms.fmi.fi/geoserver/Radar/radar_finland_cappi_rate/wms',
    capabilitiesName: 'radar_finland_cappi_rate',
    mapUrl: 'https://openwms.fmi.fi/geoserver/Radar/wms',
    layer: 'radar_finland_cappi_rate',
    style: 'radar_rate_opera',
    title: 'Rain radar · Finland',
    coverage:
      'Finland and nearby seas where FMI radars reach; grey marks no data.',
    description:
      'FMI Finnish radar composite, precipitation rate in mm/h every 5 minutes, OPERA-style colours; not a forecast.',
    source: 'FMI open data',
    attribution: 'Finnish Meteorological Institute (CC BY 4.0)',
    metadataTtlMs: 120_000,
    // 2:1 around FMI's advertised 15.3–42.7° E, 57.1–70.8° N.
    bounds: Object.freeze({ west: 14, south: 56.5, east: 44, north: 71.5 }),
    times: 'interval',
    historyStep: 2,
    // No strictTime: maps carry "Default value used" warnings for FMI's
    // elevation, FILTER and GEOCONF dimensions, which are expected.
    maxConcurrent: 3,
    image: Object.freeze({ width: 2048, height: 1024 }),
  }),
  // KNMI's Dutch radar composite, rain rate in mm/h every 5 minutes, 1 km,
  // CC BY 4.0. The ADAGUC server selects the dataset by query.
  'radar-nl': Object.freeze({
    capabilitiesUrl: 'https://geoservices.knmi.nl/adagucserver?dataset=RADAR',
    capabilitiesName: 'RAD_NL25_PCP_CM',
    mapUrl: 'https://geoservices.knmi.nl/adagucserver?dataset=RADAR',
    layer: 'RAD_NL25_PCP_CM',
    style: 'precipitation_mm_extranetten_v1',
    title: 'Rain radar · Netherlands',
    coverage: 'The Netherlands and surroundings where KNMI radars reach.',
    description:
      'KNMI Dutch radar composite, precipitation rate in mm/h every 5 minutes; not a forecast.',
    source: 'KNMI',
    attribution: 'KNMI (CC BY 4.0)',
    metadataTtlMs: 120_000,
    // 2:1 around KNMI's advertised 0–10.86° E, 48.9–55.97° N.
    bounds: Object.freeze({ west: -5.5, south: 47, east: 16.5, north: 58 }),
    times: 'interval',
    historyStep: 2,
    maxConcurrent: 3,
    image: Object.freeze({ width: 2048, height: 1024 }),
  }),
};
// Every product reads from fixed upstream URLs; nothing in a request chooses
// the destination.
const PRODUCTS = Object.freeze(
  Object.fromEntries(
    Object.entries(PRODUCTS_BY_ID).map(([id, spec]) => [
      id,
      Object.freeze({
        ...spec,
        capabilitiesUrl: spec.capabilitiesUrl ?? `${BASE}${spec.service}/ows`,
        mapUrl: spec.mapUrl ?? `${BASE}${spec.service}/ows`,
        capabilitiesName: spec.capabilitiesName ?? spec.layer,
        source: spec.source ?? 'NOAA nowCOAST',
        attribution: spec.attribution ?? 'NOAA/NWS/NESDIS nowCOAST',
        maxConcurrent: spec.maxConcurrent ?? 8,
      }),
    ]),
  ),
);

// Whole-extent images: 2:1 sizes up to each product's largest (the default).
const IMAGE_SIZES = Object.freeze(['1024x512', '2048x1024', '4096x2048']);
// Detail windows: any product up to 4096×2048 (the default).
const DETAIL_IMAGE = Object.freeze({ width: 4096, height: 2048 });
const BBOX_STEP = 0.25;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

/**
 * Canonicalize only explicit UTC observations. Intervals are expanded only
 * for products that opt in (`times: 'interval'`), and each frame fetched from
 * one is checked against the server's own time (see `upstream`).
 */
function observationTime(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const canonical = date.toISOString();
  return canonical.replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
    ? canonical
    : null;
}

/** Read the named leaf from bounded capabilities without resolving XML entities. */
export function parseWeatherCapabilities(xml, product, nowMs = Date.now()) {
  const spec = PRODUCTS[product];
  if (
    !spec ||
    typeof xml !== 'string' ||
    xml.length > 512 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw failure('invalid_weather_metadata');
  const stack = [];
  let leaf = null;
  let tags = 0;
  for (const match of xml.matchAll(/<\/?(?:[\w.-]+:)?Layer\b[^>]*>/g)) {
    if (++tags > 2048) throw failure('invalid_weather_metadata');
    if (!match[0].startsWith('</')) {
      if (stack.length) stack.at(-1).nested = true;
      if (stack.length >= 16 || match[0].endsWith('/>'))
        throw failure('invalid_weather_metadata');
      stack.push({ start: match.index + match[0].length, nested: false });
    } else {
      const opened = stack.pop();
      if (!opened) throw failure('invalid_weather_metadata');
      if (opened.nested) continue;
      const candidate = xml.slice(opened.start, match.index);
      const name = candidate
        .match(/<(?:[\w.-]+:)?Name\s*>([^<]+)<\/(?:[\w.-]+:)?Name>/)?.[1]
        ?.trim();
      if (name === spec.capabilitiesName) {
        if (leaf !== null) throw failure('invalid_weather_metadata');
        leaf = candidate;
      }
    }
  }
  if (stack.length || !leaf) throw failure('invalid_weather_metadata');
  const box = leaf.match(
    /<(?:[\w.-]+:)?EX_GeographicBoundingBox\s*>([\s\S]*?)<\/(?:[\w.-]+:)?EX_GeographicBoundingBox>/,
  )?.[1];
  const bounds = {};
  for (const [key, tag] of Object.entries({
    west: 'westBoundLongitude',
    south: 'southBoundLatitude',
    east: 'eastBoundLongitude',
    north: 'northBoundLatitude',
  })) {
    const value = box
      ?.match(
        new RegExp(`<(?:[\\w.-]+:)?${tag}\\s*>([^<]+)</(?:[\\w.-]+:)?${tag}>`),
      )?.[1]
      ?.trim();
    bounds[key] = value ? Number(value) : NaN;
  }
  // DWD gives its leaf only CRS boxes: EPSG:4326 in WMS 1.3.0 lat/lon order,
  // or CRS:84 in lon/lat.
  if (!box) {
    for (const [crs, latFirst] of [
      ['EPSG:4326', true],
      ['CRS:84', false],
    ]) {
      const attributes = [
        ...leaf.matchAll(/<(?:[\w.-]+:)?BoundingBox\b([^>]*)>/g),
      ].find((entry) =>
        new RegExp(`\\bCRS\\s*=\\s*["']${crs}["']`).test(entry[1]),
      )?.[1];
      if (!attributes) continue;
      const attr = (name) =>
        Number(
          attributes.match(
            new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`),
          )?.[1],
        );
      const [x0, y0, x1, y1] = ['minx', 'miny', 'maxx', 'maxy'].map(attr);
      Object.assign(
        bounds,
        latFirst
          ? { west: y0, south: x0, east: y1, north: x1 }
          : { west: x0, south: y0, east: x1, north: y1 },
      );
      break;
    }
  }
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north
  )
    throw failure('invalid_weather_metadata');
  // A padded product extent must hold everything the service advertises.
  if (
    spec.bounds &&
    (bounds.west < spec.bounds.west ||
      bounds.south < spec.bounds.south ||
      bounds.east > spec.bounds.east ||
      bounds.north > spec.bounds.north)
  )
    throw failure('invalid_weather_metadata');
  const extent = spec.bounds ? { ...spec.bounds } : bounds;
  const dimensions = [
    ...leaf.matchAll(
      /<(?:[\w.-]+:)?Dimension\b([^>]*)>([^<]*)<\/(?:[\w.-]+:)?Dimension>/g,
    ),
  ].filter((entry) => /\bname\s*=\s*["']time["']/.test(entry[1]));
  if (
    dimensions.length !== 1 ||
    !/\bunits\s*=\s*["']ISO8601["']/.test(dimensions[0][1])
  )
    throw failure('invalid_weather_metadata');
  const raw = dimensions[0][2].trim().split(',');
  if (!raw.length || raw.length > 512)
    throw failure('invalid_weather_metadata');
  // History keeps 13 shown frames; a product showing every n-th step needs
  // 13·n − (n − 1) steps (26 for one-step products, as before).
  const step = spec.historyStep ?? 1;
  const keep = Math.max(26, 13 * step - (step - 1));
  const reference =
    spec.observedEnd === 'REFERENCE_TIME'
      ? observedEnd(leaf, raw.at(-1).trim())
      : null;
  const times =
    spec.times === 'interval'
      ? intervalTimes(reference?.interval ?? raw.at(-1).trim(), keep)
      : raw.map((value) => observationTime(value.trim()));
  if (times.some((value) => !value || Date.parse(value) > nowMs + 5 * 60_000))
    throw failure('invalid_weather_metadata');
  const defaultTime =
    reference?.end ??
    observationTime(
      dimensions[0][1].match(/\bdefault\s*=\s*["']([^"']+)["']/)?.[1],
    );
  if (
    !defaultTime ||
    !times.includes(defaultTime) ||
    (spec.times === 'interval' && defaultTime !== times.at(-1))
  )
    throw failure('invalid_weather_metadata');
  return history(spec, times, nowMs, extent, bounds);
}

/**
 * DWD's time axis runs on into its 2 h nowcast (`default="current"`); the
 * REFERENCE_TIME dimension's default is the newest analysis. The observed
 * interval is the advertised one ending there; the reference must sit on its
 * grid, inside it.
 */
function observedEnd(leaf, interval) {
  const dimension = [
    ...leaf.matchAll(/<(?:[\w.-]+:)?Dimension\b([^>]*)>/g),
  ].find((entry) => /\bname\s*=\s*["']REFERENCE_TIME["']/.test(entry[1]));
  const end = observationTime(
    dimension?.[1].match(/\bdefault\s*=\s*["']([^"']+)["']/)?.[1],
  );
  const [start, last, period] = interval.split('/');
  const minutes = Number(/^PT([1-9]\d?)M$/.exec(period ?? '')?.[1]);
  const first = Date.parse(observationTime(start) ?? '');
  const at = Date.parse(end ?? '');
  if (
    !end ||
    !(minutes <= 60) ||
    !(at >= first) ||
    !(at <= Date.parse(observationTime(last) ?? '')) ||
    (at - first) % (minutes * 60_000) !== 0
  )
    throw failure('invalid_weather_metadata');
  return { end, interval: `${start}/${end}/${period}` };
}

/** The recent, shown and allowed frames of a product's advertised times. */
function history(spec, times, nowMs, extent, bounds) {
  const step = spec.historyStep ?? 1;
  const keep = Math.max(26, 13 * step - (step - 1));
  const recent = [...new Set(times)]
    .filter((value) => nowMs - Date.parse(value) <= 24 * HOUR)
    .sort()
    .slice(-keep);
  if (!recent.length) throw failure('weather_observations_expired');
  // Products with fine steps show the steps on an n-step grid of the clock
  // (plus the newest), so 13 frames span about as long as the other
  // products' history and stay the same frames, cacheable, as steps arrive.
  const stepMs =
    recent.length > 1
      ? Date.parse(recent.at(-1)) - Date.parse(recent.at(-2))
      : 0;
  const shown =
    step === 1 || !stepMs
      ? recent
      : recent.filter(
          (value, index) =>
            index === recent.length - 1 ||
            Date.parse(value) % (step * stepMs) === 0,
        );
  return {
    bounds: extent,
    dataBounds: spec.dataBounds ? { ...spec.dataBounds } : bounds,
    times: shown.slice(-13),
    allowedTimes: recent,
  };
}

/**
 * The last `keep` steps of one `start/end/PT{n}M` interval, oldest first, or
 * `[null]` when it is malformed: n from 1 to 60, the end on the step grid.
 */
function intervalTimes(value, keep) {
  const match = /^([^/]+)\/([^/]+)\/PT([1-9]\d?)M$/.exec(value) ?? [];
  const start = observationTime(match[1]);
  const end = observationTime(match[2]);
  const minutes = Number(match[3]);
  if (!start || !end || !(minutes <= 60)) return [null];
  const step = minutes * 60_000;
  const span = Date.parse(end) - Date.parse(start);
  // The steps must sit on the clock grid of their own period: history shows
  // a coarser grid of them, which an off-phase interval would never meet.
  if (span < 0 || span % step !== 0 || Date.parse(end) % step !== 0)
    return [null];
  const count = Math.min(keep, span / step + 1);
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(end) - (count - 1 - index) * step).toISOString(),
  );
}

/**
 * Read a GIBS WMTS DescribeDomains document: the bounding box (attributes
 * in any order) and the last `start/end/PT{n}M` interval of the time
 * domain. GIBS writes a step at midnight as a bare date (`2026-10-17`).
 * No time domain (`<Size>0</Size>`) means no recent observations.
 */
export function parseDescribeDomains(xml, product, nowMs = Date.now()) {
  const spec = PRODUCTS[product];
  if (
    !spec ||
    typeof xml !== 'string' ||
    xml.length > 512 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw failure('invalid_weather_metadata');
  const box = xml.match(/<(?:[\w.-]+:)?BoundingBox\b([^>]*)\/?>/)?.[1] ?? '';
  const attr = (name) =>
    Number(box.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`))?.[1]);
  const bounds = {
    west: attr('minx'),
    south: attr('miny'),
    east: attr('maxx'),
    north: attr('maxy'),
  };
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north
  )
    throw failure('invalid_weather_metadata');
  const domain = xml
    .match(/<(?:[\w.-]+:)?Domain\s*>([^<]*)<\/(?:[\w.-]+:)?Domain>/)?.[1]
    ?.trim();
  if (!domain) throw failure('weather_observations_expired');
  const parts = domain.split(',');
  if (parts.length > 512) throw failure('invalid_weather_metadata');
  const midnight = (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? `${value}T00:00:00Z` : value;
  const step = spec.historyStep ?? 1;
  const settle = spec.settleSteps ?? 0;
  const keep = Math.max(26, 13 * step - (step - 1)) + settle;
  // A step GIBS lacks splits the domain into intervals; the steps before the
  // gap are as good as those after it.
  const expanded = parts.flatMap((part) => {
    const [start, end, period] = part.trim().split('/');
    return intervalTimes(`${midnight(start)}/${midnight(end)}/${period}`, keep);
  });
  if (
    expanded.some((value) => !value || Date.parse(value) > nowMs + 5 * 60_000)
  )
    throw failure('invalid_weather_metadata');
  const advertised = [...new Set(expanded)].sort().slice(-keep);
  const times = advertised.slice(0, settle ? -settle : undefined);
  if (!times.length) throw failure('weather_observations_expired');
  const extent = spec.bounds ? { ...spec.bounds } : bounds;
  return history(spec, times, nowMs, extent, bounds);
}

/** A detail window `west,south,east,north` in degrees, rounded to 0.25° so cache
 * keys repeat, with a 2:1 aspect within 1 %; null when absent. Containment in
 * the product bounds is checked once the metadata is known. */
export function weatherImageBbox(value) {
  if (value === null) return null;
  const parts = value.split(',');
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^-?\d{1,3}(?:\.\d{1,6})?$/.test(part))
  )
    throw failure('invalid_weather_bbox', 400);
  // `+ 0` turns a rounded -0 into 0 so equal windows share one key.
  const [west, south, east, north] = parts.map(
    (part) => Math.round(Number(part) / BBOX_STEP) * BBOX_STEP + 0,
  );
  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north ||
    Math.abs((east - west) / (north - south) / 2 - 1) > 0.01
  )
    throw failure('invalid_weather_bbox', 400);
  return [west, south, east, north];
}

/** GeographicTilingScheme's two longitude tiles and one latitude tile at level zero. */
export function weatherTileBounds(z, x, y) {
  if (
    ![z, x, y].every(Number.isInteger) ||
    z < 0 ||
    z > 6 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** (z + 1) ||
    y >= 2 ** z
  )
    throw failure('invalid_weather_tile', 400);
  const span = 180 / 2 ** z;
  return [
    -180 + x * span,
    90 - (y + 1) * span,
    -180 + (x + 1) * span,
    90 - y * span,
  ];
}

function validatePng(bytes, width, height) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.length < 33 ||
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString('ascii', 12, 16) !== 'IHDR' ||
    buffer.readUInt32BE(16) !== width ||
    buffer.readUInt32BE(20) !== height
  )
    throw failure('invalid_weather_image');
  return buffer;
}

/** Fixed NOAA observed-weather metadata and WMS tiles; no client-supplied destinations. */
export function weatherProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 12_000,
} = {}) {
  const metadata = new Map();
  const attempts = new Map();
  const operations = new Map();
  const pending = [];
  const tiles = new Map();
  const tileFailures = new Map();
  let tileBytes = 0;
  let active = 0;

  /** Requests in flight per upstream host, held to the product's limit. */
  const activeByHost = new Map();
  function pump() {
    while (active < 8 && pending.length) {
      const index = pending.findIndex(
        (operation) =>
          operation.controller.signal.aborted ||
          (activeByHost.get(operation.host) ?? 0) < operation.limit,
      );
      if (index < 0) return;
      const [operation] = pending.splice(index, 1);
      if (operation.controller.signal.aborted) continue;
      active++;
      activeByHost.set(
        operation.host,
        (activeByHost.get(operation.host) ?? 0) + 1,
      );
      operation.started = true;
      // The deadline covers the request itself, not its wait for a slot.
      operation.timer = setTimeout(
        () => operation.controller.abort(),
        timeoutMs,
      );
      Promise.resolve()
        .then(() => operation.work(operation.controller.signal))
        .then(operation.resolve, operation.reject)
        .finally(() => {
          active--;
          activeByHost.set(
            operation.host,
            activeByHost.get(operation.host) - 1,
          );
          pump();
        });
    }
  }
  async function shared(key, work, clientSignal, spec) {
    clientSignal.throwIfAborted();
    let operation = operations.get(key);
    if (operation?.controller.signal.aborted) {
      operations.delete(key);
      operation = null;
    }
    if (!operation) {
      if (operations.size >= 120 || pending.length >= 96)
        throw failure('weather_busy', 429);
      const controller = new AbortController();
      operation = {
        controller,
        work,
        waiters: 0,
        started: false,
        host: new URL(spec.mapUrl).host,
        limit: spec.maxConcurrent,
      };
      operation.promise = new Promise((resolve, reject) => {
        operation.resolve = resolve;
        operation.reject = reject;
      });
      const cancel = () => {
        const index = pending.indexOf(operation);
        if (index >= 0) pending.splice(index, 1);
        operation.reject(failure('weather_request_cancelled'));
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      operation.promise = operation.promise.finally(() => {
        clearTimeout(operation.timer);
        controller.signal.removeEventListener('abort', cancel);
        if (operations.get(key) === operation) operations.delete(key);
      });
      operations.set(key, operation);
      pending.push(operation);
      pump();
    }
    operation.waiters++;
    const abort = () => {
      if (--operation.waiters === 0) operation.controller.abort();
    };
    clientSignal.addEventListener('abort', abort, { once: true });
    try {
      const value = await operation.promise;
      clientSignal.throwIfAborted();
      return value;
    } finally {
      clientSignal.removeEventListener('abort', abort);
      if (!clientSignal.aborted) operation.waiters--;
    }
  }
  async function upstream(url, signal, image = null) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: image ? 'image/png' : 'application/xml,text/xml' },
    });
    if (
      !response.ok ||
      (image &&
        !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || ''))
    ) {
      await response.body?.cancel();
      throw failure('weather_upstream_unavailable');
    }
    // A nearestValue WMS answers a missing step with a neighbour and says so
    // ("99 Nearest value used: time=…"): never show it under the asked time.
    if (image?.strictTime) {
      const used = /time=([^\s,]+)/.exec(response.headers.get('warning') || '');
      if (used && observationTime(used[1]) !== image.time) {
        await response.body?.cancel();
        throw failure('weather_frame_missing');
      }
    }
    const value = image
      ? validatePng(
          await readBytesCapped(response, image.maxBytes, signal),
          image.width,
          image.height,
        )
      : await readResponseTextCapped(response, 512 * 1024, signal);
    signal.throwIfAborted();
    return value;
  }
  async function getMetadata(product, signal) {
    signal.throwIfAborted();
    const old = metadata.get(product);
    const spec = PRODUCTS[product];
    if (old && now() - old.fetchedAt < (spec.metadataTtlMs ?? 120_000))
      return { ...old, stale: false };
    try {
      const domains = spec.metadata === 'describeDomains';
      const sharedKey = domains
        ? `metadata:${product}`
        : `metadata:${spec.capabilitiesUrl}`;
      if (
        now() - (attempts.get(product) ?? -Infinity) < 30_000 &&
        !operations.has(sharedKey)
      )
        throw failure('weather_upstream_unavailable');
      attempts.set(product, now());
      let url;
      if (domains) {
        // The last 24 h, floored to 30 minutes so GIBS's own 30-minute
        // cache answers repeats; the host and path are fixed.
        const end = Math.floor(now() / (30 * 60_000)) * (30 * 60_000);
        const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
        url = `${spec.domainsUrl}${iso(end - 24 * HOUR)}--${iso(end)}.xml`;
      } else {
        // A fixed URL that may carry its own query (GeoMet's `layer=`).
        const capabilities = new URL(spec.capabilitiesUrl);
        for (const [key, value] of Object.entries({
          service: 'WMS',
          version: '1.3.0',
          request: 'GetCapabilities',
        }))
          capabilities.searchParams.set(key, value);
        url = capabilities.href;
      }
      const xml = await shared(
        sharedKey,
        (activeSignal) => upstream(url, activeSignal),
        signal,
        spec,
      );
      const value = {
        ...(domains
          ? parseDescribeDomains(xml, product, now())
          : parseWeatherCapabilities(xml, product, now())),
        fetchedAt: now(),
      };
      metadata.set(product, value);
      return { ...value, stale: false };
    } catch (error) {
      if (signal.aborted) attempts.delete(product);
      signal.throwIfAborted();
      if (error.status === 429) throw error;
      if (old && now() - old.fetchedAt <= HOUR) return { ...old, stale: true };
      throw failure('weather_metadata_unavailable');
    }
  }
  function rememberTile(key, bytes) {
    if (tiles.has(key)) tileBytes -= tiles.get(key).bytes.length;
    tiles.delete(key);
    while (tiles.size >= 128 || tileBytes + bytes.length > 16 * 1024 * 1024) {
      const oldest = tiles.keys().next().value;
      tileBytes -= tiles.get(oldest).bytes.length;
      tiles.delete(oldest);
    }
    tiles.set(key, { bytes, at: now() });
    tileBytes += bytes.length;
  }
  function describe(product, value) {
    const spec = PRODUCTS[product];
    const time = value?.times.at(-1) ?? null;
    return {
      schemaVersion: 1,
      product,
      title: spec.title,
      coverage: spec.coverage,
      description: spec.description,
      source: spec.source,
      attribution:
        spec.attributionYear && time
          ? `${spec.attribution} ${time.slice(0, 4)}`
          : spec.attribution,
      bounds: value?.bounds ?? null,
      dataBounds: value?.dataBounds ?? null,
      times: value?.times ?? [],
      latest: time,
      time,
      observedAt: time,
      fetchedAt: value?.fetchedAt ?? null,
      stale: value?.stale ?? true,
      unavailable: !value,
      reason: !value
        ? 'Weather imagery unavailable'
        : value.stale
          ? 'Cached weather metadata; upstream unavailable'
          : null,
      tileSize: 256,
      maxLevel: 6,
      tilingScheme: 'geographic',
      tileTemplate: time
        ? `/api/weather/tile?product=${product}&time=${encodeURIComponent(time)}&z={z}&x={x}&y={y}`
        : null,
      imageUrl: time
        ? `/api/weather/image?product=${product}&time=${encodeURIComponent(time)}`
        : null,
      imageSize: { ...spec.image },
    };
  }
  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 429 ? { 'Retry-After': '2' } : {}),
    });
    res.end(JSON.stringify(body));
  }
  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET')
        return json(res, 405, { error: 'method_not_allowed' });
      if (!['/manifest', '/tile', '/image'].includes(url.pathname))
        return json(res, 404, { error: 'not_found' });
      const allowed =
        url.pathname === '/manifest'
          ? ['product']
          : url.pathname === '/image'
            ? ['product', 'time', 'size', 'bbox']
            : ['product', 'time', 'z', 'x', 'y', 'size'];
      if (
        req.url.length > 512 ||
        [...url.searchParams.keys()].some(
          (key) =>
            !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
        )
      )
        return json(res, 400, { error: 'invalid_weather_query' });
      const product = url.searchParams.get('product');
      if (!Object.hasOwn(PRODUCTS, product))
        return json(res, 400, { error: 'unknown_weather_product' });
      const wholeImage = url.pathname === '/image';
      const detailBox = wholeImage
        ? weatherImageBbox(url.searchParams.get('bbox'))
        : null;
      const largest = detailBox ? DETAIL_IMAGE : PRODUCTS[product].image;
      const size =
        url.searchParams.get('size') ??
        (wholeImage ? `${largest.width}x${largest.height}` : '256');
      if (
        wholeImage
          ? !IMAGE_SIZES.includes(size) ||
            Number.parseInt(size, 10) > largest.width
          : !['256', '512', '1024'].includes(size)
      )
        throw failure(
          wholeImage
            ? 'invalid_weather_image_size'
            : 'invalid_weather_tile_size',
          400,
        );
      if (url.pathname === '/manifest') {
        try {
          const value = await getMetadata(product, controller.signal);
          controller.signal.throwIfAborted();
          return json(res, 200, describe(product, value));
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error.status === 429) throw error;
          return json(res, 200, describe(product, null));
        }
      }
      const coords = wholeImage
        ? null
        : ['z', 'x', 'y'].map((key) => url.searchParams.get(key));
      if (coords?.some((value) => !/^(?:0|[1-9]\d{0,2})$/.test(value ?? '')))
        throw failure('invalid_weather_tile', 400);
      const tileBounds = coords
        ? weatherTileBounds(...coords.map(Number))
        : null;
      const time = url.searchParams.get('time');
      if (!time || observationTime(time) !== time)
        throw failure('invalid_weather_time', 400);
      const value = await getMetadata(product, controller.signal);
      controller.signal.throwIfAborted();
      if (
        !value.allowedTimes.includes(time) ||
        now() - Date.parse(time) > 24 * HOUR
      )
        throw failure('unknown_weather_time', 400);
      if (
        detailBox &&
        (detailBox[0] < value.bounds.west ||
          detailBox[1] < value.bounds.south ||
          detailBox[2] > value.bounds.east ||
          detailBox[3] > value.bounds.north)
      )
        throw failure('invalid_weather_bbox', 400);
      // A single advertised extent keeps NOAA's global reflectance contrast
      // consistent across the image; independently normalized tiles create seams.
      const bbox =
        detailBox ??
        (wholeImage
          ? [
              value.bounds.west,
              value.bounds.south,
              value.bounds.east,
              value.bounds.north,
            ]
          : tileBounds);
      const [width, height] = wholeImage
        ? size.split('x').map(Number)
        : [Number(size), Number(size)];
      const imageShape = {
        width,
        height,
        time,
        strictTime: PRODUCTS[product].strictTime === true,
        maxBytes: wholeImage
          ? MAX_IMAGE_BYTES
          : Math.max(1024 * 1024, width ** 2 * 4 + 65_536),
      };
      // NOAA WMS capabilities advertise no MaxWidth/MaxHeight. One GetMap
      // returns a whole 4096×2048 extent or window, or a 1024 px tile, without
      // composition. Images are keyed by product, time, size and bbox.
      const key = `${product}:${time}:${wholeImage ? `image:${size}:${bbox.join(',')}` : `tile:${size}:${coords.join('/')}`}`;
      let cached = tiles.get(key);
      if (cached && now() - cached.at <= 24 * HOUR) {
        tiles.delete(key);
        tiles.set(key, cached);
      } else {
        // Never ask nearestValue=1 WMS to silently replace an expired frame.
        if (value.stale) throw failure('weather_metadata_stale');
        if (now() - (tileFailures.get(key) ?? -Infinity) < 30_000)
          throw failure('weather_upstream_unavailable');
        const spec = PRODUCTS[product];
        // A fixed map URL may carry its own query (KNMI's `dataset=`).
        const upstreamUrl = new URL(spec.mapUrl);
        for (const [name, value] of Object.entries({
          service: 'WMS',
          version: '1.1.1',
          request: 'GetMap',
          layers: spec.layer,
          styles: spec.style,
          srs: 'EPSG:4326',
          bbox: bbox.join(','),
          width: String(imageShape.width),
          height: String(imageShape.height),
          format: 'image/png',
          transparent: 'true',
          time:
            spec.timeFormat === 'seconds' ? time.replace(/\.000Z$/, 'Z') : time,
        }))
          upstreamUrl.searchParams.set(name, value);
        try {
          const bytes = await shared(
            `image:${key}`,
            (signal) => upstream(upstreamUrl.href, signal, imageShape),
            controller.signal,
            spec,
          );
          rememberTile(key, bytes);
          cached = { bytes };
        } catch (error) {
          if (!controller.signal.aborted && error.status !== 429) {
            tileFailures.delete(key);
            tileFailures.set(key, now());
            while (tileFailures.size > 128)
              tileFailures.delete(tileFailures.keys().next().value);
          }
          throw error;
        }
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(cached.bytes);
    } catch (error) {
      if (!controller.signal.aborted)
        json(
          res,
          error.status === 400 || error.status === 429 ? error.status : 503,
          {
            error:
              error.status === 400 || error.status === 429
                ? error.code
                : 'weather_upstream_unavailable',
          },
        );
    } finally {
      res.removeListener?.('close', close);
    }
  }
  return {
    name: 'weather',
    configureServer({ middlewares }) {
      middlewares.use('/api/weather', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/weather', handler);
    },
  };
}
