/** Card model for one selected fire-perimeter incident. Pure — no Cesium types. */
import { formatNumber, msg, t, tn } from '../../i18n/index.js';

export const PERIMETER_OVERLAY_SOURCE_ID = 'fire-perimeters';

/** CSS accent for a perimeter card by containment progress (mirrors the fill). */
export function containmentAccent(containedPct) {
  if (!Number.isFinite(containedPct) || containedPct <= 0) return '#ff3b30';
  if (containedPct < 50) return '#ff7a00';
  if (containedPct < 100) return '#ffb300';
  return '#8bc34a';
}

/**
 * The legend bands: US fires by reported containment, provincial fires by
 * their stage of control on the same four colours, and a neutral band for
 * feeds that report neither (Ontario).
 */
export const PERIMETER_BANDS = Object.freeze([
  Object.freeze({
    key: 'uncontrolled',
    label: msg('Not contained or out of control'),
    color: '#ff3b30',
  }),
  Object.freeze({
    key: 'held',
    label: msg('Under 50% contained or being held'),
    color: '#ff7a00',
  }),
  Object.freeze({
    key: 'controlled',
    label: msg('50–99% contained or under control'),
    color: '#ffb300',
  }),
  Object.freeze({
    key: 'out',
    label: msg('Fully contained or out'),
    color: '#8bc34a',
  }),
  Object.freeze({
    key: 'unreported',
    label: msg('Status not reported'),
    color: '#9aa4ad',
  }),
]);

const STATUS_BAND = Object.freeze({
  'Out of Control': 'uncontrolled',
  'Being Held': 'held',
  'Under Control': 'controlled',
  Out: 'out',
});

/** The band (key, label, colour) one perimeter row is drawn and counted in. */
export function perimeterBand(row) {
  let key;
  if (Number.isFinite(row?.containedPct)) {
    const pct = row.containedPct;
    key =
      pct <= 0
        ? 'uncontrolled'
        : pct < 50
          ? 'held'
          : pct < 100
            ? 'controlled'
            : 'out';
  } else if (row?.status && STATUS_BAND[row.status])
    key = STATUS_BAND[row.status];
  else
    key = row?.source && row.source !== 'wfigs' ? 'unreported' : 'uncontrolled';
  return PERIMETER_BANDS.find((band) => band.key === key);
}

/** Shoelace area (degree², sign dropped) — relative sizes only. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/**
 * Anchor point for the incident card: the centroid of the largest polygon's
 * outer ring. Degrees, so callers own the Cartesian conversion.
 * @param {Array<Array<Array<[number, number]>>>} polygons - Normalized rows' polygons.
 * @returns {{lon: number, lat: number}}
 */
export function perimeterAnchorDegrees(polygons) {
  let best = null;
  let bestArea = -1;
  for (const rings of polygons) {
    const outer = rings[0];
    const area = ringArea(outer);
    if (area > bestArea) {
      bestArea = area;
      best = outer;
    }
  }
  // Vertex mean over the closed ring (first == last point dropped): perimeters
  // are compact enough that this stays inside or near the polygon.
  let lon = 0;
  let lat = 0;
  const count = best.length - 1;
  for (let i = 0; i < count; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  return { lon: lon / count, lat: lat / count };
}

/**
 * Compact USD in the UI language: en "$85K / $4.2M / $1.3B", ru "4,2 млн $",
 * es "4,2 M$". Null under $1,000.
 */
function formatCost(dollars) {
  if (!Number.isFinite(dollars) || dollars < 1000) return null;
  const units = [1e3, 1e6, 1e9];
  let index = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    if (dollars >= units[i]) {
      index = i;
      break;
    }
  }
  // 999,500 must promote to $1M, never render as $1000K.
  if (dollars >= units[index] * 999.5 && index < units.length - 1) index++;
  const value = dollars / units[index];
  const amount = formatNumber(
    value >= 10 ? Math.round(value) : Math.round(value * 10) / 10,
  );
  if (index === 0) return t('${amount}K', { amount });
  if (index === 1) return t('${amount}M', { amount });
  return t('${amount}B', { amount });
}

/** WFIGS attr_FireCause values in the UI language; others as sent. */
function causeLabel(cause) {
  switch (cause) {
    case 'Human':
      return t('Human', { context: 'fire cause' });
    case 'Natural':
      return t('Natural', { context: 'fire cause' });
    case 'Undetermined':
      return t('Undetermined', { context: 'fire cause' });
    case 'Unknown':
      return t('Unknown', { context: 'fire cause' });
    default:
      return cause;
  }
}

/** WFIGS attr_FireBehaviorGeneral values in the UI language; others as sent. */
function behaviorLabel(behavior) {
  switch (behavior) {
    case 'Minimal':
      return t('Minimal', { context: 'fire behavior' });
    case 'Moderate':
      return t('Moderate', { context: 'fire behavior' });
    case 'Active':
      return t('Active', { context: 'fire behavior' });
    case 'Extreme':
      return t('Extreme', { context: 'fire behavior' });
    default:
      return behavior;
  }
}

/**
 * WFIGS attr_IncidentComplexityLevel ("Type 1 Incident" … "Type 5 Incident")
 * in the UI language; other values as sent.
 */
function complexityLabel(complexity) {
  const match = /^Type ([1-5]) Incident$/.exec(complexity);
  return match ? t('Type {level} Incident', { level: match[1] }) : complexity;
}

/** WFIGS complex names arrive ALL-CAPS; render them in title case. */
function titleCase(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** Day-granular age for dates mapped by the day (provincial feeds). */
function formatDays(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const days = Math.floor(deltaMs / 86400000);
  return days < 1
    ? t('mapped today')
    : t('mapped {count}d ago', { count: days });
}

/** Compact age, "5m" / "3h" / "2d", in the UI language ("3 h", "3 ч"). */
function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1)
    return t('{count}m', {
      context: 'age',
      count: Math.max(1, Math.floor(deltaMs / 60000)),
    });
  if (hours < 24) return t('{count}h', { context: 'age', count: hours });
  return t('{count}d', { context: 'age', count: Math.floor(hours / 24) });
}

/**
 * Build the overlay-host entry for one selected incident. The caller supplies
 * `position` (Cartesian) separately — this model stays JSON-safe for tests.
 * @param {Object} row - Normalized perimeter row (see records.js).
 * @param {number} nowMs - Current epoch milliseconds.
 * @param {{link: ?string, linkLabel?: string}} [extras] - Optional incident
 *   page (InciWeb, or a provincial wildfire page) and the name it is shown by.
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildIncidentCard(
  row,
  nowMs,
  { link = null, linkLabel = 'InciWeb' } = {},
) {
  if (row.source && row.source !== 'wfigs')
    return buildProvincialCard(row, nowMs, { link, linkLabel });
  // The row keeps WFIGS values as sent (AI tools read them); the card translates
  // the known cause, behavior and complexity values and the wording around them.
  const facts = [];
  if (Number.isFinite(row.acres)) {
    const acres = Math.round(row.acres);
    facts.push(
      tn(acres, '{acres} ac', '{acres} ac', { acres: formatNumber(acres) }),
    );
  }
  facts.push(
    Number.isFinite(row.containedPct)
      ? t('{percent}% contained', { percent: Math.round(row.containedPct) })
      : t('containment unknown'),
  );
  if (row.state) facts.push(row.state);
  else if (row.category) facts.push(row.category);

  const situation = [];
  if (row.cause)
    situation.push(t('{cause} cause', { cause: causeLabel(row.cause) }));
  if (row.behavior) situation.push(behaviorLabel(row.behavior));
  if (row.complexity) situation.push(complexityLabel(row.complexity));

  const response = [];
  if (Number.isFinite(row.personnel)) {
    const personnel = Math.round(row.personnel);
    response.push(
      tn(personnel, '{personnel} personnel', '{personnel} personnel', {
        personnel: formatNumber(personnel),
      }),
    );
  }
  if (row.county) response.push(t('{county} County', { county: row.county }));
  if (Number.isFinite(row.costToDate)) {
    const cost = formatCost(row.costToDate);
    if (cost) response.push(t('{cost} to date', { cost }));
  }

  const ages = [];
  const discovered = formatAge(nowMs - row.discoveredTime);
  if (row.discoveredTime != null && discovered)
    ages.push(t('discovered {age} ago', { age: discovered }));
  const updated = formatAge(nowMs - row.updatedTime);
  if (row.updatedTime != null && updated)
    ages.push(t('updated {age} ago', { age: updated }));

  const details = [facts.join(' · ')];
  if (row.complexName)
    details.push(
      t('part of {complex}', { complex: titleCase(row.complexName) }),
    );
  if (situation.length) details.push(situation.join(' · '));
  if (response.length) details.push(response.join(' · '));
  if (ages.length) details.push(ages.join(' · '));
  if (link)
    details.push(t('{site} ↗ · click card to open', { site: linkLabel }));

  const title = t('FIRE · {name}', {
    name: row.name || t('Unnamed incident'),
  });
  return {
    id: `fire-perimeter-card:${row.stableId}`,
    // `selected` picks the paint lane and collision protection; an explicit
    // paintLane would override it in the host's lane resolver.
    selected: true,
    // Only a linked card is clickable — the overlay host registers hit
    // rectangles solely for interactive entries.
    interactive: Boolean(link),
    ...(link
      ? {
          accessibilityLabel: t('Open {title} on {site}', {
            title,
            site: linkLabel,
          }),
        }
      : undefined),
    title,
    details,
    accent: perimeterBand(row).color,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * A provincial stage of control in the UI language. The values are the feed's
 * own (records.js PERIMETER_STATUSES) and stay as data; only the card
 * translates them.
 */
function statusLabel(status) {
  switch (status) {
    case 'Out of Control':
      return t('Out of Control', { context: 'fire status' });
    case 'Being Held':
      return t('Being Held', { context: 'fire status' });
    case 'Under Control':
      return t('Under Control', { context: 'fire status' });
    case 'Out':
      return t('Out', { context: 'fire status' });
    default:
      return status || t('status not reported');
  }
}

/**
 * A provincial perimeter's card: hectares, stage of control (when the feed
 * reports one), the province and how long ago it was mapped. The feeds are
 * published for reference only, and the card says so.
 */
function buildProvincialCard(row, nowMs, { link, linkLabel }) {
  const facts = [];
  if (Number.isFinite(row.hectares)) {
    const hectares =
      row.hectares < 10
        ? Math.round(row.hectares * 10) / 10
        : Math.round(row.hectares);
    facts.push(t('{hectares} ha', { hectares: formatNumber(hectares) }));
  }
  facts.push(statusLabel(row.status));
  if (row.state) facts.push(row.state);
  const details = [facts.join(' · ')];
  const mapped = formatDays(nowMs - row.updatedTime);
  details.push(
    row.updatedTime != null && mapped
      ? `${mapped} · ${t('reference only')}`
      : t('reference only'),
  );
  if (link)
    details.push(t('{site} ↗ · click card to open', { site: linkLabel }));
  const title = t('FIRE · {name}', {
    name: row.name || t('Unnamed incident'),
  });
  return {
    id: `fire-perimeter-card:${row.stableId}`,
    selected: true,
    interactive: Boolean(link),
    ...(link
      ? {
          accessibilityLabel: t('Open {title} on {site}', {
            title,
            site: linkLabel,
          }),
        }
      : undefined),
    title,
    details,
    accent: perimeterBand(row).color,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
