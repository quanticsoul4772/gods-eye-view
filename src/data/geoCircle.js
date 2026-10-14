/** Bounding box ↔ circle helpers shared by the transit and bike-share layers. */

/** bbox [minLat, minLon, maxLat, maxLon] → centre and covering radius (km). */
export function bboxToCircle([minLat, minLon, maxLat, maxLon]) {
  const lat = (minLat + maxLat) / 2;
  const lon = (minLon + maxLon) / 2;
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
