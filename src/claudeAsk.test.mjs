import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerQuestion,
  askCatalog,
  parseAskRequest,
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

test('the ask request takes a bounded question and an optional camera', () => {
  assert.deepEqual(
    parseAskRequest(
      JSON.stringify({
        question: ' How many planes? ',
        camera: { lat: 30, lon: -97, altitude_m: 5000 },
      }),
    ),
    {
      question: 'How many planes?',
      camera: { lat: 30, lon: -97, altitude_m: 5000 },
    },
  );
  assert.equal(
    parseAskRequest(JSON.stringify({ question: 'x', camera: { lat: 1 } }))
      .camera,
    null,
  );
  assert.ok(parseAskRequest('not json').error);
  assert.ok(parseAskRequest(JSON.stringify({ question: '  ' })).error);
  assert.ok(
    parseAskRequest(JSON.stringify({ question: 'a'.repeat(501) })).error,
  );
});

test('Claude gets the MCP query tools, without links or panels', () => {
  const { tools } = askCatalog('http://localhost:4173');
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes('aircraft_in_area'));
  assert.ok(names.includes('get_earthquakes'));
  assert.equal(names.includes('show_in_gods_eye_view'), false);
  assert.equal(names.includes('panel_request'), false);
  for (const tool of tools) assert.equal(tool.input_schema.type, 'object');
});

test('a question runs the tools Claude calls and returns its answer and view', async () => {
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
        text('Looking that up.'),
        toolUse('t1', 'aircraft_in_area', { area: { place: 'Texas' } }),
      ],
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 4000,
        output_tokens: 50,
      },
    },
    {
      stop_reason: 'end_turn',
      content: [text('There are 12 aircraft over Texas.')],
      usage: {
        input_tokens: 300,
        cache_read_input_tokens: 4000,
        output_tokens: 20,
      },
    },
  ]);
  const outcome = await answerQuestion({
    client,
    catalog,
    tools: [],
    question: 'How many planes over Texas?',
    camera: { lat: 30.2, lon: -97.7, altitude_m: 12000 },
  });
  assert.deepEqual(outcome, {
    answer: 'There are 12 aircraft over Texas.',
    view,
    tools: ['aircraft_in_area'],
    // Summed over both rounds, so the cost of a question is visible.
    usage: {
      requests: 2,
      input_tokens: 400,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 4000,
      output_tokens: 70,
    },
  });
  const [first, second] = client.requests;
  assert.deepEqual(first.cache_control, { type: 'ephemeral' });
  assert.match(
    first.messages[0].content,
    /over 30\.2000, -97\.7000 at 12000 m/,
  );
  assert.deepEqual(first.fallbacks, 'default');
  // The tool result goes back as one user turn after the assistant's turn.
  const result = second.messages[2].content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 't1');
  assert.equal(JSON.parse(result.content).summary, '12 aircraft in Texas.');
});

test('a failing tool is reported to Claude as an error result', async () => {
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
  const outcome = await answerQuestion({
    client,
    catalog,
    tools: [],
    question: 'Ships near Oakland?',
    camera: null,
  });
  assert.equal(outcome.answer, 'Ship data is unavailable.');
  assert.equal(outcome.view, null);
  const result = client.requests[1].messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.equal(result.content, 'The AIS feed needs a key');
});

test('a refusal is reported without an answer', async () => {
  const client = scriptedClient([{ stop_reason: 'refusal', content: [] }]);
  const outcome = await answerQuestion({
    client,
    catalog: {},
    tools: [],
    question: 'x',
    camera: null,
  });
  assert.equal(outcome.answer, null);
  assert.match(outcome.error, /declined/);
});

test('an answer with no text is reported as an error, not an empty answer', async () => {
  const client = scriptedClient([{ stop_reason: 'end_turn', content: [] }]);
  const outcome = await answerQuestion({
    client,
    catalog: {},
    tools: [],
    question: 'x',
    camera: null,
  });
  assert.equal(outcome.answer, null);
  assert.match(outcome.error, /no answer/);
});
