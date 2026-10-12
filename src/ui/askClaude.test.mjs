import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaudeConversation, messageText } from './askClaude.js';

/** A fake /api/claude/ask that replays scripted replies and records requests. */
function fakeServer(replies) {
  const requests = [];
  return {
    requests,
    post: async (body) => {
      requests.push(structuredClone(body));
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { status: next.status ?? 200, payload: next };
    },
  };
}
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('the camera position rides along with the message', () => {
  assert.equal(messageText('Fly home', null), 'Fly home');
  assert.equal(
    messageText('What is here?', {
      lat: 30.26721,
      lon: -97.74306,
      altitude_m: 1234.6,
    }),
    'What is here?\n\n(The globe camera is over 30.2672, -97.7431 at 1235 m.)',
  );
});

test('Claude’s actions run in order and their results go back in one message', async () => {
  const calls = [];
  const run = async (name, input) => {
    calls.push([name, input]);
    return { ok: true, action: name };
  };
  const afterQuestion = [
    { role: 'user', content: 'Turn on flights and fly to Denver' },
    {
      role: 'assistant',
      content: [
        toolUse('q1', 'aircraft_in_area', {}),
        toolUse('a1', 'set_layer_visibility', {
          layerId: 'flights',
          enabled: true,
        }),
        toolUse('a2', 'fly_to_location', { query: 'Denver' }),
      ],
    },
  ];
  const queryResult = { type: 'tool_result', tool_use_id: 'q1', content: '{}' };
  const server = fakeServer([
    {
      messages: afterQuestion,
      pending: [
        {
          id: 'a1',
          name: 'set_layer_visibility',
          input: { layerId: 'flights', enabled: true },
        },
        { id: 'a2', name: 'fly_to_location', input: { query: 'Denver' } },
      ],
      results: [queryResult],
    },
    { messages: [], answer: 'Flights are on; flying to Denver.' },
  ]);
  const progress = [];
  const conversation = createClaudeConversation({ post: server.post, run });
  const outcome = await conversation.send('Turn on flights and fly to Denver', {
    onProgress: (step) => progress.push(step),
  });
  assert.equal(outcome.answer, 'Flights are on; flying to Denver.');
  assert.equal(outcome.actions, 2);
  assert.deepEqual(calls, [
    ['set_layer_visibility', { layerId: 'flights', enabled: true }],
    ['fly_to_location', { query: 'Denver' }],
  ]);
  assert.deepEqual(progress, ['Switching layers…', 'Flying…']);
  // The second request is the server's conversation plus one user message
  // holding the query result and both action results.
  const second = server.requests[1].messages;
  assert.deepEqual(second.slice(0, 2), afterQuestion);
  assert.deepEqual(
    second[2].content.map((block) => block.tool_use_id),
    ['q1', 'a1', 'a2'],
  );
  assert.deepEqual(JSON.parse(second[2].content[2].content), {
    ok: true,
    action: 'fly_to_location',
  });
});

test('follow-ups send the earlier exchange; a failed exchange is dropped whole', async () => {
  const firstExchange = [
    { role: 'user', content: 'How many planes over Texas?' },
    { role: 'assistant', content: [{ type: 'text', text: '640.' }] },
  ];
  const server = fakeServer([
    { messages: firstExchange, answer: '640.' },
    { status: 502, error: 'Claude request failed' },
    { messages: [], answer: 'American leads.' },
  ]);
  const conversation = createClaudeConversation({
    post: server.post,
    run: async () => ({}),
  });
  await conversation.send('How many planes over Texas?');
  assert.equal(conversation.length, 2);
  const failed = await conversation.send('Which airline has the most?');
  assert.equal(failed.error, 'Claude request failed');
  assert.equal(conversation.length, 2, 'the failed message was not kept');
  await conversation.send('Which airline has the most?');
  assert.deepEqual(server.requests[2].messages, [
    ...firstExchange,
    { role: 'user', content: 'Which airline has the most?' },
  ]);
});

test('an action that throws is reported to Claude, not to the console', async () => {
  const server = fakeServer([
    {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [] },
      ],
      pending: [{ id: 'a1', name: 'track_entity', input: { query: 'UAL1' } }],
      results: [],
    },
    { messages: [], answer: 'Could not find UAL1.' },
  ]);
  const conversation = createClaudeConversation({
    post: server.post,
    run: async () => {
      throw new Error('Nothing matched UAL1');
    },
  });
  const outcome = await conversation.send('Track UAL1');
  assert.equal(outcome.answer, 'Could not find UAL1.');
  const result = server.requests[1].messages.at(-1).content[0];
  assert.deepEqual(JSON.parse(result.content), {
    ok: false,
    error: 'Nothing matched UAL1',
  });
});

test('an unreachable server leaves the conversation as it was', async () => {
  const server = fakeServer([new TypeError('Failed to fetch')]);
  const conversation = createClaudeConversation({
    post: server.post,
    run: async () => ({}),
  });
  const outcome = await conversation.send('Hello');
  assert.match(outcome.error, /Could not reach/);
  assert.equal(conversation.length, 0);
  conversation.reset();
  assert.equal(conversation.length, 0);
});
