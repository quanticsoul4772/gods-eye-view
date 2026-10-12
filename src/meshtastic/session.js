/**
 * A receive-only session with a Meshtastic radio plugged into this computer,
 * over Web Serial (desktop Chrome and Edge). It asks the radio for the nodes
 * it knows, keeps listening for position and nodeinfo packets, and sends
 * nothing else: no text, no position, nothing onto the mesh.
 */

import {
  NODE_ROLES,
  WAKE_BYTES,
  createFrameReader,
  decodeFromRadio,
  encodeHeartbeat,
  encodeWantConfig,
  frame,
  nodeId,
  positionDegrees,
  precisionRadiusM,
} from './protocol.js';

export const BAUD_RATE = 115_200;
/** The serial API closes a session it has not heard from in 15 minutes. */
export const HEARTBEAT_MS = 5 * 60 * 1000;
/** Most nodes kept; the firmware's own node database holds a few hundred. */
export const MAX_NODES = 2000;

/** Whether this browser can open a serial device. */
export function serialSupported(navigatorRef = globalThis.navigator) {
  return Boolean(navigatorRef?.serial?.requestPort);
}

/**
 * Nodes the radio has reported, keyed by node number. Records carry what a
 * map card shows; message content is never stored.
 */
export function createNodeStore({ now = () => Date.now() } = {}) {
  const nodes = new Map();
  let myNodeNum = null;

  const recordFor = (num) => {
    let record = nodes.get(num);
    if (!record) {
      if (nodes.size >= MAX_NODES) return null;
      record = { num, id: nodeId(num) };
      nodes.set(num, record);
    }
    return record;
  };
  const applyUser = (record, user) => {
    if (!user) return;
    if (user.longName) record.longName = user.longName;
    if (user.shortName) record.shortName = user.shortName;
    if (user.hwModel != null) record.hwModel = user.hwModel;
    if (user.role != null) record.role = NODE_ROLES[user.role] ?? null;
  };
  const applyPosition = (record, position) => {
    const where = positionDegrees(position);
    if (!where) return;
    record.lat = where.lat;
    record.lon = where.lon;
    record.altitudeM = Number.isFinite(position.altitudeM)
      ? position.altitudeM
      : null;
    record.precisionM = precisionRadiusM(position.precisionBits);
  };
  const heardAt = (seconds) =>
    Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : now();

  return {
    /** Apply one decoded FromRadio; returns whether anything changed. */
    apply(decoded) {
      if (!decoded) return false;
      let changed = false;
      if (decoded.myNodeNum != null) {
        myNodeNum = decoded.myNodeNum;
        const mine = recordFor(myNodeNum);
        if (mine) mine.self = true;
        changed = true;
      }
      if (decoded.nodeInfo) {
        const info = decoded.nodeInfo;
        const record = recordFor(info.num);
        if (record) {
          applyUser(record, info.user);
          applyPosition(record, info.position);
          if (info.lastHeard) record.lastHeardMs = heardAt(info.lastHeard);
          if (Number.isFinite(info.snr)) record.snr = info.snr;
          if (info.hopsAway != null) record.hops = info.hopsAway;
          record.viaMqtt = info.viaMqtt === true;
          record.self = info.num === myNodeNum;
          changed = true;
        }
      }
      if (decoded.packet) {
        const record = recordFor(decoded.packet.from);
        if (record) {
          applyUser(record, decoded.user);
          applyPosition(record, decoded.position);
          record.lastHeardMs = heardAt(decoded.packet.rxTime);
          if (Number.isFinite(decoded.packet.rxSnr))
            record.snr = decoded.packet.rxSnr;
          if (decoded.packet.hops != null) record.hops = decoded.packet.hops;
          record.viaMqtt = decoded.packet.viaMqtt;
          changed = true;
        }
      }
      return changed;
    },
    /** Every node, with or without a position. */
    list: () => [...nodes.values()].map((record) => ({ ...record })),
    /** Nodes that can be drawn. */
    located: () =>
      [...nodes.values()]
        .filter((record) => Number.isFinite(record.lat))
        .map((record) => ({ ...record })),
    clear() {
      nodes.clear();
      myNodeNum = null;
    },
    get myNodeNum() {
      return myNodeNum;
    },
  };
}

/**
 * Open a radio the user picks and keep the store current. `onChange` runs
 * after each update and on every state change, with
 * `{ state: 'idle'|'connecting'|'syncing'|'live'|'error', error?, nodes }`.
 */
export function createMeshtasticSession({
  serial = globalThis.navigator?.serial,
  onChange = () => {},
  store = createNodeStore(),
  heartbeatMs = HEARTBEAT_MS,
  setIntervalImpl = (fn, ms) => setInterval(fn, ms),
  clearIntervalImpl = (id) => clearInterval(id),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let port = null;
  let reader = null;
  let writer = null;
  let heartbeat = null;
  let state = 'idle';
  let error = null;
  let configNonce = 0;

  const notify = () =>
    onChange({
      state,
      ...(error ? { error } : {}),
      nodes: store.located(),
      known: store.list().length,
    });
  const setState = (next, problem = null) => {
    state = next;
    error = problem;
    notify();
  };
  const send = async (payload) => {
    if (writer) await writer.write(frame(payload));
  };

  const readLoop = async () => {
    const frames = createFrameReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let changed = false;
        for (const payload of frames.push(value)) {
          const decoded = decodeFromRadio(payload);
          if (decoded?.configCompleteId === configNonce && state !== 'live') {
            state = 'live';
            changed = true;
          }
          if (decoded?.rebooted) {
            // A rebooted radio forgets the session; ask again.
            configNonce = (Math.random() * 0xfffffffe + 1) >>> 0;
            state = 'syncing';
            await send(encodeWantConfig(configNonce));
          }
          if (store.apply(decoded)) changed = true;
        }
        if (changed) notify();
      }
    } catch (problem) {
      if (port) setState('error', problem?.message || 'Lost the radio');
      return;
    }
    if (port) setState('error', 'The radio disconnected');
  };

  return {
    get state() {
      return state;
    },
    store,
    /** Ask the user to pick a radio, then start listening. */
    async connect() {
      if (!serial?.requestPort) {
        setState('error', 'This browser cannot open serial devices');
        return false;
      }
      if (port) return true;
      setState('connecting');
      try {
        port = await serial.requestPort();
        await port.open({ baudRate: BAUD_RATE });
        reader = port.readable.getReader();
        writer = port.writable.getWriter();
      } catch (problem) {
        await this.disconnect({ quiet: true });
        // Closing the picker without choosing is not an error.
        setState(
          problem?.name === 'NotFoundError' ? 'idle' : 'error',
          problem?.name === 'NotFoundError'
            ? null
            : problem?.message || 'Could not open the radio',
        );
        return false;
      }
      store.clear();
      setState('syncing');
      void readLoop();
      await writer.write(WAKE_BYTES);
      await delay(100);
      configNonce = (Math.random() * 0xfffffffe + 1) >>> 0;
      await send(encodeWantConfig(configNonce));
      heartbeat = setIntervalImpl(() => {
        void send(encodeHeartbeat()).catch(() => {});
      }, heartbeatMs);
      return true;
    },
    /** Stop listening and release the port. */
    async disconnect({ quiet = false } = {}) {
      const closing = port;
      port = null;
      if (heartbeat != null) clearIntervalImpl(heartbeat);
      heartbeat = null;
      try {
        await reader?.cancel();
      } catch {
        /* already closed */
      }
      reader?.releaseLock?.();
      writer?.releaseLock?.();
      reader = null;
      writer = null;
      try {
        await closing?.close();
      } catch {
        /* already closed */
      }
      if (!quiet) setState('idle');
    },
  };
}
