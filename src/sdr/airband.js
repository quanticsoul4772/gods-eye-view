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
/** Default RF bandwidth: a 25 kHz channel's voice passband. */
export const AIRBAND_DEFAULT_BANDWIDTH_HZ = 8_000;
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
 * @returns {{ name: string, carrierHz: number, spacingHz: 25000|8333 }|null}
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
  return {
    name: `${mhz}.${fraction.padEnd(3, '0')}`,
    carrierHz,
    spacingHz: remainder === 0 ? 25_000 : 8_333,
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
 * Silences audio blocks whose signal-to-noise ratio is at or below the
 * threshold, holding the gate open for a short tail so syllables are not
 * clipped. Mirrors the squelch in @jtarrio/signals' player pipeline, which
 * the worker cannot reach because it calls the demodulator directly.
 */
export class SquelchGate {
  /**
   * @param {number} sampleRate - Audio sample rate of the gated blocks.
   * @param {number} [threshold=0] - Linear SNR threshold; 0 never closes.
   *   Noise alone reads about 1 (0–3 dB) on DemodAM's SNR scale, so useful
   *   thresholds start near 3.
   */
  constructor(sampleRate, threshold = 0) {
    this.sampleRate = sampleRate;
    this.threshold = threshold;
    this.tailSamples = 0;
  }

  /**
   * @param {Float32Array} samples - Audio block, silenced in place when closed.
   * @param {number} snr - Linear SNR the demodulator reported for the block.
   * @returns {boolean} Whether the gate passed this block.
   */
  apply(samples, snr) {
    if (!(this.threshold > 0) || snr > this.threshold) {
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
 *   squelch?: number,
 * }} options
 */
export function createAmReceiver({
  sampleRate = AIRBAND_SAMPLE_RATE,
  offsetHz,
  bandwidthHz = AIRBAND_DEFAULT_BANDWIDTH_HZ,
  squelch = 0,
}) {
  const demodulator = getDemod(sampleRate, AIRBAND_AUDIO_RATE, {
    ...getMode('AM'),
    bandwidth: bandwidthHz,
  });
  const gate = new SquelchGate(AIRBAND_AUDIO_RATE, squelch);
  return {
    gate,
    /**
     * @param {Float32Array} i
     * @param {Float32Array} q
     * @returns {{ samples: Float32Array, snr: number, open: boolean }}
     */
    process(i, q) {
      const decoded = demodulator.demodulate(i, q, offsetHz);
      // The demodulator owns pooled output arrays; copy before handing on.
      const samples = new Float32Array(decoded.left);
      const open = gate.apply(samples, decoded.snr);
      return { samples, snr: decoded.snr, open };
    },
  };
}
