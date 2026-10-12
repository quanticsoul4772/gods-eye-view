/**
 * The Meshtastic serial stream protocol, receive side: frames off the wire,
 * the parts of FromRadio a map needs, and the two ToRadio messages a listener
 * must send (a config request and a keep-alive heartbeat). Field numbers follow
 * meshtastic/protobufs (mesh.proto, portnums.proto, config.proto).
 *
 * Pure: no device access, so it runs in the page, in workers and in node:test.
 */

import { PbfReader, PbfWriter } from 'pbf';

export const FRAME_START1 = 0x94;
export const FRAME_START2 = 0xc3;
/** Largest payload a radio sends in one frame (MAX_TO_FROM_RADIO_SIZE). */
export const MAX_FRAME_PAYLOAD = 512;
/** Bytes a client writes first so a sleeping serial console wakes into API mode. */
export const WAKE_BYTES = new Uint8Array(32).fill(FRAME_START2);

/** PortNum values this receiver reads; everything else, text included, is ignored. */
export const PORT_POSITION = 3;
export const PORT_NODEINFO = 4;

/** DeviceConfig.Role names, by value. */
export const NODE_ROLES = Object.freeze({
  0: 'CLIENT',
  1: 'CLIENT_MUTE',
  2: 'ROUTER',
  5: 'TRACKER',
  6: 'SENSOR',
  7: 'TAK',
  8: 'CLIENT_HIDDEN',
  9: 'LOST_AND_FOUND',
  10: 'TAK_TRACKER',
  11: 'ROUTER_LATE',
  12: 'CLIENT_BASE',
});

/** Longest string field kept; names are short and node ids are nine characters. */
const MAX_STRING_CHARS = 64;

/**
 * Splits a byte stream into frame payloads. Bytes outside a frame (the debug
 * console prints plain text on the same port) are skipped, and a frame whose
 * length is impossible is abandoned at its first start byte so the stream can
 * resynchronise.
 */
export function createFrameReader() {
  let pending = new Uint8Array(0);
  return {
    /**
     * @param {Uint8Array} chunk Bytes as they arrived.
     * @returns {Uint8Array[]} Complete frame payloads, in order.
     */
    push(chunk) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      const frames = [];
      let at = 0;
      while (at < joined.length) {
        if (joined[at] !== FRAME_START1) {
          at += 1;
          continue;
        }
        if (at + 1 >= joined.length) break;
        if (joined[at + 1] !== FRAME_START2) {
          at += 1;
          continue;
        }
        if (at + 4 > joined.length) break;
        const length = (joined[at + 2] << 8) | joined[at + 3];
        if (length > MAX_FRAME_PAYLOAD) {
          at += 1;
          continue;
        }
        if (at + 4 + length > joined.length) break;
        frames.push(joined.slice(at + 4, at + 4 + length));
        at += 4 + length;
      }
      pending = joined.slice(at);
      return frames;
    },
  };
}

/** Wrap a payload in the stream header. */
export function frame(payload) {
  if (payload.length > MAX_FRAME_PAYLOAD)
    throw new RangeError(`Meshtastic frame too large: ${payload.length}`);
  const bytes = new Uint8Array(4 + payload.length);
  bytes[0] = FRAME_START1;
  bytes[1] = FRAME_START2;
  bytes[2] = (payload.length >> 8) & 0xff;
  bytes[3] = payload.length & 0xff;
  bytes.set(payload, 4);
  return bytes;
}

/** ToRadio { want_config_id }: asks the radio for its node list and config. */
export function encodeWantConfig(nonce) {
  const pbf = new PbfWriter();
  pbf.writeVarintField(3, nonce >>> 0);
  return pbf.finish();
}

/** ToRadio { heartbeat {} }: keeps the serial API session open. */
export function encodeHeartbeat() {
  const pbf = new PbfWriter();
  pbf.writeMessage(7, () => {}, {});
  return pbf.finish();
}

/** Node number → the `!xxxxxxxx` id Meshtastic shows. */
export function nodeId(num) {
  return `!${(num >>> 0).toString(16).padStart(8, '0')}`;
}

function boundedString(pbf) {
  const value = pbf.readString();
  return value.length <= MAX_STRING_CHARS ? value : null;
}

function readPosition(tag, position, pbf) {
  if (tag === 1) position.latitudeI = pbf.readSFixed32();
  else if (tag === 2) position.longitudeI = pbf.readSFixed32();
  else if (tag === 3) position.altitudeM = pbf.readVarint(true);
  else if (tag === 4) position.time = pbf.readFixed32();
  else if (tag === 23) position.precisionBits = pbf.readVarint();
}

function readUser(tag, user, pbf) {
  if (tag === 1) user.id = boundedString(pbf);
  else if (tag === 2) user.longName = boundedString(pbf);
  else if (tag === 3) user.shortName = boundedString(pbf);
  else if (tag === 5) user.hwModel = pbf.readVarint();
  else if (tag === 7) user.role = pbf.readVarint();
}

function readNodeInfo(tag, node, pbf) {
  if (tag === 1) node.num = pbf.readVarint();
  else if (tag === 2) node.user = pbf.readMessage(readUser, {});
  else if (tag === 3) node.position = pbf.readMessage(readPosition, {});
  else if (tag === 4) node.snr = pbf.readFloat();
  else if (tag === 5) node.lastHeard = pbf.readFixed32();
  else if (tag === 8) node.viaMqtt = pbf.readBoolean();
  else if (tag === 9) node.hopsAway = pbf.readVarint();
}

function readData(tag, data, pbf) {
  if (tag === 1) data.portnum = pbf.readVarint();
  else if (tag === 2) data.payload = pbf.readBytes();
}

function readMeshPacket(tag, packet, pbf) {
  if (tag === 1) packet.from = pbf.readFixed32();
  else if (tag === 4) packet.decoded = pbf.readMessage(readData, {});
  else if (tag === 7) packet.rxTime = pbf.readFixed32();
  else if (tag === 8) packet.rxSnr = pbf.readFloat();
  else if (tag === 14) packet.viaMqtt = pbf.readBoolean();
  else if (tag === 15) packet.hopStart = pbf.readVarint();
  else if (tag === 9) packet.hopLimit = pbf.readVarint();
}

function readMyInfo(tag, info, pbf) {
  if (tag === 1) info.myNodeNum = pbf.readVarint();
}

function readFromRadio(tag, message, pbf) {
  if (tag === 2) message.packet = pbf.readMessage(readMeshPacket, {});
  else if (tag === 3) message.myInfo = pbf.readMessage(readMyInfo, {});
  else if (tag === 4) message.nodeInfo = pbf.readMessage(readNodeInfo, {});
  else if (tag === 7) message.configCompleteId = pbf.readVarint();
  else if (tag === 8) message.rebooted = pbf.readBoolean();
}

/**
 * The map-relevant part of one FromRadio frame:
 * `{ myInfo? , nodeInfo?, position?, user?, from?, configCompleteId?, rebooted? }`.
 * A position or nodeinfo packet is decoded from its payload; any other packet
 * (text messages, telemetry, encrypted traffic) yields nothing.
 * @param {Uint8Array} payload One frame payload.
 * @returns {object|null} Null when the frame is not a valid FromRadio.
 */
export function decodeFromRadio(payload) {
  let message;
  try {
    message = new PbfReader(payload).readFields(readFromRadio, {});
  } catch {
    return null;
  }
  const out = {};
  if (message.myInfo?.myNodeNum != null)
    out.myNodeNum = message.myInfo.myNodeNum;
  if (message.nodeInfo?.num != null) out.nodeInfo = message.nodeInfo;
  if (message.configCompleteId != null)
    out.configCompleteId = message.configCompleteId;
  if (message.rebooted) out.rebooted = true;
  const packet = message.packet;
  const decoded = packet?.decoded;
  if (packet?.from != null && decoded?.payload) {
    try {
      if (decoded.portnum === PORT_POSITION)
        out.position = new PbfReader(decoded.payload).readFields(
          readPosition,
          {},
        );
      else if (decoded.portnum === PORT_NODEINFO)
        out.user = new PbfReader(decoded.payload).readFields(readUser, {});
    } catch {
      return Object.keys(out).length ? out : null;
    }
    if (out.position || out.user)
      out.packet = {
        from: packet.from,
        rxTime: packet.rxTime ?? null,
        rxSnr: packet.rxSnr ?? null,
        viaMqtt: packet.viaMqtt === true,
        hops:
          packet.hopStart != null && packet.hopLimit != null
            ? packet.hopStart - packet.hopLimit
            : null,
      };
  }
  return Object.keys(out).length ? out : null;
}

/** Degrees from a Position's integer coordinates, or null when absent or zero. */
export function positionDegrees(position) {
  if (!position) return null;
  const { latitudeI, longitudeI } = position;
  if (!Number.isFinite(latitudeI) || !Number.isFinite(longitudeI)) return null;
  // Firmware sends 0,0 for "no fix".
  if (latitudeI === 0 && longitudeI === 0) return null;
  const lat = latitudeI / 1e7;
  const lon = longitudeI / 1e7;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Radius in metres that a reported precision implies. Meshtastic truncates
 * each coordinate to `precisionBits` high bits of a 32-bit integer of 1e-7°,
 * so the true point lies within one step of the reported one. 0 (unset) or
 * 32 is full precision.
 */
export function precisionRadiusM(precisionBits) {
  const bits = Number(precisionBits);
  if (!Number.isFinite(bits) || bits <= 0 || bits >= 32) return 0;
  const stepDegrees = 2 ** (32 - bits) * 1e-7;
  return Math.round((stepDegrees * 111_320) / 2);
}
