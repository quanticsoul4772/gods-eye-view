import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFirePerimeterSnapshot } from './records.js';

const ring = [
  [-108.1, 35.2],
  [-108.0, 35.2],
  [-108.0, 35.3],
  [-108.1, 35.2],
];

function feature(overrides = {}) {
  return {
    id: 1,
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
      poly_IncidentName: 'Fixture Fire',
      attr_UniqueFireIdentifier: '2026-NMGNF-000123',
      attr_IncidentSize: 512.5,
      attr_PercentContained: 40,
      attr_POOState: 'US-NM',
      attr_IncidentTypeCategory: 'WF',
      attr_FireDiscoveryDateTime: 1757900000000,
      poly_DateCurrent: 1757950000000,
      attr_FireCause: 'Natural',
      attr_FireBehaviorGeneral: 'Active',
      attr_TotalIncidentPersonnel: 380,
      attr_POOCounty: 'Sandoval',
      attr_EstimatedCostToDate: 4200000,
      attr_IncidentComplexityLevel: 'Type 3 Incident',
      attr_CpxName: 'ROWE CREEK COMPLEX',
      ...overrides.properties,
    },
    ...overrides,
  };
}

test('a valid snapshot yields one row per incident with polygons preserved', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [
      feature(),
      feature({
        id: 2,
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[ring], [ring]],
        },
        properties: { attr_UniqueFireIdentifier: '2026-AZASF-000456' },
      }),
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    stableId: '2026-NMGNF-000123',
    name: 'Fixture Fire',
    acres: 512.5,
    containedPct: 40,
    state: 'US-NM',
    category: 'WF',
    discoveredTime: 1757900000000,
    updatedTime: 1757950000000,
    cause: 'Natural',
    behavior: 'Active',
    personnel: 380,
    county: 'Sandoval',
    costToDate: 4200000,
    complexity: 'Type 3 Incident',
    complexName: 'ROWE CREEK COMPLEX',
    hectares: 512.5 / 2.4710538,
    status: null,
    link: null,
    source: 'wfigs',
    attribution: null,
    licenceUrl: null,
    polygons: [[ring]],
  });
  assert.equal(rows[1].polygons.length, 2);
});

test('a missing unique fire identifier falls back to the feature id', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [feature({ properties: { attr_UniqueFireIdentifier: null } })],
  });
  assert.equal(rows[0].stableId, '1');
});

test('optional attributes normalize to null rather than leaking undefined', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [
      feature({
        properties: {
          poly_IncidentName: null,
          attr_IncidentSize: null,
          attr_PercentContained: null,
          attr_POOState: null,
          attr_IncidentTypeCategory: null,
          attr_FireDiscoveryDateTime: null,
          poly_DateCurrent: null,
          attr_FireCause: null,
          attr_FireBehaviorGeneral: null,
          attr_TotalIncidentPersonnel: null,
          attr_POOCounty: null,
          attr_EstimatedCostToDate: null,
          attr_IncidentComplexityLevel: null,
          attr_CpxName: null,
        },
      }),
    ],
  });
  assert.deepEqual(
    {
      name: rows[0].name,
      acres: rows[0].acres,
      containedPct: rows[0].containedPct,
      state: rows[0].state,
      category: rows[0].category,
      discoveredTime: rows[0].discoveredTime,
      updatedTime: rows[0].updatedTime,
      cause: rows[0].cause,
      behavior: rows[0].behavior,
      personnel: rows[0].personnel,
      county: rows[0].county,
      costToDate: rows[0].costToDate,
      complexity: rows[0].complexity,
      complexName: rows[0].complexName,
    },
    {
      name: null,
      acres: null,
      containedPct: null,
      state: null,
      category: null,
      discoveredTime: null,
      updatedTime: null,
      cause: null,
      behavior: null,
      personnel: null,
      county: null,
      costToDate: null,
      complexity: null,
      complexName: null,
    },
  );
});

test('a feed that is not a feature collection is rejected as a whole', () => {
  for (const payload of [null, {}, { features: null }, { features: {} }]) {
    assert.equal(normalizeFirePerimeterSnapshot(payload), null);
  }
});

test('an invalid feature is skipped so one bad incident cannot blank the layer', () => {
  const good = feature({
    id: 2,
    properties: { attr_UniqueFireIdentifier: 'good' },
  });
  for (const bad of [
    feature({ geometry: null }),
    feature({ geometry: { type: 'Point', coordinates: [0, 1] } }),
    feature({
      geometry: {
        type: 'Polygon',
        coordinates: [[[Infinity, 35.2], ...ring.slice(1)]],
      },
    }),
    feature({
      geometry: {
        type: 'Polygon',
        coordinates: [[[-200, 35.2], ...ring.slice(1)]],
      },
    }),
    feature({ geometry: { type: 'Polygon', coordinates: [ring.slice(0, 2)] } }),
    feature({ properties: null }),
    feature({ id: null, properties: { attr_UniqueFireIdentifier: null } }),
  ]) {
    const rows = normalizeFirePerimeterSnapshot({ features: [bad, good] });
    assert.equal(rows.length, 1, 'bad feature must be skipped, not fatal');
    assert.equal(rows[0].stableId, 'good');
  }
});

test('a duplicate incident id keeps the first occurrence and skips the rest', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [
      feature(),
      feature({
        properties: {
          attr_UniqueFireIdentifier: '2026-NMGNF-000123',
          attr_IncidentSize: 999,
        },
      }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].acres, 512.5);
});

test('a perimeter with no rings is skipped rather than rendered empty', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [
      feature({ geometry: { type: 'Polygon', coordinates: [] } }),
      feature({ id: 2, properties: { attr_UniqueFireIdentifier: 'other' } }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'other');
});

test('provincial feeds: rows through the mapping, merged by fire number, safe ids, links and dates', async () => {
  const { normalizeMappedPerimeters, mappedTime } =
    await import('./records.js');
  const bc = {
    id: 'bc-wildfire-perimeters-current',
    mapping: {
      id: 'FIRE_NUMBER',
      size_ha: 'FIRE_SIZE_HECTARES',
      updated: 'TRACK_DATE',
      status: 'FIRE_STATUS',
      url: 'FIRE_URL',
      region: 'CA-BC',
    },
    licence: {
      attribution: 'BC Wildfire Service.',
      url: 'https://www2.gov.bc.ca/licence',
    },
  };
  const fire = (properties, coordinates = [ring]) => ({
    geometry: { type: 'Polygon', coordinates },
    properties,
  });
  const site =
    'https://wildfiresituation.nrs.gov.bc.ca/incidents?incidentNumber=C40127';
  const rows = normalizeMappedPerimeters(
    {
      features: [
        fire({
          FIRE_NUMBER: 'C40127',
          FIRE_SIZE_HECTARES: 4.6,
          FIRE_STATUS: 'Being Held',
          TRACK_DATE: 1777014000000,
          FIRE_URL: site,
        }),
        fire({
          FIRE_NUMBER: 'C40127',
          FIRE_SIZE_HECTARES: 5.1,
          FIRE_STATUS: 'Under Control',
          TRACK_DATE: 1777100400000,
          FIRE_URL: null,
        }),
        fire({
          FIRE_NUMBER: 'K2:0637',
          FIRE_SIZE_HECTARES: 'big',
          FIRE_STATUS: 'Smouldering',
          TRACK_DATE: '2026-05-28Z',
          FIRE_URL: 'http://wildfiresituation.nrs.gov.bc.ca/x',
        }),
        fire({
          FIRE_NUMBER: 'V1',
          TRACK_DATE: 'May 28',
          FIRE_URL: 'https://evil.example/x',
        }),
        fire({ FIRE_NUMBER: null }),
        fire({ FIRE_NUMBER: 'bad-geometry' }, [[[0, 0]]]),
      ],
    },
    bc,
    { allowedLinkHost: (host) => host === 'wildfiresituation.nrs.gov.bc.ca' },
  );
  assert.deepEqual(
    rows.map((r) => r.stableId),
    [
      'bc-wildfire-perimeters-current/C40127',
      'bc-wildfire-perimeters-current/K2-0637',
      'bc-wildfire-perimeters-current/V1',
    ],
    'no ":" in ids (the pick id separator)',
  );
  const [merged, odd, plain] = rows;
  assert.equal(merged.polygons.length, 2, 'both features of one fire kept');
  assert.equal(merged.status, 'Under Control', 'the newest mapping wins');
  assert.equal(merged.hectares, 5.1);
  assert.equal(Math.round(merged.acres), 13);
  assert.equal(merged.state, 'CA-BC');
  assert.equal(merged.containedPct, null);
  assert.equal(merged.link, null, 'the newest feature had no page');
  assert.equal(merged.attribution, 'BC Wildfire Service.');
  assert.equal(odd.status, null, 'unknown stage of control');
  assert.equal(odd.hectares, null);
  assert.equal(odd.updatedTime, Date.UTC(2026, 4, 28));
  assert.equal(odd.link, null, 'http is refused');
  assert.equal(plain.link, null, 'another site is refused');
  assert.equal(plain.updatedTime, null);
  const first = normalizeMappedPerimeters(
    { features: [fire({ FIRE_NUMBER: 'C1', FIRE_URL: site })] },
    bc,
    { allowedLinkHost: (host) => host === 'wildfiresituation.nrs.gov.bc.ca' },
  );
  assert.equal(first[0].link, site);
  for (const unsafe of [
    'https://someone@wildfiresituation.nrs.gov.bc.ca/incidents',
    'https://wildfiresituation.nrs.gov.bc.ca:8443/incidents',
    'ftp://wildfiresituation.nrs.gov.bc.ca/incidents',
  ]) {
    const [r] = normalizeMappedPerimeters(
      { features: [fire({ FIRE_NUMBER: 'C2', FIRE_URL: unsafe })] },
      bc,
      { allowedLinkHost: () => true },
    );
    assert.equal(r.link, null, unsafe);
  }
  assert.equal(mappedTime(1777014000000), 1777014000000);
  assert.equal(mappedTime(1777014), null, 'seconds are not milliseconds');
  assert.equal(normalizeMappedPerimeters({}, bc), null);
  const proto = normalizeMappedPerimeters(
    { features: [fire({ FIRE_NUMBER: 'A1' })] },
    { ...bc, mapping: { ...bc.mapping, size_ha: 'constructor' } },
  );
  assert.equal(proto[0].hectares, null, 'inherited keys are never read');
});
