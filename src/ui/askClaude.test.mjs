import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COCKPIT_PREVIEW_CHARS,
  cockpitPreview,
  createClaudeConversation,
  isSlashShortcut,
  messageText,
  runTypedTurn,
} from './askClaude.js';

/** A fake /api/claude/ask that replays scripted replies and records requests. */
function fakeServer(replies) {
  const requests = [];
  return {
    requests,
    post: async (body, { signal } = {}) => {
      requests.push(structuredClone(body));
      signal?.throwIfAborted();
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { status: next.status ?? 200, payload: next };
    },
  };
}
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const question = 'Turn on flights and fly to Denver';
const afterQuestion = [
  { role: 'user', content: question },
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
const pendingReply = () => ({
  messages: afterQuestion,
  pending: [
    {
      id: 'a1',
      name: 'set_layer_visibility',
      input: { layerId: 'flights', enabled: true },
    },
    { id: 'a2', name: 'fly_to_location', input: { query: 'Denver' } },
  ],
  results: [{ type: 'tool_result', tool_use_id: 'q1', content: '{}' }],
});

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

test('a typed turn shows as voice-card events: new turn, message, steps, reply', async () => {
  const flight = {
    ok: true,
    action: 'fly_to_location',
    display: { title: 'Denver', lines: [] },
  };
  const results = {
    set_layer_visibility: { ok: true, action: 'set_layer_visibility' },
    fly_to_location: flight,
  };
  const server = fakeServer([
    pendingReply(),
    { messages: [], answer: 'Flights are on.\nFlying to Denver.' },
  ]);
  const conversation = createClaudeConversation({
    post: server.post,
    run: async (name) => results[name],
  });
  const events = [];
  const holds = [];
  const outcome = await runTypedTurn({
    conversation,
    text: question,
    emit: (event) => events.push(event),
    hold: (on) => holds.push(on),
  });
  assert.equal(outcome.answer, 'Flights are on.\nFlying to Denver.');
  assert.deepEqual(holds, [true, false], 'the card is held for the turn');
  assert.deepEqual(
    events.map((e) => [e.type, e.role ?? e.name ?? '', e.callId ?? '']),
    [
      ['interruption', '', ''],
      ['transcript', 'user', ''],
      ['action-call', 'set_layer_visibility', 'a1'],
      ['action-result', 'set_layer_visibility', 'a1'],
      ['action-call', 'fly_to_location', 'a2'],
      ['action-result', 'fly_to_location', 'a2'],
      ['transcript', 'assistant', ''],
    ],
  );
  assert.equal(events[1].full, true);
  assert.equal(events.at(-1).full, true);
  assert.equal(events.at(-1).text, 'Flights are on.\nFlying to Denver.');
  // The card gets the runner's own result, so its display adapters work.
  assert.equal(events[5].result, flight);
  // Every result goes back to Claude in one user message, in call order.
  assert.deepEqual(
    server.requests[1].messages[2].content.map((block) => block.tool_use_id),
    ['q1', 'a1', 'a2'],
  );
});

test('typing is refused while a voice session is live; nothing is sent', async () => {
  const server = fakeServer([]);
  const events = [];
  const outcome = await runTypedTurn({
    conversation: createClaudeConversation({
      post: server.post,
      run: async () => ({}),
    }),
    text: 'Hello',
    emit: (event) => events.push(event),
    isVoiceActive: () => true,
  });
  assert.equal(outcome.refused, true);
  assert.equal(server.requests.length, 0);
  assert.equal(events.length, 0);
});

test('cancel stops the remaining actions and rolls the conversation back', async () => {
  const controller = new AbortController();
  const ran = [];
  const conversation = createClaudeConversation({
    post: fakeServer([pendingReply()]).post,
    run: async (name, input, { signal }) => {
      ran.push(name);
      controller.abort(); // the user presses Cancel during the first action
      signal.throwIfAborted();
    },
  });
  const events = [];
  const outcome = await runTypedTurn({
    conversation,
    text: question,
    emit: (event) => events.push(event),
    signal: controller.signal,
  });
  assert.equal(outcome.cancelled, true);
  assert.deepEqual(
    ran,
    ['set_layer_visibility'],
    'the second action never ran',
  );
  assert.equal(conversation.length, 0, 'the cancelled exchange is dropped');
  assert.equal(events.at(-1).text, 'Cancelled.');
});

test('setup errors stay out of the card; turn errors become the reply line', async () => {
  const noKey = fakeServer([
    { status: 503, error: 'ANTHROPIC_API_KEY is not set' },
  ]);
  const events = [];
  const outcome = await runTypedTurn({
    conversation: createClaudeConversation({
      post: noKey.post,
      run: async () => ({}),
    }),
    text: 'Hello',
    emit: (event) => events.push(event),
  });
  assert.equal(outcome.setup, true);
  assert.equal(outcome.error, 'ANTHROPIC_API_KEY is not set');
  assert.equal(
    events.some((e) => e.role === 'assistant'),
    false,
    'the composer shows it, not the card',
  );

  const refused = fakeServer([
    { status: 502, error: 'Claude declined this request' },
  ]);
  const turnEvents = [];
  const declined = await runTypedTurn({
    conversation: createClaudeConversation({
      post: refused.post,
      run: async () => ({}),
    }),
    text: 'Hello',
    emit: (event) => turnEvents.push(event),
  });
  assert.equal(declined.setup, false);
  assert.equal(turnEvents.at(-1).text, 'Claude declined this request');

  const offline = createClaudeConversation({
    post: fakeServer([new TypeError('Failed to fetch')]).post,
    run: async () => ({}),
  });
  const down = await offline.send('Hello');
  assert.equal(down.setup, true);
  assert.equal(offline.length, 0);
});

test('follow-ups send the earlier exchange and count as turns', async () => {
  const firstExchange = [
    { role: 'user', content: 'How many planes over Texas?' },
    { role: 'assistant', content: [{ type: 'text', text: '640.' }] },
  ];
  const server = fakeServer([
    { messages: firstExchange, answer: '640.' },
    { messages: [], answer: 'American leads.' },
  ]);
  const conversation = createClaudeConversation({
    post: server.post,
    run: async () => ({}),
  });
  await conversation.send('How many planes over Texas?');
  assert.equal(conversation.turns, 1);
  await conversation.send('Which airline has the most?');
  assert.deepEqual(server.requests[1].messages, [
    ...firstExchange,
    { role: 'user', content: 'Which airline has the most?' },
  ]);
  conversation.reset();
  assert.equal(conversation.turns, 0);
});

test('/ opens typing only without modifiers and outside text fields', () => {
  const outside = { closest: () => null };
  const field = { closest: () => ({}) };
  assert.equal(isSlashShortcut({ key: '/', target: outside }), true);
  assert.equal(isSlashShortcut({ key: '/', target: field }), false);
  assert.equal(
    isSlashShortcut({ key: '/', ctrlKey: true, target: outside }),
    false,
  );
  assert.equal(
    isSlashShortcut({ key: '/', metaKey: true, target: outside }),
    false,
  );
  assert.equal(
    isSlashShortcut({ key: '/', altKey: true, target: outside }),
    false,
  );
  assert.equal(isSlashShortcut({ key: '?', target: outside }), false);
  assert.equal(
    isSlashShortcut({ key: '/', isComposing: true, target: outside }),
    false,
  );
});

test('the cockpit pop-up previews long answers and keeps the rest', () => {
  assert.deepEqual(cockpitPreview('Tracking LXJ445.'), {
    preview: 'Tracking LXJ445.',
    more: false,
  });
  const long = 'x'.repeat(COCKPIT_PREVIEW_CHARS + 50);
  const { preview, more } = cockpitPreview(long);
  assert.equal(more, true);
  assert.equal(preview.length, COCKPIT_PREVIEW_CHARS);
  assert.ok(preview.endsWith('…'));
});
