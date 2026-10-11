import '@jtarrio/signals/demod/demodulator.js';
import { getDemod, getMode } from '@jtarrio/signals/demod/modes.js';

/** Lowest assignable VHF airband voice channel, in Hz. */
export const AIRBAND_MIN_HZ = 118_000_000;
/** Highest 25 kHz VHF airband channel, in Hz. */
export const AIRBAND_MAX_HZ = 136_975_000;
/**
 * The tuner centre sits this far above the channel so the RTL2832U's DC
 * spike falls outside the demodulated passband.
 */
export const AIRBAND_TUNING_OFFSET_HZ = 200_000;
/** Sample rate the AM path runs at; matches the FM path. */
export const AIRBAND_SAMPLE_RATE = 2_048_000;
/** Audio rate delivered to the SDR AudioWorklet. */
export const AIRBAND_AUDIO_RATE = 48_000;
/**
 * RF bandwidth per channel spacing. ICAO Annex 10 Vol III 2.3.2.3-2.3.2.4
 * requires usable audio from a carrier up to 8 kHz off a 25 kHz channel, or
 * 2.5 kHz off an 8.33 kHz channel, where offset-carrier systems are in use.
 * Each passband keeps such a carrier and its inner voice sideband (to about
 * 3.4 kHz) inside the filter.
 */
export const AIRBAND_BANDWIDTH_HZ = Object.freeze({
  25_000: 18_000,
  8_333: 7_000,
});
/** How long the squelch stays open after the signal drops, in seconds. */
export const SQUELCH_TAIL_S = 0.1;

const BLOCK_KHZ = 25;
// ICAO 8.33 kHz channel names: within each 25 kHz block, names ending in
// 5/10/15 kHz select the block's three 8.33 kHz carriers. A name on the block
// boundary is the 25 kHz channel itself.
const NAME_REMAINDER_TO_CARRIER_HZ = new Map([
  [0, 0],
  [5, 0],
  [10, 25_000 / 3],
  [15, 50_000 / 3],
]);

/**
 * Resolve a published airband channel name to the carrier frequency to tune.
 *
 * Accepts 25 kHz channels (118.000, 121.500) and 8.33 kHz channel names
 * (118.005, 132.015), whose names differ from their carriers. Returns null
 * for anything that is not a valid channel name inside the airband.
 *
 * @param {string|number} name - Channel name in MHz, e.g. "118.005".
 * @returns {{
 *   name: string,
 *   carrierHz: number,
 *   spacingHz: 25000|8333,
 *   bandwidthHz: number,
 * }|null}
 */
export function airbandChannel(name) {
  const text = String(name ?? '').trim();
  if (!/^\d{3}(\.\d{1,3})?$/.test(text)) return null;
  const [mhz, fraction = ''] = text.split('.');
  const nameKhz = Number(mhz) * 1000 + Number(fraction.padEnd(3, '0'));
  const blockKhz = Math.floor(nameKhz / BLOCK_KHZ) * BLOCK_KHZ;
  const remainder = nameKhz - blockKhz;
  if (!NAME_REMAINDER_TO_CARRIER_HZ.has(remainder)) return null;
  const carrierHz =
    blockKhz * 1000 + NAME_REMAINDER_TO_CARRIER_HZ.get(remainder);
  if (carrierHz < AIRBAND_MIN_HZ || blockKhz * 1000 > AIRBAND_MAX_HZ)
    return null;
  const spacingHz = remainder === 0 ? 25_000 : 8_333;
  return {
    name: `${mhz}.${fraction.padEnd(3, '0')}`,
    carrierHz,
    spacingHz,
    bandwidthHz: AIRBAND_BANDWIDTH_HZ[spacingHz],
  };
}

/**
 * Snap an arbitrary frequency to the nearest 25 kHz airband channel.
 *
 * @param {number} frequencyHz
 * @returns {number} A 25 kHz channel inside the airband.
 */
export function snapAirbandFrequency(frequencyHz) {
  const value = Number(frequencyHz);
  if (!Number.isFinite(value)) return AIRBAND_MIN_HZ;
  const snapped = Math.round(value / 25_000) * 25_000;
  return Math.min(AIRBAND_MAX_HZ, Math.max(AIRBAND_MIN_HZ, snapped));
}

/**
 * Where to put the tuner centre for a carrier, and where the carrier then
 * lands inside the sampled band.
 *
 * @param {number} carrierHz
 * @returns {{ centerHz: number, offsetHz: number }}
 */
export function airbandTuning(carrierHz) {
  const centerHz = Math.round(carrierHz + AIRBAND_TUNING_OFFSET_HZ);
  return { centerHz, offsetHz: carrierHz - centerHz };
}

/**
 * Estimate the in-channel signal-to-noise ratio, in dB, from DemodAM's SNR.
 *
 * DemodAM reports (in-channel power x audioRate / bandwidth) / total power,
 * whose ceiling is audioRate / bandwidth, so a fixed threshold on it means
 * different things at different bandwidths. This treats the rest of the
 * audio-rate band as the noise floor and returns the in-channel power above
 * that floor. Perfectly flat noise reads -Infinity at any bandwidth; through
 * DemodAM's resampler, noise alone measured about -5 dB and known SNRs of
 * 0-20 dB read 1-2.5 dB high, at both airband bandwidths.
 *
 * @param {number} snr - DemodAM's reported SNR.
 * @param {number} bandwidthHz - The receiver's RF bandwidth.
 * @param {number} [audioRate=AIRBAND_AUDIO_RATE]
 * @returns {number} Estimated channel SNR in dB; -Infinity when none.
 */
export function channelSnrDb(snr, bandwidthHz, audioRate = AIRBAND_AUDIO_RATE) {
  const inChannel = (snr * bandwidthHz) / audioRate;
  if (!(inChannel > 0)) return -Infinity;
  if (inChannel >= 1) return Infinity;
  const noiseInChannel =
    ((1 - inChannel) * bandwidthHz) / (audioRate - bandwidthHz);
  const ratio = inChannel / noiseInChannel - 1;
  return ratio > 0 ? 10 * Math.log10(ratio) : -Infinity;
}

/**
 * Silences audio blocks whose channel SNR is at or below the threshold,
 * holding the gate open for a short tail so syllables are not clipped. The
 * worker calls DemodAM directly, so it cannot use the squelch in
 * @jtarrio/signals' player pipeline.
 */
export class SquelchGate {
  /**
   * @param {number} sampleRate - Audio sample rate of the gated blocks.
   * @param {number|null} [thresholdDb=null] - Channel SNR threshold in dB;
   *   null leaves the gate open.
   */
  constructor(sampleRate, thresholdDb = null) {
    this.sampleRate = sampleRate;
    this.thresholdDb = thresholdDb;
    this.tailSamples = 0;
  }

  /**
   * @param {Float32Array} samples - Audio block, silenced in place when closed.
   * @param {number} snrDb - Channel SNR of the block, from channelSnrDb().
   * @returns {boolean} Whether the gate passed this block.
   */
  apply(samples, snrDb) {
    if (this.thresholdDb === null || snrDb > this.thresholdDb) {
      this.tailSamples = SQUELCH_TAIL_S * this.sampleRate;
      return true;
    }
    if (this.tailSamples > 0) {
      this.tailSamples -= samples.length;
      return true;
    }
    samples.fill(0);
    return false;
  }
}

/**
 * AM voice receiver for one airband carrier: demodulates normalized IQ at a
 * fixed offset from the tuner centre and gates it through the squelch.
 *
 * @param {{
 *   sampleRate?: number,
 *   offsetHz: number,
 *   bandwidthHz?: number,
 *   squelchDb?: number|null,
 * }} options
 */
export function createAmReceiver({
  sampleRate = AIRBAND_SAMPLE_RATE,
  offsetHz,
  bandwidthHz = AIRBAND_BANDWIDTH_HZ[25_000],
  squelchDb = null,
}) {
  const demodulator = getDemod(sampleRate, AIRBAND_AUDIO_RATE, {
    ...getMode('AM'),
    bandwidth: bandwidthHz,
  });
  const gate = new SquelchGate(AIRBAND_AUDIO_RATE, squelchDb);
  return {
    gate,
    /**
     * @param {Float32Array} i
     * @param {Float32Array} q
     * @returns {{ samples: Float32Array, snrDb: number, open: boolean }}
     */
    process(i, q) {
      const decoded = demodulator.demodulate(i, q, offsetHz);
      // The demodulator owns pooled output arrays; copy before handing on.
      const samples = new Float32Array(decoded.left);
      const snrDb = channelSnrDb(decoded.snr, bandwidthHz);
      const open = gate.apply(samples, snrDb);
      return { samples, snrDb, open };
    },
  };
}
