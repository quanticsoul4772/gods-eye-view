import assert from 'node:assert/strict';
import test from 'node:test';
import { createAircraftTypeLookup } from './aircraftTypes.js';

const aircraft = (id, extra = {}) => ({
  id,
  typeCode: null,
  registration: null,
  ...extra,
});

/** A fake /api/aircraft-types that records each request's ids. */
function server(known, { status = 200, retryAfter = null } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, '/api/aircraft-types');
    assert.equal(init.method, 'POST');
    const { ids } = JSON.parse(init.body);
    requests.push(ids);
    if (status !== 200)
      return new Response('', {
        status,
        headers: retryAfter ? { 'Retry-After': retryAfter } : {},
      });
    const answered = Object.fromEntries(
      ids.filter((id) => known[id]).map((id) => [id, known[id]]),
    );
    return Response.json({
      aircraft: answered,
      typeNames: { B738: 'BOEING 737-800' },
    });
  };
  return { requests, fetchImpl };
}

test('untyped aircraft get type, name and registration; a feed type is kept', async () => {
  const { requests, fetchImpl } = server({
    a1b2c3: ['B738', 'N123AB'],
    ae0001: ['C17', null],
  });
  const lookup = createAircraftTypeLookup({ fetchImpl });
  const records = [
    aircraft('a1b2c3'),
    aircraft('ae0001'),
    aircraft('ffffff'),
    aircraft('c0ffee', { typeCode: 'A320', registration: 'C-FOO' }),
    aircraft('~12345'),
  ];
  await lookup.fill(records);
  assert.deepEqual(requests, [['a1b2c3', 'ae0001', 'ffffff']]);
  assert.deepEqual(records[0], {
    id: 'a1b2c3',
    typeCode: 'B738',
    typeName: 'BOEING 737-800',
    registration: 'N123AB',
  });
  assert.equal(records[1].typeCode, 'C17');
  assert.equal(records[1].registration, null);
  assert.equal(records[2].typeCode, null, 'unknown to the database');
  assert.equal(records[3].typeCode, 'A320', 'the feed type stands');
  assert.equal(records[4].typeCode, null, 'non-ICAO address');
});

test('each address is asked about once; later snapshots ask only for new ones', async () => {
  const { requests, fetchImpl } = server({ a1b2c3: ['B738', 'N123AB'] });
  const lookup = createAircraftTypeLookup({ fetchImpl });
  await lookup.fill([aircraft('a1b2c3'), aircraft('ffffff')]);
  const next = [aircraft('a1b2c3'), aircraft('ffffff'), aircraft('abcdef')];
  await lookup.fill(next);
  assert.deepEqual(requests, [['a1b2c3', 'ffffff'], ['abcdef']]);
  assert.equal(next[0].typeCode, 'B738', 'answered from memory');
  await lookup.fill([aircraft('a1b2c3'), aircraft('ffffff')]);
  assert.equal(requests.length, 2, 'misses are remembered too');
});

test('a failed lookup leaves records untyped and waits before asking again', async () => {
  let clock = 0;
  const { requests, fetchImpl } = server({}, { status: 503 });
  const lookup = createAircraftTypeLookup({ fetchImpl, now: () => clock });
  const records = [aircraft('a1b2c3')];
  await lookup.fill(records);
  assert.equal(records[0].typeCode, null);
  await lookup.fill(records);
  assert.equal(requests.length, 1, 'no retry inside a minute');
  clock += 60_000;
  await lookup.fill(records);
  assert.equal(requests.length, 2);
});

test('while the server loads, the lookup asks again after its Retry-After', async () => {
  let clock = 0;
  const { requests, fetchImpl } = server({}, { status: 503, retryAfter: '5' });
  const lookup = createAircraftTypeLookup({ fetchImpl, now: () => clock });
  await lookup.fill([aircraft('a1b2c3')]);
  clock += 4_999;
  await lookup.fill([aircraft('a1b2c3')]);
  assert.equal(requests.length, 1);
  clock += 1;
  await lookup.fill([aircraft('a1b2c3')]);
  assert.equal(requests.length, 2);
});

test('an aborted snapshot request rejects instead of filling', async () => {
  const controller = new AbortController();
  const lookup = createAircraftTypeLookup({
    fetchImpl: async () => {
      controller.abort();
      throw controller.signal.reason;
    },
  });
  await assert.rejects(
    lookup.fill([aircraft('a1b2c3')], { signal: controller.signal }),
    { name: 'AbortError' },
  );
});
