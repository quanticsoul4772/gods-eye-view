import test from 'node:test';
import assert from 'node:assert/strict';

import { AIRBAND_SAMPLE_RATE, airbandTuning } from './airband.js';

// The worker installs `self.onmessage` at import; give it a stand-in scope.
const posted = [];
globalThis.self = {
  postMessage(message) {
    posted.push(message);
  },
};
await import('./sdr.worker.js');
const send = (data) => globalThis.self.onmessage({ data });

/** One block of 8-bit dongle IQ carrying an AM 1 kHz tone at `offsetHz`. */
function amIqBuffer(offsetHz, samples = 65_536) {
  const bytes = new Uint8Array(samples * 2);
  for (let n = 0; n < samples; n += 1) {
    const t = n / AIRBAND_SAMPLE_RATE;
    const envelope = 0.4 * (1 + 0.8 * Math.cos(2 * Math.PI * 1_000 * t));
    const phase = 2 * Math.PI * offsetHz * t;
    bytes[n * 2] = Math.round(127.5 + 127 * envelope * Math.cos(phase));
    bytes[n * 2 + 1] = Math.round(127.5 + 127 * envelope * Math.sin(phase));
  }
  return bytes.buffer;
}

test('the worker demodulates AM blocks and reports squelch state', () => {
  const { offsetHz } = airbandTuning(121_500_000);
  send({
    type: 'configure',
    mode: 'am',
    sampleRate: AIRBAND_SAMPLE_RATE,
    am: { offsetHz, squelch: 3 },
  });
  posted.length = 0;
  for (let block = 0; block < 3; block += 1)
    send({ type: 'samples', buffer: amIqBuffer(offsetHz) });

  assert.equal(posted.length, 3);
  for (const message of posted) assert.equal(message.type, 'am');
  const last = posted.at(-1);
  assert.ok(last.samples instanceof Float32Array);
  assert.ok(last.samples.length > 0);
  assert.equal(last.squelchOpen, true);
  assert.ok(Number.isFinite(last.snr));
  assert.ok(last.bins instanceof Float32Array, 'every third block has bins');
});

test('a squelch message takes effect without reconfiguring', () => {
  const { offsetHz } = airbandTuning(121_500_000);
  send({
    type: 'configure',
    mode: 'am',
    sampleRate: AIRBAND_SAMPLE_RATE,
    am: { offsetHz, squelch: 0 },
  });
  // A carrier well outside the passband: only noise-level SNR remains.
  const offChannel = amIqBuffer(offsetHz + 400_000);
  posted.length = 0;
  send({ type: 'samples', buffer: offChannel });
  assert.equal(posted.at(-1).squelchOpen, true, 'threshold 0 never closes');

  send({ type: 'squelch', squelch: 6 });
  // Run past the 0.1 s tail the open block left behind.
  for (let block = 0; block < 5; block += 1)
    send({ type: 'samples', buffer: amIqBuffer(offsetHz + 400_000) });
  const last = posted.at(-1);
  assert.equal(last.squelchOpen, false);
  assert.ok(last.samples.every((sample) => sample === 0));
});

test('FM still produces fm messages after visiting AM', () => {
  send({ type: 'configure', mode: 'fm', sampleRate: 2_048_000 });
  posted.length = 0;
  send({ type: 'samples', buffer: amIqBuffer(0) });
  assert.equal(posted.at(-1).type, 'fm');
});
