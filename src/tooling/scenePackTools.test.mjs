import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  PACK_FEATURE_LIMIT,
  kmlPlacemarks,
  placemarksToPack,
} from '../../scripts/kml-to-scene-pack.mjs';
import { bundleScene } from '../../scripts/scene-bundle.mjs';
import { parseSceneShare } from '../../src/director/sharing/bundle.js';
import { decodePackGeoJSON } from '../../src/director/packs/geojson.js';

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>t</name>
<Style id="line-unflagged"><LineStyle><color>ffffffff</color></LineStyle></Style>
<Placemark><name>a</name><styleUrl>#line-unflagged</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>-80.2,26.7,11000 -80.1,26.7,11100</coordinates></LineString></Placemark>
<Placemark><name>b</name><styleUrl>#line-nic0</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>-80.1,26.7,11100 -80.0,26.6,300</coordinates></LineString></Placemark>
<Placemark><name>c</name><styleUrl>#t0</styleUrl><Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>-80.2,26.7,14000 -80.1,26.7,14000 -80.1,26.8,14000 -80.2,26.7,14000</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>d</name><styleUrl>#fix-ok</styleUrl><Point><altitudeMode>absolute</altitudeMode><coordinates>-80.2,26.7,11000</coordinates></Point></Placemark>
</Document></kml>`;

test('script-written KML placemarks are read with their style and geometry', () => {
  const placemarks = kmlPlacemarks(KML);
  assert.deepEqual(
    placemarks.map((p) => [p.style, p.type, p.coordinates.length]),
    [
      ['line-unflagged', 'LineString', 2],
      ['line-nic0', 'LineString', 2],
      ['t0', 'Polygon', 4],
      ['fix-ok', 'Point', 1],
    ],
  );
  assert.deepEqual(placemarks[0].coordinates[1], [-80.1, 26.7, 11100]);
});

test('a pack keeps only the chosen styles and decodes as a Director pack', () => {
  const pack = placemarksToPack(kmlPlacemarks(KML), ['line-nic0', 't0']);
  assert.equal(pack.features.length, 2);
  const decoded = decodePackGeoJSON(
    new TextEncoder().encode(JSON.stringify(pack)),
  );
  assert.deepEqual(
    decoded.map((f) => [f.id, f.type]),
    [
      ['f0', 'LineString'],
      ['f1', 'Polygon'],
    ],
  );
  assert.equal(decoded[1].coordinates[0][0][2], 14000);
  assert.throws(
    () => placemarksToPack(kmlPlacemarks(KML), ['nope']),
    /No placemarks/,
  );
});

test('KML outside what the scripts write is refused', () => {
  assert.throws(
    () =>
      kmlPlacemarks(
        '<Placemark><MultiGeometry><Point><coordinates>0,0</coordinates></Point></MultiGeometry></Placemark>',
      ),
    /one Point, LineString or Polygon/,
  );
  assert.throws(
    () =>
      kmlPlacemarks(
        '<Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs/></Polygon></Placemark>',
      ),
    /outer ring/,
  );
  assert.throws(
    () => kmlPlacemarks('<Placemark><name>x</name></Placemark>'),
    /without a Point/,
  );
  assert.throws(
    () =>
      kmlPlacemarks(
        '<Placemark><Point><coordinates>a,b</coordinates></Point></Placemark>',
      ),
    /Unreadable/,
  );
});

test('packs over the feature limit are refused', () => {
  const many = Array.from({ length: PACK_FEATURE_LIMIT + 1 }, () => ({
    style: null,
    type: 'Point',
    coordinates: [[0, 0, 0]],
  }));
  assert.throws(() => placemarksToPack(many), /at most 2000/);
});

test('a scene and its pack files become a bundle the app reads back', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'n'));
  const pack = placemarksToPack(kmlPlacemarks(KML), ['line-unflagged']);
  await writeFile(path.join(dir, 'n', 'track.json'), JSON.stringify(pack));
  const project = {
    version: 6,
    scenes: [
      {
        id: 'scene',
        title: 'Test',
        dataPacks: [
          {
            id: 'track',
            version: 1,
            format: 'geojson',
            source: { adapter: 'assets', path: 'n/track.json' },
            attribution: { text: 'adsb.lol', license: 'ODbL-1.0' },
            placement: { altitudeReference: 'ellipsoid' },
          },
        ],
        shots: [
          {
            id: 'shot',
            camera: {
              lat: 26.5,
              lon: -80.2,
              alt: 9000,
              heading: 10,
              pitch: -10,
              roll: 0,
            },
            durationSec: 3,
            holdSec: 2,
            dataPackIds: ['track'],
          },
        ],
      },
    ],
  };
  const text = await bundleScene(project, dir);
  const share = await parseSceneShare(text);
  const [bundled] = share.project.scenes[0].dataPacks;
  assert.equal(bundled.source.adapter, 'scene-bundle');
  assert.equal(share.assets.size, 1);
  const outside = structuredClone(project);
  outside.scenes[0].dataPacks[0].source.path = 'n/missing.png';
  await assert.rejects(() => bundleScene(outside, dir), /ENOENT|no such file/i);
});
