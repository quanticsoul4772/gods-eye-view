import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AIRBAND_AUDIO_RATE,
  AIRBAND_BANDWIDTH_HZ,
  AIRBAND_MAX_HZ,
  AIRBAND_MIN_HZ,
  AIRBAND_SAMPLE_RATE,
  AIRBAND_TUNING_OFFSET_HZ,
  SquelchGate,
  airbandChannel,
  airbandTuning,
  channelSnrDb,
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
    bandwidthHz: AIRBAND_BANDWIDTH_HZ[25_000],
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
    assert.equal(channel.bandwidthHz, AIRBAND_BANDWIDTH_HZ[8_333], name);
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

test('channel SNR reads no signal for noise and ignores bandwidth', () => {
  // Noise spread evenly across the audio band: the in-channel share equals
  // the bandwidth share, which is no signal at any bandwidth.
  for (const bandwidthHz of [7_000, 18_000])
    assert.ok(channelSnrDb(1, bandwidthHz) < -100, String(bandwidthHz));
  assert.equal(channelSnrDb(0, 18_000), -Infinity);
  assert.equal(channelSnrDb(Number.NaN, 18_000), -Infinity);
  // All power in the channel: nothing left to call noise.
  assert.equal(channelSnrDb(48_000 / 18_000, 18_000), Infinity);
  // Half the band's power in an 18 kHz channel: noise density is 0.5/30k,
  // so channel noise is 0.3 and channel SNR is 0.5/0.3 - 1 = 2/3.
  assert.ok(
    Math.abs(
      channelSnrDb((0.5 * 48_000) / 18_000, 18_000) - 10 * Math.log10(2 / 3),
    ) < 1e-9,
  );
});

test('squelch with no threshold passes everything', () => {
  const gate = new SquelchGate(AIRBAND_AUDIO_RATE, null);
  const samples = new Float32Array([0.5, -0.5]);
  assert.equal(gate.apply(samples, -Infinity), true);
  assert.deepEqual([...samples], [0.5, -0.5]);
});

test('squelch silences weak blocks after a 0.1 s tail', () => {
  const gate = new SquelchGate(AIRBAND_AUDIO_RATE, 6);
  const block = () => new Float32Array(1_200).fill(0.25);
  assert.equal(gate.apply(block(), 20), true, 'strong signal opens');
  // 0.1 s at 48 kHz is 4,800 samples: four 1,200-sample blocks of tail.
  for (let k = 0; k < 4; k += 1)
    assert.equal(gate.apply(block(), 0), true, `tail block ${k}`);
  const closed = block();
  assert.equal(gate.apply(closed, 0), false, 'closes after the tail');
  assert.ok(closed.every((sample) => sample === 0));
});

/**
 * Receive a 1 kHz AM tone whose carrier sits `carrierOffsetHz` away from the
 * tuned channel, through a receiver of the given spacing's bandwidth.
 */
function receiveTone({ spacingHz, carrierOffsetHz = 0, squelchDb = 6 }) {
  const { offsetHz } = airbandTuning(121_500_000);
  const receiver = createAmReceiver({
    offsetHz,
    bandwidthHz: AIRBAND_BANDWIDTH_HZ[spacingHz],
    squelchDb,
  });
  let result;
  for (const { i, q } of amBlocks({
    offsetHz: offsetHz + carrierOffsetHz,
    noise: 0.05,
  }))
    result = receiver.process(i, q);
  // Skip the start of the block so filter start-up does not count.
  const audio = result.samples.subarray(256);
  const toneDb =
    10 *
    Math.log10(
      tonePower(audio, 1_000, AIRBAND_AUDIO_RATE) /
        tonePower(audio, 2_700, AIRBAND_AUDIO_RATE),
    );
  return { ...result, toneDb };
}

test('an AM carrier on the channel demodulates to its tone', () => {
  for (const spacingHz of [25_000, 8_333]) {
    const result = receiveTone({ spacingHz });
    assert.equal(result.open, true, `${spacingHz} opens`);
    assert.ok(result.toneDb > 20, `${spacingHz}: tone ${result.toneDb} dB`);
  }
});

test('offset carriers within ICAO acceptance bandwidth still demodulate', () => {
  // Annex 10 Vol III 2.3.2.3: within 8 kHz on 25 kHz channels and 2.5 kHz
  // on 8.33 kHz channels where offset-carrier systems are in use.
  const cases = [
    [25_000, 7_500],
    [25_000, -7_500],
    [25_000, 8_000],
    [8_333, 2_500],
    [8_333, -2_500],
  ];
  for (const [spacingHz, carrierOffsetHz] of cases) {
    const result = receiveTone({ spacingHz, carrierOffsetHz });
    const label = `${spacingHz} channel, carrier ${carrierOffsetHz} Hz off`;
    assert.equal(result.open, true, label);
    assert.ok(result.toneDb > 20, `${label}: tone ${result.toneDb} dB`);
  }
});

test('a carrier on another channel is rejected by SNR and squelch', () => {
  // The AM detector normalizes by its own carrier average, so audio level
  // alone cannot show rejection; the reported SNR, which drives the squelch,
  // does.
  const cases = [
    [25_000, [25_000, -25_000, 50_000]],
    [8_333, [8_333, -8_333, 25_000]],
  ];
  for (const [spacingHz, neighbours] of cases) {
    const tuned = receiveTone({ spacingHz });
    for (const carrierOffsetHz of neighbours) {
      const detuned = receiveTone({ spacingHz, carrierOffsetHz });
      const label = `${spacingHz} channel, neighbour ${carrierOffsetHz} Hz`;
      assert.ok(tuned.snrDb - detuned.snrDb > 10, label);
      assert.equal(detuned.open, false, label);
    }
  }
});

test('squelch closes on noise and opens on a carrier', () => {
  const { offsetHz } = airbandTuning(121_500_000);
  const receiver = createAmReceiver({ offsetHz, squelchDb: 6 });
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
