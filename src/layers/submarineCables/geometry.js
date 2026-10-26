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

const RAD = Math.PI / 180;

/** Longitude difference wrapped to [-180, 180), the way Cesium's rhumb lines go. */
function lonDelta(from, to) {
  return ((((to - from + 540) % 360) + 360) % 360) - 180;
}

function wrapLon(lon) {
  return lonDelta(0, lon);
}

/** Mercator northing; a rhumb line is straight in (longitude, northing). */
function mercatorY(lat) {
  const clamped = Math.max(-89.9, Math.min(89.9, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * RAD) / 2));
}

/** Length in degrees of arc of the rhumb line from a to b ([lon, lat]). */
function rhumbDeg([lon1, lat1], [lon2, lat2]) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = lonDelta(lon1, lon2) * RAD;
  const dY = mercatorY(lat2) - mercatorY(lat1);
  const q = Math.abs(dY) > 1e-12 ? dLat / dY : Math.cos(lat1 * RAD);
  return Math.hypot(dLat, q * dLon) / RAD;
}

/** The point a fraction `t` of the way along the rhumb line from a to b. */
function rhumbPoint([lon1, lat1], [lon2, lat2], t) {
  const lat = lat1 + t * (lat2 - lat1);
  const dY = mercatorY(lat2) - mercatorY(lat1);
  const along =
    Math.abs(dY) > 1e-12 ? (mercatorY(lat) - mercatorY(lat1)) / dY : t;
  return [wrapLon(lon1 + along * lonDelta(lon1, lon2)), lat];
}

/**
 * The points a drawn line is horizon-tested at, no more than `spacingDeg`
 * apart measured along it: its ends, the vertex before the distance since
 * the last sample would pass the spacing, and points added along any
 * segment longer than that. Distances and added points follow rhumb lines,
 * which is how Cesium's GeoJsonDataSource draws the cable (`ArcType.RHUMB`).
 * One reference point per cable hid a part whose far end was in view while
 * that point was over the horizon, and testing vertices alone hid a long
 * segment whose middle was in view while both its ends were not (the
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
  for (let i = 1; i < vertices.length; i += 1) {
    const previous = vertices[i - 1];
    const here = vertices[i];
    const segment = rhumbDeg(previous, here);
    if (run > 0 && run + segment > spacingDeg) {
      samples.push(previous);
      run = 0;
    }
    if (segment > spacingDeg) {
      const steps = Math.ceil(segment / spacingDeg);
      for (let step = 1; step < steps; step += 1)
        samples.push(rhumbPoint(previous, here, step / steps));
      run = segment / steps;
    } else {
      run += segment;
    }
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
