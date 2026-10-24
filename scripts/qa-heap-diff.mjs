#!/usr/bin/env node
/**
 * qa-heap-diff.mjs — what a layer still holds after it is turned off, or
 * (--while-on) what it holds while it is on.
 *
 * Takes a heap snapshot (after GC) with the layer off, turns it on, waits for
 * data, turns it off again, and takes a second snapshot (after GC). Prints the
 * object types whose count or retained size grew between the two, which is
 * what `qa-bench`'s `retainedMiB` reports as a single number.
 *
 * With --while-on the second snapshot is taken with the layer still on, after
 * its data and the ground tiles have loaded, which is what `qa-bench`'s
 * `heapDeltaMiB` reports as a single number. It then also attributes the
 * second snapshot's new objects (absent from the first) by dominator tree:
 * - by constructor: the new heap each type keeps alive, counting only
 *   instances not already inside another instance of the same type;
 * - by data source: the heap that only the source, its entities and its
 *   primitive collections keep alive.
 *
 *   node scripts/qa-heap-diff.mjs --layer local-datacenters [--top 30]
 *   node scripts/qa-heap-diff.mjs --layer cctv --warm-cycles 1 --cycles 2
 *     growth per extra on/off cycle: a cache stays flat, a leak grows
 *   node scripts/qa-heap-diff.mjs --layer local-dams --while-on --basemap esri-imagery
 *
 * Against the dev server the constructor names are readable; the build's are
 * minified. Snapshots are written to qa-shots/heap/<stamp>/ (gitignored) and
 * can be opened in Chrome DevTools > Memory for retainer paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchProbeBrowser } from './qa-renderProbe.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback;
const APP_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
const LAYER = opt('--layer', 'local-datacenters');
const TOP = Number(opt('--top', '30'));
/** On/off cycles before the first snapshot (0: compare against never-on). */
const WARM_CYCLES = Number(opt('--warm-cycles', '0'));
/** On/off cycles between the two snapshots. */
const CYCLES = Number(opt('--cycles', '1'));
/** Second snapshot with the layer on (heap held while on, attributed). */
const WHILE_ON = argv.includes('--while-on');
/** Map stack to measure on (e.g. esri-imagery), as in qa-bench. */
const BASEMAP = opt('--basemap', null);
/** Camera as lat,lon,range m,pitch deg (e.g. 43.2932,5.3726,20000,-35);
 *  the app's opening view when omitted. */
const LOOK = opt('--look', null)?.split(',').map(Number) ?? null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join('qa-shots', 'heap', `${stamp}-${LAYER}`);
fs.mkdirSync(outDir, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mib = (bytes) => (bytes / 2 ** 20).toFixed(2).padStart(8);

async function snapshot(cdp, file) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  const text = chunks.join('');
  fs.writeFileSync(file, text);
  return JSON.parse(text);
}

/** "type:name" for a node: objects by constructor name, the rest by type. */
function nodeKey(snap, typeNames, offsets, i) {
  const { nodes, strings } = snap;
  const type = typeNames[nodes[i + offsets.type]];
  const name =
    type === 'object' || type === 'closure' || type === 'native'
      ? strings[nodes[i + offsets.name]]
      : '';
  return `${type}${name ? `:${name}` : ''}`;
}

function nodeLayout(snap) {
  const meta = snap.snapshot.meta;
  const fields = meta.node_fields;
  return {
    width: fields.length,
    typeNames: meta.node_types[0],
    offsets: {
      type: fields.indexOf('type'),
      name: fields.indexOf('name'),
      id: fields.indexOf('id'),
      size: fields.indexOf('self_size'),
      edges: fields.indexOf('edge_count'),
    },
  };
}

/** Self size and count per "type:name" for every node in a snapshot. */
function aggregate(snap) {
  const { width, typeNames, offsets } = nodeLayout(snap);
  const out = new Map();
  const nodes = snap.nodes;
  for (let i = 0; i < nodes.length; i += width) {
    const key = nodeKey(snap, typeNames, offsets, i);
    const entry = out.get(key) || { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += nodes[i + offsets.size];
    out.set(key, entry);
  }
  return out;
}

/** Every node id in a snapshot (ids are stable across one page's snapshots). */
function nodeIds(snap) {
  const { width, offsets } = nodeLayout(snap);
  const ids = new Set();
  for (let i = 0; i < snap.nodes.length; i += width)
    ids.add(snap.nodes[i + offsets.id]);
  return ids;
}

/**
 * Immediate dominators of every node reachable from the root over non-weak
 * edges (Cooper, Harvey and Kennedy's iterative algorithm), with the
 * postorder they were computed in. Node n is node index n (array offset
 * n * width).
 */
function dominators(snap) {
  const { width, offsets } = nodeLayout(snap);
  const edgeFields = snap.snapshot.meta.edge_fields;
  const edgeWidth = edgeFields.length;
  const edgeType = edgeFields.indexOf('type');
  const edgeTo = edgeFields.indexOf('to_node');
  const weak = snap.snapshot.meta.edge_types[0].indexOf('weak');
  const { nodes, edges } = snap;
  const count = nodes.length / width;
  const firstEdge = new Uint32Array(count + 1);
  for (let n = 0; n < count; n += 1)
    firstEdge[n + 1] =
      firstEdge[n] + nodes[n * width + offsets.edges] * edgeWidth;
  const targets = (n, visit) => {
    for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += edgeWidth)
      if (edges[e + edgeType] !== weak) visit(edges[e + edgeTo] / width);
  };

  // Postorder by iterative depth-first search from the root (node 0).
  const post = new Int32Array(count).fill(-1);
  const order = [];
  const visited = new Uint8Array(count);
  const stack = [0];
  const cursor = new Uint32Array(count);
  visited[0] = 1;
  cursor[0] = firstEdge[0];
  while (stack.length) {
    const n = stack.at(-1);
    let next = -1;
    while (cursor[n] < firstEdge[n + 1]) {
      const e = cursor[n];
      cursor[n] += edgeWidth;
      if (edges[e + edgeType] === weak) continue;
      const to = edges[e + edgeTo] / width;
      if (!visited[to]) {
        next = to;
        break;
      }
    }
    if (next < 0) {
      post[n] = order.length;
      order.push(n);
      stack.pop();
    } else {
      visited[next] = 1;
      cursor[next] = firstEdge[next];
      stack.push(next);
    }
  }

  // Predecessors of reachable nodes, by postorder number.
  const reach = order.length;
  const predCount = new Uint32Array(reach + 1);
  for (const n of order)
    targets(n, (to) => {
      if (post[to] >= 0) predCount[post[to] + 1] += 1;
    });
  for (let p = 0; p < reach; p += 1) predCount[p + 1] += predCount[p];
  const preds = new Int32Array(predCount[reach]);
  const fill = predCount.slice(0, reach);
  for (const n of order)
    targets(n, (to) => {
      if (post[to] >= 0) preds[fill[post[to]]++] = post[n];
    });

  const idom = new Int32Array(reach).fill(-1);
  const root = reach - 1;
  idom[root] = root;
  const intersect = (a, b) => {
    while (a !== b) {
      while (a < b) a = idom[a];
      while (b < a) b = idom[b];
    }
    return a;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let p = root - 1; p >= 0; p -= 1) {
      let dom = -1;
      for (let k = predCount[p]; k < predCount[p + 1]; k += 1) {
        const q = preds[k];
        if (idom[q] < 0) continue;
        dom = dom < 0 ? q : intersect(q, dom);
      }
      if (dom >= 0 && idom[p] !== dom) {
        idom[p] = dom;
        changed = true;
      }
    }
  }
  return { order, post, idom, firstEdge, edgeWidth, edgeTo, edgeType };
}

/** String table indices by value, built once per snapshot. */
const stringIndices = new WeakMap();

/** The node a named property edge of node n points to, or -1. */
function property(snap, tree, n, name) {
  const { width } = nodeLayout(snap);
  const edgeName = snap.snapshot.meta.edge_fields.indexOf('name_or_index');
  const propertyType = snap.snapshot.meta.edge_types[0].indexOf('property');
  if (!stringIndices.has(snap))
    stringIndices.set(
      snap,
      new Map(snap.strings.map((value, index) => [value, index])),
    );
  const nameIndex = stringIndices.get(snap).get(name);
  if (nameIndex === undefined) return -1;
  for (
    let e = tree.firstEdge[n];
    e < tree.firstEdge[n + 1];
    e += tree.edgeWidth
  )
    if (
      snap.edges[e + tree.edgeType] === propertyType &&
      snap.edges[e + edgeName] === nameIndex
    )
      return snap.edges[e + tree.edgeTo] / width;
  return -1;
}

/** Every element edge target of node n (an Array's items). */
function elements(snap, tree, n) {
  const { width } = nodeLayout(snap);
  const elementType = snap.snapshot.meta.edge_types[0].indexOf('element');
  const out = [];
  for (
    let e = tree.firstEdge[n];
    e < tree.firstEdge[n + 1];
    e += tree.edgeWidth
  )
    if (snap.edges[e + tree.edgeType] === elementType)
      out.push(snap.edges[e + tree.edgeTo] / width);
  return out;
}

/**
 * Attribute the snapshot's new nodes (ids absent from `beforeIds`) by
 * constructor and by data source; prints both tables.
 */
function attribute(snap, beforeIds) {
  const { width, typeNames, offsets } = nodeLayout(snap);
  const { nodes, strings } = snap;
  const tree = dominators(snap);
  const { order, post, idom } = tree;
  const reach = order.length;
  const isNew = new Uint8Array(reach);
  const newSize = new Float64Array(reach);
  for (let p = 0; p < reach; p += 1) {
    const i = order[p] * width;
    if (!beforeIds.has(nodes[i + offsets.id])) {
      isNew[p] = 1;
      newSize[p] = nodes[i + offsets.size];
    }
  }
  // New heap under each node: a dominator's postorder number is higher than
  // every node it dominates, so one ascending pass accumulates subtrees.
  const newRetained = Float64Array.from(newSize);
  for (let p = 0; p < reach - 1; p += 1) newRetained[idom[p]] += newRetained[p];

  // By constructor: walk the dominator tree keeping a count of each key on
  // the current path, so an instance inside another of its type is skipped.
  const keyIds = new Map();
  const keyOf = new Int32Array(reach);
  for (let p = 0; p < reach; p += 1) {
    const key = nodeKey(snap, typeNames, offsets, order[p] * width);
    if (!keyIds.has(key)) keyIds.set(key, keyIds.size);
    keyOf[p] = keyIds.get(key);
  }
  const childCount = new Uint32Array(reach + 1);
  for (let p = 0; p < reach - 1; p += 1) childCount[idom[p] + 1] += 1;
  for (let p = 0; p < reach; p += 1) childCount[p + 1] += childCount[p];
  const children = new Int32Array(reach);
  const childFill = childCount.slice(0, reach);
  for (let p = 0; p < reach - 1; p += 1) children[childFill[idom[p]]++] = p;
  const onPath = new Uint32Array(keyIds.size);
  const byKey = new Map();
  const walk = [reach - 1];
  const entered = new Uint8Array(reach);
  while (walk.length) {
    const p = walk.at(-1);
    if (entered[p]) {
      onPath[keyOf[p]] -= 1;
      walk.pop();
      continue;
    }
    entered[p] = 1;
    if (isNew[p] && onPath[keyOf[p]] === 0) {
      const entry = byKey.get(keyOf[p]) || { count: 0, bytes: 0 };
      entry.count += 1;
      entry.bytes += newRetained[p];
      byKey.set(keyOf[p], entry);
    }
    onPath[keyOf[p]] += 1;
    for (let k = childCount[p]; k < childCount[p + 1]; k += 1)
      walk.push(children[k]);
  }
  const keyNames = [...keyIds.keys()];
  const total = newSize.reduce((a, b) => a + b, 0);
  console.log(
    `\nNew heap while on: ${mib(total).trim()} MiB. Kept alive by constructor (outermost instances only):`,
  );
  for (const [id, e] of [...byKey]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, TOP))
    console.log(
      `${mib(e.bytes)} MiB  ${String(e.count).padStart(8)}  ${keyNames[id]}`,
    );

  // By data source (duck-typed: an entity collection and a cluster), the
  // heap only it, its entities and its primitive collections keep alive.
  const owner = new Int32Array(reach).fill(-1);
  const sources = [];
  for (let p = 0; p < reach; p += 1) {
    const n = order[p];
    if (
      property(snap, tree, n, '_entityCollection') < 0 ||
      property(snap, tree, n, '_entityCluster') < 0
    )
      continue;
    const nameNode = property(snap, tree, n, '_name');
    const source = {
      name:
        nameNode >= 0 ? strings[nodes[nameNode * width + offsets.name]] : '?',
      isNew: Boolean(isNew[p]),
      entities: 0,
      bytes: 0,
    };
    const roots = [n];
    for (const field of ['_primitives', '_groundPrimitives'])
      roots.push(property(snap, tree, n, field));
    const collection = property(snap, tree, n, '_entityCollection');
    const associative = property(snap, tree, collection, '_entities');
    const array = property(snap, tree, associative, '_array');
    if (array >= 0)
      for (const entity of elements(snap, tree, array)) {
        roots.push(entity);
        source.entities += 1;
      }
    for (const root of roots)
      if (root >= 0 && post[root] >= 0) owner[post[root]] = sources.length;
    sources.push(source);
  }
  // A dominator precedes the nodes it dominates in descending postorder.
  for (let p = reach - 2; p >= 0; p -= 1) {
    if (owner[p] < 0) owner[p] = owner[idom[p]];
    if (owner[p] >= 0 && isNew[p]) sources[owner[p]].bytes += newSize[p];
  }
  console.log('\nNew heap kept alive only by each data source:');
  for (const s of sources.filter((s) => s.bytes > 0))
    console.log(
      `${mib(s.bytes)} MiB  ${String(s.entities).padStart(8)} entities  ${s.name}${s.isNew ? '' : ' (existed before)'}`,
    );
}

const browser = await launchProbeBrowser({ gpu: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() =>
  sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
);
const cdp = await page.createCDPSession();
await cdp.send('HeapProfiler.enable');
try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.voiceCommands?.runner,
    {
      timeout: 180_000,
    },
  );
  if (BASEMAP)
    await page.evaluate(
      (stack) =>
        window.__godsEyeView.voiceCommands.runner('set_map_stack', { stack }),
      BASEMAP,
    );
  if (LOOK)
    await page.evaluate(([lat, lon, range, pitch]) => {
      const v = window.__godsEyeView.viewer;
      const rad = Math.PI / 180;
      v.camera.lookAt(
        v.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: lon * rad,
          latitude: lat * rad,
          height: 0,
        }),
        { heading: 0, pitch: pitch * rad, range },
      );
      v.camera.lookAtTransform(v.camera.transform.constructor.IDENTITY);
    }, LOOK);
  await pause(8000);
  const enable = () =>
    page.evaluate(async (id) => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled(id, true, { origin: 'user' });
      const t0 = performance.now();
      while (performance.now() - t0 < 60_000) {
        if ((dm.getAll().find((l) => l.id === id)?.stats?.count || 0) > 0)
          break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return dm.getAll().find((l) => l.id === id)?.stats?.count || 0;
    }, LAYER);
  const disable = () =>
    page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.setEnabled(id, false, {
          origin: 'user',
        }),
      LAYER,
    );
  const cycle = async () => {
    const count = await enable();
    await pause(5000);
    await disable();
    await pause(5000);
    return count;
  };
  // The ground loaded: the globe's tiles and every shown 3D tileset's.
  const waitTiles = () =>
    page.waitForFunction(
      () => {
        const scene = window.__godsEyeView.viewer.scene;
        if (!scene.globe.tilesLoaded) return false;
        for (let i = 0; i < scene.primitives.length; i += 1) {
          const p = scene.primitives.get(i);
          if (
            p?.show !== false &&
            typeof p?.tilesLoaded === 'boolean' &&
            !p.tilesLoaded
          )
            return false;
        }
        return true;
      },
      { timeout: 60_000, polling: 200 },
    );
  for (let i = 0; i < WARM_CYCLES; i += 1) await cycle();
  // Tiles still streaming would count as the layer's heap.
  if (WHILE_ON) await waitTiles();
  const beforeSnap = await snapshot(
    cdp,
    path.join(outDir, 'before.heapsnapshot'),
  );
  const before = aggregate(beforeSnap);
  const beforeIds = WHILE_ON ? nodeIds(beforeSnap) : null;
  let on = 0;
  let afterSnap;
  if (WHILE_ON) {
    on = await enable();
    await waitTiles();
    await pause(5000);
    afterSnap = await snapshot(cdp, path.join(outDir, 'on.heapsnapshot'));
  } else {
    for (let i = 0; i < CYCLES; i += 1) on = await cycle();
    afterSnap = await snapshot(
      cdp,
      path.join(outDir, 'after-off.heapsnapshot'),
    );
  }
  const after = aggregate(afterSnap);
  const total = (agg) => [...agg.values()].reduce((a, e) => a + e.bytes, 0);
  console.log(
    `${LAYER}: ${on} objects while on. Heap before ${(total(before) / 2 ** 20).toFixed(1)} MiB, ${WHILE_ON ? 'while on' : 'after off'} ${(total(after) / 2 ** 20).toFixed(1)} MiB`,
  );
  const rows = [];
  for (const [key, e] of after) {
    const b = before.get(key) || { count: 0, bytes: 0 };
    if (e.bytes - b.bytes > 0)
      rows.push({ key, dCount: e.count - b.count, dBytes: e.bytes - b.bytes });
  }
  rows.sort((a, b) => b.dBytes - a.dBytes);
  console.log('\nGrowth by type (self size), second snapshot minus first:');
  for (const r of rows.slice(0, TOP))
    console.log(
      `${mib(r.dBytes)} MiB  ${String(r.dCount).padStart(8)}  ${r.key}`,
    );
  if (WHILE_ON) attribute(afterSnap, beforeIds);
  console.log(`\nSnapshots: ${outDir}`);
} finally {
  await browser.close();
}
