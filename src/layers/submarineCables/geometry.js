export function featureReference(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return null;

  const props = feature?.properties || {};
  const propertyCoords = coordsFromProperty(props.coordinates);
  if (propertyCoords) {
    return {
      lon: propertyCoords[0],
      lat: propertyCoords[1],
    };
  }

  if (geometry.type === 'Point') {
    const coords = coordsFromPoint(geometry.coordinates);
    if (!coords) return null;
    return { lon: coords[0], lat: coords[1] };
  }

  const coords = [];
  collectLonLat(geometry.coordinates, coords);
  if (!coords.length) return null;

  let lonSum = 0;
  let latSum = 0;
  for (const [lon, lat] of coords) {
    lonSum += lon;
    latSum += lat;
  }
  return {
    lon: lonSum / coords.length,
    lat: latSum / coords.length,
  };
}

export function coordsFromProperty(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

export function coordsFromPoint(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

export function collectLonLat(value, out) {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === 'number' && typeof value[1] === 'number') {
    const lon = Number(value[0]);
    const lat = Number(value[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      out.push([lon, lat]);
    }
    return;
  }
  for (const child of value) collectLonLat(child, out);
}

export function featureLabel(feature) {
  const props = feature?.properties || {};
  return String(props.name || props.id || feature?.id || '').trim();
}

/**
 * One GeoJSON feature per drawn line. Cesium's GeoJsonDataSource makes one
 * entity per part of a MultiLineString, so pairing entities with features by
 * position hands every entity after the first multi-part cable the wrong
 * cable, and the surplus entities none. Each part gets an id of its own
 * (cable ids repeat in the TeleGeography data) that maps back to its cable.
 * @param {object[]} features Normalized features (`normalizeFeatures`).
 * @returns {{parts: object[], featureOf: Map<string, object>}}
 */
export function splitLineParts(features) {
  const parts = [];
  const featureOf = new Map();
  features.forEach((feature, index) => {
    const geometry = feature.geometry;
    const pieces =
      geometry?.type === 'MultiLineString'
        ? geometry.coordinates.map((coordinates) => ({
            type: 'LineString',
            coordinates,
          }))
        : [geometry];
    pieces.forEach((piece, part) => {
      const id = `${feature.id}#${index}.${part}`;
      parts.push({ ...feature, id, geometry: piece });
      featureOf.set(id, feature);
    });
  });
  return { parts, featureOf };
}

/** Spacing of the points a drawn line is horizon-tested at. */
export const LINE_SAMPLE_SPACING_DEG = 10;

function unitVector(lon, lat) {
  const lonR = (lon * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  return [
    Math.cos(latR) * Math.cos(lonR),
    Math.cos(latR) * Math.sin(lonR),
    Math.sin(latR),
  ];
}

function angleDeg(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

function lonLatOf([x, y, z]) {
  return [
    (Math.atan2(y, x) * 180) / Math.PI,
    (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI,
  ];
}

/** The point a fraction `t` of the way along the great circle from a to b. */
function slerp(a, b, t) {
  const theta = (angleDeg(a, b) * Math.PI) / 180;
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [0, 1, 2].map((i) => wa * a[i] + wb * b[i]);
}

/**
 * The points a drawn line is horizon-tested at, no more than `spacingDeg`
 * (great-circle) apart measured along it: its ends, the vertex before the
 * distance since the last sample would pass the spacing, and points added
 * along any segment longer than that. One reference point per cable hid a part whose far end was in view
 * while that point was over the horizon, and testing vertices alone hid a
 * long segment whose middle was in view while both its ends were not (the
 * bundled data has segments over 50°).
 * @param {Array<[number, number]>} coordinates [lon, lat] vertices.
 * @param {number} [spacingDeg]
 * @returns {Array<[number, number]>}
 */
export function lineSamplePoints(
  coordinates,
  spacingDeg = LINE_SAMPLE_SPACING_DEG,
) {
  const vertices = [];
  collectLonLat(coordinates, vertices);
  if (vertices.length < 2) return vertices;
  const samples = [vertices[0]];
  // Distance along the line since the last sample.
  let run = 0;
  let previous = unitVector(...vertices[0]);
  for (let i = 1; i < vertices.length; i += 1) {
    const here = unitVector(...vertices[i]);
    const segment = angleDeg(previous, here);
    if (run > 0 && run + segment > spacingDeg) {
      samples.push(vertices[i - 1]);
      run = 0;
    }
    if (segment > spacingDeg) {
      const steps = Math.ceil(segment / spacingDeg);
      for (let step = 1; step < steps; step += 1)
        samples.push(lonLatOf(slerp(previous, here, step / steps)));
      run = segment / steps;
    } else {
      run += segment;
    }
    previous = here;
  }
  samples.push(vertices.at(-1));
  return samples;
}

export function normalizeFeatures(json, kind) {
  const features = Array.isArray(json?.features) ? json.features : [];
  return features.map((feature, index) => {
    const id = feature?.properties?.id || feature?.id || `${kind}-${index}`;
    return {
      ...feature,
      id: String(id),
    };
  });
}
