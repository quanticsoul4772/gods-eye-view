import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASK_SYSTEM,
  askTools,
  parseAskRequest,
  runAskTurn,
} from '../server/claude/ask.js';
import { ToolError } from './tools/catalog.js';

/** A client whose replies are scripted, recording each request. */
function scriptedClient(replies) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        async create(params) {
          requests.push(structuredClone(params));
          return replies.shift();
        },
      },
    },
  };
}

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = (value) => ({ type: 'text', text: value });
const actionNames = new Set(['fly_to_location', 'set_layer_visibility']);
const question = (content) => [{ role: 'user', content }];

test('the request is a conversation that starts with a question and ends with the user', () => {
  assert.deepEqual(
    parseAskRequest(JSON.stringify({ messages: question('Fly to Paris') })),
    { messages: question('Fly to Paris') },
  );
  for (const body of [
    'not json',
    JSON.stringify({}),
    JSON.stringify({ messages: [] }),
    JSON.stringify({ messages: [{ role: 'assistant', content: 'hi' }] }),
    JSON.stringify({ messages: [{ role: 'system', content: 'x' }] }),
    JSON.stringify({
      messages: [...question('x'), { role: 'assistant', content: 'y' }],
    }),
    JSON.stringify({ messages: question('   ') }),
    JSON.stringify({ messages: question('a'.repeat(2001)) }),
  ])
    assert.ok(parseAskRequest(body).error, body.slice(0, 60));
});

test('Claude gets the app actions and the query tools, without duplicates', () => {
  const { tools, actionNames: actions } = askTools('http://localhost:4173');
  const names = tools.map((tool) => tool.name);
  for (const name of [
    'fly_to_location',
    'set_layer_visibility',
    'track_entity',
    'control_cockpit',
    'annotate_map',
    'analyst_query',
  ])
    assert.ok(actions.has(name) && names.includes(name), name);
  assert.ok(names.includes('aircraft_in_area'), 'query tools are offered');
  assert.equal(new Set(names).size, names.length, 'one tool per name');
  for (const left of [
    'show_in_gods_eye_view',
    'panel_request',
    'get_hud_caption',
  ])
    assert.equal(names.includes(left), false, left);
  for (const tool of tools) assert.equal(tool.input_schema.type, 'object');
  assert.match(ASK_SYSTEM, /types instead of speaking/);
  assert.match(ASK_SYSTEM, /turn that layer on/);
});

test('query tools run on the server and the answer comes back', async () => {
  const view = {
    camera: { lat: 31, lon: -99, altitude_m: 900000 },
    layers: ['flights'],
  };
  const catalog = {
    async call(name, args) {
      assert.equal(name, 'aircraft_in_area');
      assert.deepEqual(args, { area: { place: 'Texas' } });
      return { summary: '12 aircraft in Texas.', data: { total: 12, view } };
    },
  };
  const client = scriptedClient([
    {
      stop_reason: 'tool_use',
      content: [
        toolUse('t1', 'aircraft_in_area', { area: { place: 'Texas' } }),
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    {
      stop_reason: 'end_turn',
      content: [text('There are 12 aircraft over Texas.')],
      usage: { input_tokens: 20, output_tokens: 8 },
    },
  ]);
  const outcome = await runAskTurn({
    client,
    catalog,
    tools: [],
    actionNames,
    messages: question('How many planes over Texas?'),
  });
  assert.equal(outcome.answer, 'There are 12 aircraft over Texas.');
  assert.deepEqual(outcome.view, view);
  assert.equal(outcome.usage.requests, 2);
  // The conversation grew by appending only: question, call, result, answer.
  assert.deepEqual(
    outcome.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(outcome.messages[2].content[0].tool_use_id, 't1');
  assert.equal(client.requests[0].system, ASK_SYSTEM);
  assert.equal('fallbacks' in client.requests[0], false, 'Haiku has none');
});

test('app actions go back to the page with the same turn’s query results', async () => {
  const catalog = {
    async call() {
      return { summary: 'Found it.', data: {} };
    },
  };
  const client = scriptedClient([
    {
      stop_reason: 'tool_use',
      content: [
        text('On it.'),
        toolUse('q1', 'find_aircraft', { callsign: 'UAL1' }),
        toolUse('a1', 'fly_to_location', { query: 'Denver' }),
      ],
    },
  ]);
  const outcome = await runAskTurn({
    client,
    catalog,
    tools: [],
    actionNames,
    messages: question('Find UAL1 and fly to Denver'),
  });
  assert.deepEqual(outcome.pending, [
    { id: 'a1', name: 'fly_to_location', input: { query: 'Denver' } },
  ]);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].tool_use_id, 'q1');
  assert.equal(outcome.answer, undefined);
  // The assistant turn is kept so the page can append every result after it.
  assert.equal(outcome.messages.at(-1).role, 'assistant');
});

test('the page’s action results continue the conversation, and follow-ups append', async () => {
  const client = scriptedClient([
    { stop_reason: 'end_turn', content: [text('Flying to Denver.')] },
    { stop_reason: 'end_turn', content: [text('Flights are on.')] },
  ]);
  const afterAction = [
    ...question('Fly to Denver'),
    {
      role: 'assistant',
      content: [toolUse('a1', 'fly_to_location', { query: 'Denver' })],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'a1',
          content: JSON.stringify({ ok: true, action: 'fly_to_location' }),
        },
      ],
    },
  ];
  const first = await runAskTurn({
    client,
    catalog: {},
    tools: [],
    actionNames,
    messages: afterAction,
  });
  assert.equal(first.answer, 'Flying to Denver.');
  const followUp = await runAskTurn({
    client,
    catalog: {},
    tools: [],
    actionNames,
    messages: [
      ...first.messages,
      { role: 'user', content: 'Now turn on flights' },
    ],
  });
  assert.equal(followUp.answer, 'Flights are on.');
  // The second request carried the whole earlier exchange unchanged.
  assert.deepEqual(
    client.requests[1].messages.slice(0, first.messages.length),
    first.messages,
  );
});

test('a failing query tool is reported to Claude as an error result', async () => {
  const catalog = {
    async call() {
      throw new ToolError('unavailable', 'The AIS feed needs a key');
    },
  };
  const client = scriptedClient([
    {
      stop_reason: 'tool_use',
      content: [
        toolUse('t1', 'vessels_in_area', { area: { place: 'Oakland' } }),
      ],
    },
    { stop_reason: 'end_turn', content: [text('Ship data is unavailable.')] },
  ]);
  const outcome = await runAskTurn({
    client,
    catalog,
    tools: [],
    actionNames,
    messages: question('Ships near Oakland?'),
  });
  assert.equal(outcome.answer, 'Ship data is unavailable.');
  const result = client.requests[1].messages[2].content[0];
  assert.equal(result.is_error, true);
  // The code travels with the message, so the model can tell an outage from
  // a missing source (as MCP's structuredContent does).
  assert.deepEqual(JSON.parse(result.content), {
    error: 'unavailable',
    message: 'The AIS feed needs a key',
  });
});

test('refusals and empty answers are errors, not answers', async () => {
  const refused = await runAskTurn({
    client: scriptedClient([{ stop_reason: 'refusal', content: [] }]),
    catalog: {},
    tools: [],
    actionNames,
    messages: question('x'),
  });
  assert.equal(refused.answer, null);
  assert.match(refused.error, /declined/);
  const empty = await runAskTurn({
    client: scriptedClient([{ stop_reason: 'end_turn', content: [] }]),
    catalog: {},
    tools: [],
    actionNames,
    messages: question('x'),
  });
  assert.equal(empty.answer, null);
  assert.match(empty.error, /no answer/);
});

test('larger models ask for server-side refusal fallback', async () => {
  const client = scriptedClient([
    { stop_reason: 'end_turn', content: [text('Done.')] },
  ]);
  await runAskTurn({
    client,
    catalog: {},
    tools: [],
    actionNames,
    messages: question('x'),
    model: 'claude-opus-5-5',
  });
  assert.equal(client.requests[0].fallbacks, 'default');
  assert.deepEqual(client.requests[0].betas, [
    'server-side-fallback-2026-07-01',
  ]);
});
