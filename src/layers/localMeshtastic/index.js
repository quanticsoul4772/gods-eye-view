import * as Cesium from 'cesium';
import { createMeshtasticSession } from '../../meshtastic/session.js';

export const LAYER_ID = 'local-meshtastic';
/** A node not heard for this long is drawn faded. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const COLOR = Cesium.Color.fromCssColorString('#5ef2a0');
const SELF_COLOR = Cesium.Color.fromCssColorString('#ffd166');
const OVERLAY_LIMIT = 200;
const OVERLAY_COLLISION_CAPACITY = 60;

/** A node's short name as a world-overlay label (the app's text system). */
function nameEntry(node, position, color, stale) {
  return {
    id: node.id,
    position,
    variant: 'label',
    title: node.shortName || node.id.slice(-4),
    accent: color.toCssColorString(),
    // Your own radio, then recently heard nodes, win label space.
    priority:
      (node.self ? 1e9 : 0) + (stale ? 0 : 1e6) + (node.lastHeardMs ? 1 : 0),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Card text for one node. Plain text: names come from other people's radios. */
export function describeNode(node, now = Date.now()) {
  const lines = [
    node.longName || node.shortName || node.id,
    `${node.id}${node.role ? ` · ${node.role}` : ''}${node.self ? ' · your radio' : ''}`,
  ];
  if (node.lastHeardMs) {
    const minutes = Math.max(0, Math.round((now - node.lastHeardMs) / 60000));
    lines.push(minutes < 1 ? 'Heard just now' : `Heard ${minutes} min ago`);
  }
  const link = [];
  if (Number.isFinite(node.snr)) link.push(`SNR ${node.snr.toFixed(1)} dB`);
  if (node.hops != null && !node.self)
    link.push(node.hops === 0 ? 'direct' : `${node.hops} hop(s)`);
  if (node.viaMqtt) link.push('via MQTT');
  if (link.length) lines.push(link.join(' · '));
  if (node.precisionM)
    lines.push(`Position shared to about ${node.precisionM} m`);
  return lines.join('\n');
}

/**
 * Nodes your own Meshtastic radio knows about, from a radio plugged into this
 * computer. Hardware-local: never in share links. Constructing it opens no
 * device; the radio connects only from an explicit Connect.
 */
export function createLocalMeshtasticLayer({
  session = null,
  overlayHost,
  picking = null,
  now = () => Date.now(),
} = {}) {
  if (!overlayHost)
    throw new TypeError('Local Meshtastic requires an overlay host');
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let lastUpdate = null;
  let status = { state: 'idle', nodes: [], known: 0 };
  let selectedId = null;
  let clicks = null;
  const listeners = new Set();
  const entityPrefix = `${LAYER_ID}:`;
  /** The clicked node's latest record, or null once it is gone. */
  const selected = () =>
    status.nodes.find((node) => node.id === selectedId) || null;
  const emit = () => {
    const update = { ...status, selected: selected() };
    for (const listener of listeners) listener(update);
  };

  const draw = () => {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    if (!enabled) {
      overlayHost.clearSource(LAYER_ID);
      return;
    }
    const time = now();
    const names = [];
    for (const node of status.nodes) {
      const stale =
        node.lastHeardMs && time - node.lastHeardMs > STALE_AFTER_MS;
      const base = node.self ? SELF_COLOR : COLOR;
      const color = base.withAlpha(stale ? 0.45 : 1);
      const position = Cesium.Cartesian3.fromDegrees(node.lon, node.lat);
      names.push(nameEntry(node, position, color, stale));
      dataSource.entities.add({
        id: `${LAYER_ID}:${node.id}`,
        name: node.longName || node.id,
        position,
        point: {
          pixelSize: node.self ? 11 : 9,
          color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
          outlineWidth: 1.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        // A node that shares a coarse position is somewhere in this circle,
        // not at the dot.
        ...(node.precisionM
          ? {
              ellipse: {
                semiMajorAxis: node.precisionM,
                semiMinorAxis: node.precisionM,
                material: base.withAlpha(0.12),
                outline: true,
                outlineColor: base.withAlpha(0.5),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
            }
          : {}),
      });
    }
    overlayHost.setEntries(LAYER_ID, names.slice(0, OVERLAY_LIMIT), {
      cohortLimit: OVERLAY_LIMIT,
      collisionCapacity: OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
    viewer?.scene?.requestRender?.();
  };

  const onSessionChange = (update) => {
    status = update;
    lastUpdate = now();
    draw();
    emit();
  };
  /** A click on one of this layer's nodes selects it; elsewhere clears it. */
  const onClick = ({ position }) => {
    if (!enabled || !viewer) return;
    const pickedId = picking?.resolvePickId(viewer.scene.pick(position));
    const next = pickedId?.startsWith(entityPrefix)
      ? pickedId.slice(entityPrefix.length)
      : null;
    if (next === selectedId) return;
    selectedId = next;
    emit();
  };
  const radio =
    session || createMeshtasticSession({ onChange: onSessionChange });

  return {
    id: LAYER_ID,
    name: 'Local Meshtastic',
    icon: '📡',
    source: 'Your Meshtastic radio',
    updateInterval: 60000,
    /** The radio session, for the connect card. */
    session: radio,
    /** Follow connection and node changes; returns an unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      listener({ ...status, selected: selected() });
      return () => listeners.delete(listener);
    },

    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(LAYER_ID);
      viewer.dataSources.add(dataSource);
      clicks = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clicks.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(LAYER_ID, true);
      // Other layers' click handlers leave this layer's nodes alone.
      picking?.registerPickOwner(LAYER_ID, (id) => id.startsWith(entityPrefix));
      draw();
    },
    disable() {
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.setVisible(LAYER_ID, false);
      picking?.unregisterPickOwner(LAYER_ID);
      selectedId = null;
      draw();
      emit();
    },
    /** Redraw so "heard N min ago" and staleness stay current. */
    async update() {
      if (!enabled) return false;
      draw();
      return true;
    },
    destroy(nextViewer = viewer) {
      void radio.disconnect({ quiet: true });
      listeners.clear();
      clicks?.destroy();
      clicks = null;
      picking?.unregisterPickOwner(LAYER_ID);
      overlayHost.clearSource(LAYER_ID);
      overlayHost.setVisible(LAYER_ID, false);
      if (dataSource) nextViewer?.dataSources?.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      enabled = false;
    },
    getStats() {
      return {
        count: status.nodes.length,
        lastUpdate,
        error: status.state === 'error' ? status.error || 'Radio error' : null,
      };
    },
  };
}
