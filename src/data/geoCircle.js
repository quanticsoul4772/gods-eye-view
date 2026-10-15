/**
 * Bounding box ↔ circle helpers shared by the transit and bike-share layers.
 * A box whose west edge is east of its east edge crosses the 180° line
 * (Fiji, the Aleutians): it runs west → 180° → east.
 */

/** Degrees of longitude a box spans, across the 180° line when west > east. */
export function bboxLonSpan(west, east) {
  return west <= east ? east - west : east + 360 - west;
}

/** Whether a longitude lies within a box's west..east, across the 180° line too. */
export function lonInBox(lon, west, east) {
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}

/** Whether two boxes' longitude ranges overlap, either may cross the 180° line. */
export function lonRangesOverlap(aWest, aEast, bWest, bEast) {
  return (
    lonInBox(aWest, bWest, bEast) ||
    lonInBox(aEast, bWest, bEast) ||
    lonInBox(bWest, aWest, aEast) ||
    lonInBox(bEast, aWest, aEast)
  );
}

/** bbox [minLat, minLon, maxLat, maxLon] → centre and covering radius (km). */
export function bboxToCircle([minLat, minLon, maxLat, maxLon]) {
  // Across the 180° line, measure east of west and wrap the centre back.
  if (minLon > maxLon) maxLon += 360;
  const lat = (minLat + maxLat) / 2;
  const rawLon = (minLon + maxLon) / 2;
  const lon = rawLon > 180 ? rawLon - 360 : rawLon;
  const toRad = (d) => (d * Math.PI) / 180;
  const km = (cLat, cLon) => {
    const dLat = toRad(cLat - lat);
    const dLon = toRad(cLon - lon);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat)) * Math.cos(toRad(cLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const radius = Math.max(
    km(minLat, minLon),
    km(minLat, maxLon),
    km(maxLat, minLon),
    km(maxLat, maxLon),
  );
  return {
    center: {
      lat: Math.round(lat * 1e4) / 1e4,
      lon: Math.round(lon * 1e4) / 1e4,
    },
    loadRadiusKm: Math.max(5, Math.ceil(radius)),
  };
}
