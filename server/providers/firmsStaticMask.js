import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { acquisitionMsUtc } from '../../src/data/firmsCsv.js';

/**
 * Static-source mask for NASA FIRMS detections: known solar farms (daytime
 * sun glint) and industrial heat sources (kilns, steel works, flares). The
 * mask is a bundled pack built by scripts/build-firms-static-mask.py from
 * CC BY 4.0 inventories (see src/data/local_data/firms_static_mask/README.md).
 *
 * A detection is annotated, never removed: `staticSource` ('solar' |
 * 'industrial') on a match, plus `escalated: true` when the detection looks
 * like a real fire at that site anyway (solar: seen again on another pass;
 * industrial: unusually strong, or many pixels in one pass). Clients hide
 * flagged, non-escalated detections by default.
 *
 * VIIRS only: MODIS's 1 km pixels (up to 2 × 4.8 km at the swath edge) land
 * too far from the source for the 1 km buffer, and in the 2025 replay its
 * escalation rate failed at every buffer measured, so MODIS detections are
 * left unannotated.
 *
 * Pack format: `{format: 1, cellDeg, escalation: {...}, rows}`, rows being
 * `[kind, west, south, east, north, siteId]` (a buffered box) or
 * `[kind, cellKey, siteId]` (one buffered cell of an irregular site, keyed
 * `"<latIndex>:<lonIndex>"` at `cellDeg`). kind 0 = solar, 1 = industrial.
 */

export const STATIC_KINDS = Object.freeze(['solar', 'industrial']);

/** Grid size of the box index; a box goes into every grid cell it overlaps. */
const INDEX_DEG = 0.1;

const indexKey = (latIndex, lonIndex) => `${latIndex}:${lonIndex}`;
const latIndexOf = (lat, deg) => Math.floor((lat + 90) / deg);
const lonIndexOf = (lon, deg) => Math.floor((lon + 180) / deg);

/** Escalation defaults; a pack may override them with its measured values. */
export const DEFAULT_ESCALATION = Object.freeze({
  /** Glint lasts one pass: a solar site seen again this far apart is burning. */
  solarRecurrenceMs: 45 * 60_000,
  /** Industrial detections at least this strong (MW) stay visible. */
  industrialFrpMin: Infinity,
  /** An industrial site with at least this many pixels in one pass stays visible. */
  industrialPassPixels: Infinity,
});

function addBox(index, kind, west, south, east, north, siteId) {
  const box = { kind, west, south, east, north, siteId };
  for (
    let lat = latIndexOf(south, INDEX_DEG);
    lat <= latIndexOf(north, INDEX_DEG);
    lat++
  ) {
    for (
      let lon = lonIndexOf(west, INDEX_DEG);
      lon <= lonIndexOf(east, INDEX_DEG);
      lon++
    ) {
      const key = indexKey(lat, lon);
      const list = index.boxes.get(key);
      if (list) list.push(box);
      else index.boxes.set(key, [box]);
    }
  }
}

/**
 * Build the lookup index from pack rows. Boxes that cross the antimeridian
 * (west > east) are split into two; malformed rows are skipped.
 * @param {Array<Array>} rows
 * @param {{cellDeg?: number}} [options]
 */
export function buildMaskIndex(rows, { cellDeg = 0.01 } = {}) {
  const index = { boxes: new Map(), cells: new Map(), cellDeg, size: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || !(row[0] === 0 || row[0] === 1)) continue;
    const kind = row[0];
    if (row.length === 6) {
      const [, west, south, east, north, siteId] = row;
      if (![west, south, east, north].every(Number.isFinite)) continue;
      if (south > north) continue;
      if (west <= east) addBox(index, kind, west, south, east, north, siteId);
      else {
        addBox(index, kind, west, south, 180, north, siteId);
        addBox(index, kind, -180, south, east, north, siteId);
      }
      index.size++;
    } else if (row.length === 3 && typeof row[1] === 'string') {
      const existing = index.cells.get(row[1]);
      // Industrial wins a shared cell, as it does a shared point.
      if (!existing || kind === 1)
        index.cells.set(row[1], { kind, siteId: row[2] });
      index.size++;
    }
  }
  return index;
}

/**
 * The static source at a point: industrial (any time) before solar (daytime
 * only), or null.
 * @returns {?{kind: 'solar'|'industrial', siteId: *}}
 */
export function staticSourceOf(index, lat, lon, night) {
  if (!index || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let solar = null;
  const cell = index.cells.get(
    indexKey(latIndexOf(lat, index.cellDeg), lonIndexOf(lon, index.cellDeg)),
  );
  if (cell?.kind === 1) return { kind: 'industrial', siteId: cell.siteId };
  if (cell?.kind === 0) solar = cell;
  for (const box of index.boxes.get(
    indexKey(latIndexOf(lat, INDEX_DEG), lonIndexOf(lon, INDEX_DEG)),
  ) || []) {
    if (lat < box.south || lat > box.north || lon < box.west || lon > box.east)
      continue;
    if (box.kind === 1) return { kind: 'industrial', siteId: box.siteId };
    solar ??= box;
  }
  return solar && !night ? { kind: 'solar', siteId: solar.siteId } : null;
}

/** Remove earlier annotations (a cache written under another mask). */
export function stripStaticSources(fires) {
  for (const fire of fires) {
    delete fire.staticSource;
    delete fire.escalated;
  }
}

/**
 * Annotate detections in place: `staticSource` on matches only, and
 * `escalated: true` where a match still looks like a real fire.
 * @param {Array<object>} fires FIRMS records (firmsCsv.js shape)
 * @param {?object} index from buildMaskIndex, or null (no annotation)
 * @param {Partial<typeof DEFAULT_ESCALATION>} [escalation]
 * @returns {{flagged: number, escalated: number}}
 */
export function annotateStaticSources(fires, index, escalation = {}) {
  const rules = { ...DEFAULT_ESCALATION, ...escalation };
  if (!index || !Array.isArray(fires)) return { flagged: 0, escalated: 0 };
  /** @type {Map<string, Array<object>>} */
  const solarSites = new Map();
  /** @type {Map<string, Array<object>>} */
  const industrialPasses = new Map();
  let flagged = 0;
  for (const fire of fires) {
    if (fire.instrument === 'MODIS') continue;
    const match = staticSourceOf(
      index,
      fire.lat,
      fire.lon,
      fire.daynight === 'N',
    );
    if (!match) continue;
    fire.staticSource = match.kind;
    flagged++;
    if (match.kind === 'solar') {
      const site = solarSites.get(String(match.siteId));
      if (site) site.push(fire);
      else solarSites.set(String(match.siteId), [fire]);
    } else {
      if (Number(fire.frp) >= rules.industrialFrpMin) fire.escalated = true;
      const pass = `${match.siteId}|${fire.satellite}|${fire.acqDate}|${fire.acqTime}`;
      const list = industrialPasses.get(pass);
      if (list) list.push(fire);
      else industrialPasses.set(pass, [fire]);
    }
  }
  for (const site of solarSites.values()) {
    const times = site
      .map((fire) => acquisitionMsUtc(fire.acqDate, fire.acqTime))
      .filter(Number.isFinite);
    if (
      times.length > 1 &&
      Math.max(...times) - Math.min(...times) >= rules.solarRecurrenceMs
    )
      for (const fire of site) fire.escalated = true;
  }
  for (const pass of industrialPasses.values())
    if (pass.length >= rules.industrialPassPixels)
      for (const fire of pass) fire.escalated = true;
  let escalated = 0;
  for (const fire of fires) if (fire.escalated === true) escalated++;
  return { flagged, escalated };
}

/** Grid of the unflagged-recurrence signal: 0.004°, about 400 m. */
const RECURRENCE_DEG = 0.004;
const RECURRENCE_LON_CELLS = Math.round(360 / RECURRENCE_DEG);
/** UTC days of history kept for the recurrence signal. */
export const RECURRENCE_KEEP_DAYS = 7;
/** A cell with unflagged daytime detections on this many days counts. */
export const RECURRENCE_MIN_DAYS = 3;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Add the cells of unflagged daytime VIIRS detections to a per-day history
 * and drop days older than `keepDays` before the newest. The history is
 * `{[utcDate]: cellId[]}` (sorted integer ids on a ~400 m grid), so it can
 * be stored as JSON. Run it after annotateStaticSources.
 * @param {Record<string, number[]>} days
 * @param {Array<object>} fires
 * @returns {Record<string, number[]>} a new history
 */
export function recordUnflaggedDays(
  days,
  fires,
  keepDays = RECURRENCE_KEEP_DAYS,
) {
  const byDate = new Map(
    Object.entries(days || {}).map(([date, ids]) => [date, new Set(ids)]),
  );
  for (const fire of Array.isArray(fires) ? fires : []) {
    if (
      fire.instrument === 'MODIS' ||
      fire.daynight === 'N' ||
      fire.staticSource
    )
      continue;
    if (!Number.isFinite(fire.lat) || !Number.isFinite(fire.lon)) continue;
    if (!ISO_DATE.test(fire.acqDate)) continue;
    const lonIndex = Math.min(
      lonIndexOf(fire.lon, RECURRENCE_DEG),
      RECURRENCE_LON_CELLS - 1,
    );
    const id =
      latIndexOf(fire.lat, RECURRENCE_DEG) * RECURRENCE_LON_CELLS + lonIndex;
    const ids = byDate.get(fire.acqDate);
    if (ids) ids.add(id);
    else byDate.set(fire.acqDate, new Set([id]));
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return {};
  const cutoff = new Date(
    Date.parse(`${dates.at(-1)}T00:00:00Z`) - (keepDays - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return Object.fromEntries(
    dates
      .filter((date) => date >= cutoff)
      .map((date) => [date, [...byDate.get(date)].sort((a, b) => a - b)]),
  );
}

/**
 * Cells with unflagged daytime detections on at least `minDays` days of the
 * history: the sign of a solar farm or industrial site the mask lacks (or a
 * fire that burned that long in one place).
 * @param {Record<string, number[]>} days
 */
export function countRecurringCells(days, minDays = RECURRENCE_MIN_DAYS) {
  const seen = new Map();
  for (const ids of Object.values(days || {}))
    for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
  let count = 0;
  for (const n of seen.values()) if (n >= minDays) count++;
  return count;
}

/**
 * Load a mask pack from disk. Returns null (and warns once, from the caller)
 * when it is missing or malformed: no mask means no annotation, never an error.
 * @param {URL|string} file
 * @returns {?{id: string, index: object, escalation: object}}
 */
export function loadMaskPack(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const pack = JSON.parse(text);
    if (pack?.format !== 1 || !Array.isArray(pack.rows)) return null;
    const index = buildMaskIndex(pack.rows, { cellDeg: pack.cellDeg });
    if (!index.size) return null;
    return {
      id: createHash('sha256').update(text).digest('hex'),
      index,
      escalation: {
        ...DEFAULT_ESCALATION,
        ...(pack.escalation && typeof pack.escalation === 'object'
          ? pack.escalation
          : {}),
      },
    };
  } catch {
    return null;
  }
}

/** The bundled pack, resolved from this module (not the process cwd). */
export const DEFAULT_MASK_URL = new URL(
  '../../src/data/local_data/firms_static_mask/mask.json',
  import.meta.url,
);
