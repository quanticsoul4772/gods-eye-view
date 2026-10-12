import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfReader, PbfWriter } from 'pbf';
import { createFrameReader, frame, WAKE_BYTES } from './protocol.js';
import {
  BAUD_RATE,
  createMeshtasticSession,
  createNodeStore,
  serialSupported,
} from './session.js';

/** A serial port whose radio side the test drives. */
function fakePort() {
  let push;
  const written = [];
  const port = {
    opened: null,
    closed: false,
    readable: new ReadableStream({
      start(controller) {
        push = controller;
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        written.push(new Uint8Array(chunk));
      },
    }),
    async open(options) {
      port.opened = options;
    },
    async close() {
      port.closed = true;
    },
  };
  return {
    port,
    written,
    radio: {
      send: (payload) => push.enqueue(frame(payload)),
      sendRaw: (bytes) => push.enqueue(bytes),
      unplug: () => push.close(),
    },
  };
}

/** ToRadio messages the session wrote, decoded to their tag numbers. */
function sentToRadio(written) {
  const reader = createFrameReader();
  const messages = [];
  for (const chunk of written)
    for (const payload of reader.push(chunk))
      messages.push(
        new PbfReader(payload).readFields((tag, out, pbf) => {
          if (tag === 3) out.wantConfigId = pbf.readVarint();
          else out[`tag${tag}`] = true;
        }, {}),
      );
  return messages;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function nodeInfoPayload({ num, longName, latitudeI, longitudeI, lastHeard }) {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    4,
    (_, w) => {
      w.writeVarintField(1, num);
      w.writeMessage(2, (__, u) => u.writeStringField(2, longName), {});
      if (latitudeI != null)
        w.writeMessage(
          3,
          (__, p) => {
            p.writeSFixed32Field(1, latitudeI);
            p.writeSFixed32Field(2, longitudeI);
          },
          {},
        );
      if (lastHeard) w.writeFixed32Field(5, lastHeard);
    },
    {},
  );
  return pbf.finish();
}

test('connecting wakes the radio, asks for its nodes and goes live', async () => {
  const { port, written, radio } = fakePort();
  const states = [];
  const session = createMeshtasticSession({
    serial: { requestPort: async () => port },
    onChange: (update) => states.push(update),
    delay: async () => {},
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  assert.equal(await session.connect(), true);
  assert.deepEqual(port.opened, { baudRate: BAUD_RATE });
  assert.deepEqual([...written[0]], [...WAKE_BYTES]);
  const [request] = sentToRadio(written.slice(1));
  assert.ok(request.wantConfigId > 0);

  radio.sendRaw(new TextEncoder().encode('DEBUG | console noise\n'));
  radio.send(
    nodeInfoPayload({
      num: 0x1234,
      longName: 'Ridge',
      latitudeI: 302_672_000,
      longitudeI: -977_431_000,
      lastHeard: 1_760_000_000,
    }),
  );
  radio.send(nodeInfoPayload({ num: 0x5678, longName: 'No fix' }));
  const complete = new PbfWriter();
  complete.writeVarintField(7, request.wantConfigId);
  radio.send(complete.finish());
  await tick();

  const last = states.at(-1);
  assert.equal(last.state, 'live');
  assert.equal(last.known, 2);
  assert.equal(last.nodes.length, 1, 'only nodes with a position are drawn');
  assert.equal(last.nodes[0].id, '!00001234');
  assert.equal(last.nodes[0].longName, 'Ridge');
  assert.equal(last.nodes[0].lastHeardMs, 1_760_000_000_000);

  await session.disconnect();
  assert.equal(port.closed, true);
  assert.equal(states.at(-1).state, 'idle');
  // Nothing but the wake bytes and the one config request was ever sent.
  assert.equal(sentToRadio(written.slice(1)).length, 1);
});

test('the heartbeat is the only periodic message', async () => {
  const { port, written } = fakePort();
  let beat;
  const session = createMeshtasticSession({
    serial: { requestPort: async () => port },
    delay: async () => {},
    setIntervalImpl: (fn) => {
      beat = fn;
      return 1;
    },
    clearIntervalImpl: () => {},
  });
  await session.connect();
  beat();
  await tick();
  const messages = sentToRadio(written.slice(1));
  assert.equal(messages.length, 2);
  assert.ok(messages[1].tag7, 'heartbeat');
  await session.disconnect();
});

test('an unplugged radio is reported; a cancelled picker is not an error', async () => {
  const { port, radio } = fakePort();
  const states = [];
  const session = createMeshtasticSession({
    serial: { requestPort: async () => port },
    onChange: (update) => states.push(update),
    delay: async () => {},
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await session.connect();
  radio.unplug();
  await tick();
  assert.equal(states.at(-1).state, 'error');

  const picker = [];
  const cancelled = createMeshtasticSession({
    serial: {
      requestPort: async () => {
        throw Object.assign(new Error('No port selected'), {
          name: 'NotFoundError',
        });
      },
    },
    onChange: (update) => picker.push(update),
  });
  assert.equal(await cancelled.connect(), false);
  assert.equal(picker.at(-1).state, 'idle');
  assert.equal(picker.at(-1).error, undefined);
  assert.equal(serialSupported({}), false);
  assert.equal(serialSupported({ serial: { requestPort() {} } }), true);
});

test('the node store caps its size and ignores frames it cannot use', () => {
  const store = createNodeStore();
  assert.equal(store.apply(null), false);
  for (let num = 1; num <= 2001; num += 1)
    store.apply({ nodeInfo: { num, user: {} } });
  assert.equal(store.list().length, 2000);
});
