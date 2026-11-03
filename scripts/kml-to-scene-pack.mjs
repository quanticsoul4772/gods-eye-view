import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * Turn a KML written by the reconstruction scripts (readsb-trace-to-kml,
 * glm-to-kml, nexrad-to-kml, goes-cloud-top-to-kml) into a Director GeoJSON
 * data pack: a FeatureCollection of Point, LineString and Polygon features
 * with string IDs and [lon, lat, height] positions (docs/DIRECTOR-DATA-PACKS.md).
 *
 * Packs carry geometry only: one colour per pack, no per-feature styles. To
 * keep a KML's colour classes apart, pass --styles with the style IDs to keep
 * and write one pack per class. Placemark names are not carried (packs ignore
 * properties).
 *
 * Only the KML these scripts write is read: one Point, LineString or Polygon
 * (outer ring only) per Placemark, coordinates as lon,lat,height. Anything
 * else is refused rather than guessed.
 */

export const PACK_FEATURE_LIMIT = 2000;
export const PACK_POSITION_LIMIT = 50000;

const coordinatesOf = (text) =>
  text
    .trim()
    .split(/\s+/)
    .map((tuple) => {
      const values = tuple.split(',').map(Number);
      if (
        values.length < 2 ||
        values.length > 3 ||
        values.some((v) => !Number.isFinite(v))
      )
        throw new Error(`Unreadable KML coordinates: ${tuple}`);
      return [values[0], values[1], values[2] ?? 0];
    });

/**
 * Placemarks of a script-written KML: {style, type, coordinates}.
 * @returns {{style: string|null, type: string, coordinates: number[][]}[]}
 */
export function kmlPlacemarks(kml) {
  const placemarks = [];
  for (const [, body] of kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
    if (/<(MultiGeometry|innerBoundaryIs|Model|Track)\b/.test(body))
      throw new Error(
        'Only one Point, LineString or Polygon outer ring per Placemark is read',
      );
    const style = /<styleUrl>#([^<]+)<\/styleUrl>/.exec(body)?.[1] ?? null;
    const type = /<(Point|LineString|Polygon)>/.exec(body)?.[1];
    const text = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
    if (!type || !text)
      throw new Error('A Placemark without a Point, LineString or Polygon');
    placemarks.push({ style, type, coordinates: coordinatesOf(text) });
  }
  return placemarks;
}

/**
 * A pack FeatureCollection of the placemarks whose style is in `styles` (all
 * when null), checked against the pack limits.
 */
export function placemarksToPack(placemarks, styles = null) {
  const kept = styles
    ? placemarks.filter((p) => styles.includes(p.style))
    : placemarks;
  if (!kept.length) throw new Error('No placemarks with those styles.');
  if (kept.length > PACK_FEATURE_LIMIT)
    throw new Error(
      `${kept.length} features; a pack holds at most ${PACK_FEATURE_LIMIT}.`,
    );
  let positions = 0;
  const features = kept.map((placemark, i) => {
    positions += placemark.coordinates.length;
    const geometry =
      placemark.type === 'Point'
        ? { type: 'Point', coordinates: placemark.coordinates[0] }
        : placemark.type === 'LineString'
          ? { type: 'LineString', coordinates: placemark.coordinates }
          : { type: 'Polygon', coordinates: [placemark.coordinates] };
    return { type: 'Feature', id: `f${i}`, properties: {}, geometry };
  });
  if (positions > PACK_POSITION_LIMIT)
    throw new Error(
      `${positions} positions; a pack holds at most ${PACK_POSITION_LIMIT}.`,
    );
  return { type: 'FeatureCollection', features };
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) {
  try {
    const args = process.argv.slice(2);
    const at = args.indexOf('--styles');
    const styles = at >= 0 ? args[at + 1]?.split(',').filter(Boolean) : null;
    const rest =
      at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args;
    const [input, output, ...extra] = rest;
    if (!input || !output || extra.length || (at >= 0 && !styles?.length))
      throw new Error(
        'Usage: node scripts/kml-to-scene-pack.mjs <in.kml> <out.json> [--styles <id>[,<id>...]]',
      );
    const pack = placemarksToPack(
      kmlPlacemarks(await readFile(input, 'utf8')),
      styles,
    );
    await writeFile(output, JSON.stringify(pack));
    console.log(`${pack.features.length} features written.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
