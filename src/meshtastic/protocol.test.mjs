import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfReader, PbfWriter } from 'pbf';
import {
  MAX_FRAME_PAYLOAD,
  PORT_NODEINFO,
  PORT_POSITION,
  createFrameReader,
  decodeFromRadio,
  encodeHeartbeat,
  encodeWantConfig,
  frame,
  nodeId,
  positionDegrees,
  precisionRadiusM,
} from './protocol.js';

// Encoders for the messages a radio sends, written against mesh.proto's
// field numbers so the decoder is checked against real wire bytes.
function writePosition(p, pbf) {
  if (p.latitudeI != null) pbf.writeSFixed32Field(1, p.latitudeI);
  if (p.longitudeI != null) pbf.writeSFixed32Field(2, p.longitudeI);
  if (p.altitudeM != null) pbf.writeVarintField(3, p.altitudeM);
  if (p.time != null) pbf.writeFixed32Field(4, p.time);
  if (p.precisionBits != null) pbf.writeVarintField(23, p.precisionBits);
}
function writeUser(u, pbf) {
  if (u.id) pbf.writeStringField(1, u.id);
  if (u.longName) pbf.writeStringField(2, u.longName);
  if (u.shortName) pbf.writeStringField(3, u.shortName);
  if (u.hwModel != null) pbf.writeVarintField(5, u.hwModel);
  if (u.role != null) pbf.writeVarintField(7, u.role);
}
const bytesOf = (write, value) => {
  const pbf = new PbfWriter();
  write(value, pbf);
  return pbf.finish();
};
function fromRadioNodeInfo(node) {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    4,
    (n, w) => {
      w.writeVarintField(1, n.num);
      if (n.user) w.writeMessage(2, writeUser, n.user);
      if (n.position) w.writeMessage(3, writePosition, n.position);
      if (n.snr != null) w.writeFloatField(4, n.snr);
      if (n.lastHeard != null) w.writeFixed32Field(5, n.lastHeard);
      if (n.hopsAway != null) w.writeVarintField(9, n.hopsAway);
    },
    node,
  );
  return pbf.finish();
}
function fromRadioPacket({
  from,
  portnum,
  payload,
  rxTime,
  hopStart,
  hopLimit,
}) {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    2,
    (_, w) => {
      w.writeFixed32Field(1, from);
      w.writeMessage(
        4,
        (__, d) => {
          d.writeVarintField(1, portnum);
          d.writeBytesField(2, payload);
        },
        {},
      );
      if (rxTime != null) w.writeFixed32Field(7, rxTime);
      if (hopLimit != null) w.writeVarintField(9, hopLimit);
      if (hopStart != null) w.writeVarintField(15, hopStart);
    },
    {},
  );
  return pbf.finish();
}

test('frames are split from a stream that also carries console text', () => {
  const reader = createFrameReader();
  const a = frame(new Uint8Array([1, 2, 3]));
  const b = frame(new Uint8Array([9]));
  const text = new TextEncoder().encode(
    'INFO  | ??:??:?? 3 [Main] booting\r\n',
  );
  const stream = new Uint8Array([...text, ...a, ...text, ...b]);
  // Arrives in awkward pieces, including a split header.
  const frames = [
    ...reader.push(stream.slice(0, text.length + 2)),
    ...reader.push(stream.slice(text.length + 2, text.length + 5)),
    ...reader.push(stream.slice(text.length + 5)),
  ];
  assert.deepEqual(
    frames.map((f) => [...f]),
    [[1, 2, 3], [9]],
  );
});

test('an impossible frame length resynchronises instead of stalling', () => {
  const reader = createFrameReader();
  const bogus = new Uint8Array([0x94, 0xc3, 0xff, 0xff]);
  const good = frame(new Uint8Array([7, 7]));
  assert.deepEqual(
    reader.push(new Uint8Array([...bogus, ...good])).map((f) => [...f]),
    [[7, 7]],
  );
  assert.throws(() => frame(new Uint8Array(MAX_FRAME_PAYLOAD + 1)));
});

test('the listener sends only a config request and a heartbeat', () => {
  const want = new PbfReader(encodeWantConfig(0xdeadbeef)).readFields(
    (tag, out, pbf) => {
      if (tag === 3) out.wantConfigId = pbf.readVarint();
    },
    {},
  );
  assert.deepEqual(want, { wantConfigId: 0xdeadbeef });
  const heartbeat = new PbfReader(encodeHeartbeat()).readFields(
    (tag, out) => {
      out.tags.push(tag);
    },
    { tags: [] },
  );
  assert.deepEqual(heartbeat.tags, [7]);
});

test('node info from the radio database decodes with user and position', () => {
  const decoded = decodeFromRadio(
    fromRadioNodeInfo({
      num: 0xa1b2c3d4,
      user: {
        id: '!a1b2c3d4',
        longName: 'Hilltop',
        shortName: 'HILL',
        hwModel: 43,
        role: 2,
      },
      position: {
        latitudeI: 302_672_000,
        longitudeI: -977_431_000,
        altitudeM: -12,
        time: 1_760_000_000,
        precisionBits: 13,
      },
      snr: 6.25,
      lastHeard: 1_760_000_100,
      hopsAway: 1,
    }),
  );
  assert.equal(nodeId(decoded.nodeInfo.num), '!a1b2c3d4');
  assert.deepEqual(decoded.nodeInfo.user, {
    id: '!a1b2c3d4',
    longName: 'Hilltop',
    shortName: 'HILL',
    hwModel: 43,
    role: 2,
  });
  assert.equal(decoded.nodeInfo.position.altitudeM, -12);
  assert.equal(decoded.nodeInfo.position.precisionBits, 13);
  assert.equal(decoded.nodeInfo.snr, 6.25);
  assert.equal(decoded.nodeInfo.hopsAway, 1);
  const where = positionDegrees(decoded.nodeInfo.position);
  assert.ok(Math.abs(where.lat - 30.2672) < 1e-9);
  assert.ok(Math.abs(where.lon + 97.7431) < 1e-9);
});

test('position and nodeinfo packets heard live are decoded; text is not', () => {
  const position = decodeFromRadio(
    fromRadioPacket({
      from: 0x11223344,
      portnum: PORT_POSITION,
      payload: bytesOf(writePosition, {
        latitudeI: 515_000_000,
        longitudeI: -1_000_000,
      }),
      rxTime: 1_760_000_200,
      hopStart: 3,
      hopLimit: 1,
    }),
  );
  assert.equal(position.packet.from, 0x11223344);
  assert.equal(position.packet.hops, 2);
  assert.deepEqual(positionDegrees(position.position), {
    lat: 51.5,
    lon: -0.1,
  });

  const user = decodeFromRadio(
    fromRadioPacket({
      from: 0x11223344,
      portnum: PORT_NODEINFO,
      payload: bytesOf(writeUser, { longName: 'Rover', shortName: 'RVR' }),
    }),
  );
  assert.equal(user.user.longName, 'Rover');

  const text = decodeFromRadio(
    fromRadioPacket({
      from: 0x11223344,
      portnum: 1,
      payload: new TextEncoder().encode('meet at the summit'),
    }),
  );
  assert.equal(text, null);
});

test('config completion, my node number and garbage', () => {
  const pbf = new PbfWriter();
  pbf.writeVarintField(7, 42);
  assert.deepEqual(decodeFromRadio(pbf.finish()), { configCompleteId: 42 });
  const mine = new PbfWriter();
  mine.writeMessage(3, (_, w) => w.writeVarintField(1, 0xabc), {});
  assert.deepEqual(decodeFromRadio(mine.finish()), { myNodeNum: 0xabc });
  assert.equal(decodeFromRadio(new Uint8Array([0xff, 0xff, 0xff])), null);
});

test('positions without a fix are dropped and precision becomes a radius', () => {
  assert.equal(positionDegrees({ latitudeI: 0, longitudeI: 0 }), null);
  assert.equal(positionDegrees({}), null);
  assert.equal(
    positionDegrees({ latitudeI: 2_000_000_000, longitudeI: 0 }),
    null,
  );
  assert.equal(precisionRadiusM(0), 0);
  assert.equal(precisionRadiusM(32), 0);
  // Meshtastic's published table: 13 bits ≈ 2.9 km, 16 bits ≈ 364 m.
  assert.equal(precisionRadiusM(13), 2918);
  assert.equal(precisionRadiusM(16), 365);
});
