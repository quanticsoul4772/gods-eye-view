import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AIRBAND_AUDIO_RATE,
  AIRBAND_MAX_HZ,
  AIRBAND_MIN_HZ,
  AIRBAND_SAMPLE_RATE,
  AIRBAND_TUNING_OFFSET_HZ,
  SquelchGate,
  airbandChannel,
  airbandTuning,
  createAmReceiver,
  snapAirbandFrequency,
} from './airband.js';

const BLOCK = 65_536;

/** Deterministic noise so the squelch tests never flake. */
function seededNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32 - 0.5;
  };
}

/**
 * Normalized IQ blocks carrying a carrier at `offsetHz`, amplitude-modulated
 * by a `toneHz` sine at depth `depth`, plus optional noise.
 */
function amBlocks({
  offsetHz,
  toneHz = 1_000,
  depth = 0.8,
  carrier = 0.4,
  noise = 0,
  count = 4,
  seed = 1,
}) {
  const random = seededNoise(seed);
  const blocks = [];
  let n = 0;
  for (let b = 0; b < count; b += 1) {
    const i = new Float32Array(BLOCK);
    const q = new Float32Array(BLOCK);
    for (let k = 0; k < BLOCK; k += 1, n += 1) {
      const t = n / AIRBAND_SAMPLE_RATE;
      const envelope =
        carrier * (1 + depth * Math.cos(2 * Math.PI * toneHz * t));
      const phase = 2 * Math.PI * offsetHz * t;
      i[k] = envelope * Math.cos(phase) + noise * random();
      q[k] = envelope * Math.sin(phase) + noise * random();
    }
    blocks.push({ i, q });
  }
  return blocks;
}

/** Power of one frequency in a block (Goertzel). */
function tonePower(samples, frequencyHz, sampleRate) {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequencyHz) / sampleRate);
  let previous = 0;
  let beforePrevious = 0;
  for (const sample of samples) {
    const current = sample + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  return (
    previous * previous +
    beforePrevious * beforePrevious -
    coefficient * previous * beforePrevious
  );
}

test('25 kHz channel names resolve to their own carrier', () => {
  assert.deepEqual(airbandChannel('118.000'), {
    name: '118.000',
    carrierHz: 118_000_000,
    spacingHz: 25_000,
  });
  assert.equal(airbandChannel('121.5').carrierHz, 121_500_000);
  assert.equal(airbandChannel('121.5').name, '121.500');
  assert.equal(airbandChannel(' 136.975 ').carrierHz, AIRBAND_MAX_HZ);
});

test('8.33 kHz channel names resolve to the carrier, not the name', () => {
  const cases = [
    ['118.005', 118_000_000],
    ['118.010', 118_000_000 + 25_000 / 3],
    ['118.015', 118_000_000 + 50_000 / 3],
    ['132.030', 132_025_000],
    ['136.990', 136_975_000 + 50_000 / 3],
  ];
  for (const [name, carrierHz] of cases) {
    const channel = airbandChannel(name);
    assert.equal(channel.spacingHz, 8_333, name);
    assert.ok(Math.abs(channel.carrierHz - carrierHz) < 1e-6, name);
  }
});

test('names that are not airband channels are refused', () => {
  for (const name of [
    '118.020',
    '118.0083',
    '117.975',
    '137.000',
    '108.000',
    'abc',
    '',
    null,
    '121,5',
  ]) {
    assert.equal(airbandChannel(name), null, String(name));
  }
});

test('frequencies snap to the nearest 25 kHz channel inside the band', () => {
  assert.equal(snapAirbandFrequency(121_512_000), 121_500_000);
  assert.equal(snapAirbandFrequency(121_513_000), 121_525_000);
  assert.equal(snapAirbandFrequency(100_000_000), AIRBAND_MIN_HZ);
  assert.equal(snapAirbandFrequency(150_000_000), AIRBAND_MAX_HZ);
  assert.equal(snapAirbandFrequency(Number.NaN), AIRBAND_MIN_HZ);
});

test('the tuner centre sits off the channel and the offset points back to it', () => {
  const { centerHz, offsetHz } = airbandTuning(121_500_000);
  assert.equal(centerHz, 121_500_000 + AIRBAND_TUNING_OFFSET_HZ);
  assert.equal(centerHz + offsetHz, 121_500_000);
  assert.ok(Math.abs(offsetHz) < AIRBAND_SAMPLE_RATE / 2);
});

test('squelch passes everything at threshold 0', () => {
  const gate = new SquelchGate(AIRBAND_AUDIO_RATE, 0);
  const samples = new Float32Array([0.5, -0.5]);
  assert.equal(gate.apply(samples, 0.1), true);
  assert.deepEqual([...samples], [0.5, -0.5]);
});

test('squelch silences weak blocks after a 0.1 s tail', () => {
  const gate = new SquelchGate(AIRBAND_AUDIO_RATE, 2);
  const block = () => new Float32Array(1_200).fill(0.25);
  assert.equal(gate.apply(block(), 5), true, 'strong signal opens');
  // 0.1 s at 48 kHz is 4,800 samples: four 1,200-sample blocks of tail.
  for (let k = 0; k < 4; k += 1)
    assert.equal(gate.apply(block(), 1), true, `tail block ${k}`);
  const closed = block();
  assert.equal(gate.apply(closed, 1), false, 'closes after the tail');
  assert.ok(closed.every((sample) => sample === 0));
});

test('an AM carrier at the tuning offset demodulates to its tone', () => {
  const { offsetHz } = airbandTuning(121_500_000);
  const receiver = createAmReceiver({ offsetHz });
  let last;
  for (const { i, q } of amBlocks({ offsetHz, noise: 0.05 }))
    last = receiver.process(i, q);
  // Skip the start of the block so filter start-up does not count.
  const audio = last.samples.subarray(256);
  const wanted = tonePower(audio, 1_000, AIRBAND_AUDIO_RATE);
  const other = tonePower(audio, 2_700, AIRBAND_AUDIO_RATE);
  assert.ok(
    10 * Math.log10(wanted / other) > 20,
    `1 kHz tone should dominate (got ${(10 * Math.log10(wanted / other)).toFixed(1)} dB)`,
  );
  assert.equal(last.open, true);
});

test('a carrier on another channel is rejected by SNR and squelch', () => {
  // The AM detector normalizes by its own carrier average, so audio level
  // alone cannot show rejection; the reported SNR, which drives the squelch,
  // does.
  const { offsetHz } = airbandTuning(121_500_000);
  const receive = (detuneHz) => {
    const receiver = createAmReceiver({ offsetHz, squelch: 3 });
    let result;
    for (const { i, q } of amBlocks({
      offsetHz: offsetHz + detuneHz,
      noise: 0.05,
    }))
      result = receiver.process(i, q);
    return result;
  };
  const tuned = receive(0);
  assert.equal(tuned.open, true, 'the tuned channel passes');
  for (const detuneHz of [8_333, 25_000, 50_000, -50_000]) {
    const detuned = receive(detuneHz);
    assert.ok(
      10 * Math.log10(tuned.snr / detuned.snr) > 4,
      `${detuneHz} Hz away reads below the tuned channel`,
    );
    assert.equal(detuned.open, false, `${detuneHz} Hz away is squelched`);
  }
});

test('squelch closes on noise and opens on a carrier', () => {
  const { offsetHz } = airbandTuning(121_500_000);
  const receiver = createAmReceiver({ offsetHz, squelch: 3 });
  const random = seededNoise(7);
  let result;
  for (let b = 0; b < 4; b += 1) {
    const i = new Float32Array(BLOCK).map(() => 0.2 * random());
    const q = new Float32Array(BLOCK).map(() => 0.2 * random());
    result = receiver.process(i, q);
  }
  assert.equal(result.open, false, 'noise alone stays squelched');
  assert.ok(result.samples.every((sample) => sample === 0));

  for (const { i, q } of amBlocks({ offsetHz, noise: 0.2, count: 1, seed: 9 }))
    result = receiver.process(i, q);
  assert.equal(result.open, true, 'a carrier above the noise opens it');
});
