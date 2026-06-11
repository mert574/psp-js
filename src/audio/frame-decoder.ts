/**
 * Single-frame audio decoder for sceAudiocodec.
 *
 * Decodes one compressed audio frame → PCM Int16Array.
 * Uses AudioContext.decodeAudioData for MP3/AAC (browser-native),
 * with fallback to silence when unavailable.
 */

const PSP_CODEC_AT3PLUS = 0x1000;
const PSP_CODEC_AT3     = 0x1001;
const PSP_CODEC_MP3     = 0x1002;
const PSP_CODEC_AAC     = 0x1003;

/** Shared OfflineAudioContext for decodeAudioData calls. */
let offlineCtx: OfflineAudioContext | null = null;

function getOfflineCtx(): OfflineAudioContext | null {
  if (typeof OfflineAudioContext === "undefined") return null;
  if (!offlineCtx) {
    // 1 second buffer at 44100 Hz stereo — more than enough for one frame
    offlineCtx = new OfflineAudioContext(2, 44100, 44100);
  }
  return offlineCtx;
}

/**
 * Convert Float32Array AudioBuffer channels to interleaved Int16Array.
 */
function audioBufferToInt16(buf: AudioBuffer, maxSamples?: number): Int16Array {
  const channels = buf.numberOfChannels;
  const length = maxSamples ? Math.min(buf.length, maxSamples) : buf.length;
  const out = new Int16Array(length * channels);
  const ch0 = buf.getChannelData(0);
  const ch1 = channels > 1 ? buf.getChannelData(1) : ch0;

  for (let i = 0; i < length; i++) {
    out[i * 2]     = Math.max(-32768, Math.min(32767, Math.round(ch0[i]! * 32767)));
    out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(ch1[i]! * 32767)));
  }
  return out;
}

/**
 * Decode a single compressed audio frame to PCM.
 *
 * @param data       Compressed frame bytes
 * @param codec      PSP codec type (0x1000-0x1003)
 * @param channels   Expected output channels (1 or 2)
 * @param sampleRate Expected sample rate (typically 44100)
 * @returns Interleaved stereo Int16Array, or null on failure
 */
export async function decodeAudioFrame(
  data: Uint8Array,
  codec: number,
  _channels: number,
  _sampleRate: number,
): Promise<Int16Array | null> {
  switch (codec) {
    case PSP_CODEC_MP3:
      return decodeMp3Frame(data);
    case PSP_CODEC_AAC:
      return decodeAacFrame(data);
    case PSP_CODEC_AT3PLUS:
    case PSP_CODEC_AT3:
      // AT3/AT3+ via sceAudiocodec is rare — games typically use sceAtrac.
      // Return null (caller writes silence) for now.
      return null;
    default:
      return null;
  }
}

/**
 * Decode MP3 frame(s) via AudioContext.decodeAudioData.
 * A single MP3 frame is a valid MP3 "file" — it contains its own sync word,
 * bitrate, sample rate, and channel info.
 */
async function decodeMp3Frame(data: Uint8Array): Promise<Int16Array | null> {
  const ctx = getOfflineCtx();
  if (!ctx) return null;

  try {
    // decodeAudioData needs an ArrayBuffer it can detach — make a copy
    const copy = data.slice().buffer;
    const audioBuf = await ctx.decodeAudioData(copy);
    return audioBufferToInt16(audioBuf);
  } catch {
    return null;
  }
}

/**
 * Decode AAC frame via AudioContext.decodeAudioData.
 * AAC frames need ADTS framing. If the data already has ADTS header (0xFFF),
 * use directly; otherwise wrap it.
 */
async function decodeAacFrame(data: Uint8Array): Promise<Int16Array | null> {
  const ctx = getOfflineCtx();
  if (!ctx) return null;

  try {
    let frameData: ArrayBuffer;
    if (data.length >= 2 && (data[0]! === 0xff) && ((data[1]! & 0xf0) === 0xf0)) {
      // Already has ADTS sync word
      frameData = data.slice().buffer;
    } else {
      // Wrap in minimal ADTS header (7 bytes)
      const adts = buildAdtsHeader(data.length, 44100, 2);
      const wrapped = new Uint8Array(adts.length + data.length);
      wrapped.set(adts);
      wrapped.set(data, adts.length);
      frameData = wrapped.buffer;
    }
    const audioBuf = await ctx.decodeAudioData(frameData);
    return audioBufferToInt16(audioBuf);
  } catch {
    return null;
  }
}

/** Build a 7-byte ADTS header for AAC-LC. */
function buildAdtsHeader(frameLength: number, sampleRate: number, channels: number): Uint8Array {
  // Frequency index: 0=96000, 1=88200, 2=64000, 3=48000, 4=44100, 5=32000, ...
  let freqIdx = 4; // 44100
  if (sampleRate === 48000) freqIdx = 3;
  else if (sampleRate === 32000) freqIdx = 5;

  const totalLen = 7 + frameLength;
  const header = new Uint8Array(7);
  header[0] = 0xff;
  header[1] = 0xf1; // MPEG-4, Layer 0, no CRC
  header[2] = ((1 /* AAC-LC */) << 6) | (freqIdx << 2) | ((channels >> 2) & 0x01);
  header[3] = ((channels & 0x03) << 6) | ((totalLen >> 11) & 0x03);
  header[4] = (totalLen >> 3) & 0xff;
  header[5] = ((totalLen & 0x07) << 5) | 0x1f;
  header[6] = 0xfc;
  return header;
}

/**
 * MP3 frame accumulator for handling bit reservoir dependencies.
 * Keeps the last N frames so decodeAudioData has enough context.
 */
export class Mp3FrameAccumulator {
  private frames: Uint8Array[] = [];
  private readonly maxFrames: number;
  private samplesPerFrame = 1152; // MP3 Layer III at 44100 Hz

  constructor(maxFrames = 3) {
    this.maxFrames = maxFrames;
  }

  /**
   * Add a frame and return the accumulated buffer for decoding.
   * Returns the full accumulated buffer and the expected number of
   * NEW samples (from the latest frame only).
   */
  addFrame(frame: Uint8Array): { buffer: Uint8Array; newSamples: number } {
    this.frames.push(frame);
    if (this.frames.length > this.maxFrames) {
      this.frames.shift();
    }

    // Concatenate all accumulated frames
    const totalLen = this.frames.reduce((s, f) => s + f.length, 0);
    const buf = new Uint8Array(totalLen);
    let off = 0;
    for (const f of this.frames) {
      buf.set(f, off);
      off += f.length;
    }
    return { buffer: buf, newSamples: this.samplesPerFrame };
  }

  /** Decode accumulated frames, return only the latest frame's samples. */
  async decode(): Promise<Int16Array | null> {
    if (this.frames.length === 0) return null;

    const totalLen = this.frames.reduce((s, f) => s + f.length, 0);
    const buf = new Uint8Array(totalLen);
    let off = 0;
    for (const f of this.frames) { buf.set(f, off); off += f.length; }

    const ctx = getOfflineCtx();
    if (!ctx) return null;

    try {
      const copy = buf.slice().buffer;
      const audioBuf = await ctx.decodeAudioData(copy);

      // Return only the samples from the LAST frame
      const totalSamples = audioBuf.length;
      const lastFrameSamples = Math.min(this.samplesPerFrame, totalSamples);
      const startSample = Math.max(0, totalSamples - lastFrameSamples);

      const channels = audioBuf.numberOfChannels;
      const out = new Int16Array(lastFrameSamples * (channels > 1 ? 2 : 2));
      const ch0 = audioBuf.getChannelData(0);
      const ch1 = channels > 1 ? audioBuf.getChannelData(1) : ch0;

      for (let i = 0; i < lastFrameSamples; i++) {
        const si = startSample + i;
        out[i * 2]     = Math.max(-32768, Math.min(32767, Math.round(ch0[si]! * 32767)));
        out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(ch1[si]! * 32767)));
      }
      return out;
    } catch {
      return null;
    }
  }
}
