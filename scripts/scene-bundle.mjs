import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createSceneBundle } from '../src/director/sharing/bundle.js';
import { parseSceneDocument } from '../src/director/document.js';

/**
 * Package a scene document and its data-pack files into a .gevbundle.json
 * the app's Scenes IMPORT accepts (docs/DIRECTOR-SHARING.md), using the
 * app's own bundle writer. Each pack's source.path is read relative to the
 * asset directory; nothing is fetched.
 */

const MIME = Object.freeze({
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
});

/** The bundle text for a scene document, reading pack files from `assetDir`. */
export async function bundleScene(project, assetDir, read = readFile) {
  const root = path.resolve(assetDir);
  return createSceneBundle(
    parseSceneDocument(JSON.stringify(project)),
    async (pack) => {
      const file = path.resolve(root, pack.source.path);
      // Also correct when the directory is a drive root.
      const inside = path.relative(root, file);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside))
        throw new Error(
          `Pack path leaves the asset directory: ${pack.source.path}`,
        );
      const mimeType = MIME[path.extname(file).toLowerCase()];
      if (!mimeType) throw new Error(`No media type for ${pack.source.path}`);
      return { bytes: new Uint8Array(await read(file)), mimeType };
    },
  );
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) {
  try {
    const [scenePath, assetDir, output, ...rest] = process.argv.slice(2);
    if (!scenePath || !assetDir || !output || rest.length)
      throw new Error(
        'Usage: node scripts/scene-bundle.mjs <scene.json> <asset dir> <out.gevbundle.json>',
      );
    const project = JSON.parse(await readFile(scenePath, 'utf8'));
    const text = await bundleScene(project, assetDir);
    await writeFile(output, text);
    console.log(`${output}: ${(text.length / 1048576).toFixed(1)} MiB.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
