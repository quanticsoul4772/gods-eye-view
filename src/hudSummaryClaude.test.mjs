import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { handleHudSummary } from '../server/providers/openai/hud-summary.js';
import { HUD_SUMMARY_INSTRUCTIONS } from './hudSummaryResponse.js';

/** Set an env var for one test and put the old value back afterwards. */
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

function request(handler, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, {
      method: 'POST',
      url: '/',
      headers: { host: 'localhost:4173', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text = '') {
        resolve({ status: this.statusCode, body: String(text) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function claudeMessage(content, stopReason = 'end_turn') {
  return Response.json({
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

test('an Anthropic key sends the HUD summary to Claude, not OpenAI', async (t) => {
  env(t, 'ANTHROPIC_API_KEY', 'fixture-anthropic-secret');
  env(t, 'OPENAI_API_KEY', 'fixture-openai-secret');
  env(t, 'ANTHROPIC_HUD_SUMMARY_MODEL', undefined);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return claudeMessage([
      { type: 'text', text: 'Downtown San Diego, flights live.' },
    ]);
  });

  const context = { place: 'San Diego' };
  const response = await request(handleHudSummary, JSON.stringify(context));

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    summary: 'Downtown San Diego flights live',
    error: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.equal(sent.system, HUD_SUMMARY_INSTRUCTIONS);
  assert.deepEqual(sent.messages, [
    { role: 'user', content: JSON.stringify(context) },
  ]);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('x-api-key'), 'fixture-anthropic-secret');
  assert.equal(headers.has('authorization'), false);
});

test('a Claude failure answers generically without relaying upstream detail', async (t) => {
  env(t, 'ANTHROPIC_API_KEY', 'fixture-anthropic-secret');
  const leak = 'fixture-anthropic-secret req_fixture_1234 quota exhausted';
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: leak },
      },
      { status: 400 },
    ),
  );

  const response = await request(handleHudSummary, '{}');

  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), {
    summary: null,
    error: 'Claude HUD summary request failed',
  });
  assert.equal(response.body.includes('req_fixture_1234'), false);
});

test('a Claude refusal is a failed summary, not an empty one', async (t) => {
  env(t, 'ANTHROPIC_API_KEY', 'fixture-anthropic-secret');
  t.mock.method(globalThis, 'fetch', async () => claudeMessage([], 'refusal'));

  const response = await request(handleHudSummary, '{}');

  assert.equal(response.status, 502);
  assert.equal(
    JSON.parse(response.body).error,
    'Claude HUD summary request failed',
  );
});
