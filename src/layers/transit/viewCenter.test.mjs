import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createViewport as createTransitViewport } from './viewport.js';
import { createViewport as createBikeshareViewport } from '../bikeshare/viewport.js';

const denver = { lat: 39.74, lon: -104.99 };

/**
 * An angled view 300 km out over Denver: the screen centre looks at Denver,
 * but the visible rectangle reaches toward the horizon, centred ~350 km north.
 */
function angledViewer({ centreHit = true } = {}) {
  return {
    scene: {
      canvas: { clientWidth: 1440, clientHeight: 900 },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: {
      pickEllipsoid: () =>
        centreHit
          ? Cesium.Cartesian3.fromDegrees(denver.lon, denver.lat)
          : undefined,
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(-112, 37.5, -101, 48.7),
      positionCartographic: Cesium.Cartographic.fromDegrees(
        -106.5,
        37.65,
        134000,
      ),
    },
  };
}

const services = { render: { governorRequestRender: () => {} } };

for (const [name, create] of [
  ['transit', createTransitViewport],
  ['bike share', createBikeshareViewport],
]) {
  test(`${name}: the view centre is where the screen centre looks, not the rectangle's middle`, () => {
    const viewport = create({ state: {}, services, parts: {}, source: {} });
    const centre = viewport.getCameraCenterLatLon(angledViewer());
    assert.ok(Math.abs(centre.lat - denver.lat) < 0.01, `lat ${centre.lat}`);
    assert.ok(Math.abs(centre.lon - denver.lon) < 0.01, `lon ${centre.lon}`);
    // Looking at the sky: the rectangle's centre is the fallback.
    const sky = viewport.getCameraCenterLatLon(
      angledViewer({ centreHit: false }),
    );
    assert.ok(Math.abs(sky.lat - 43.1) < 0.01, `lat ${sky.lat}`);
  });
}
