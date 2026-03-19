/**
 * PSP Audio Engine
 *
 * Routes PCM samples from emulated sceAudio calls to the browser speaker via
 * Web Audio API.  All output goes through an AudioWorkletProcessor so the
 * audio callback never blocks the emulator loop.
 *
 * Transport: port mode only — sends {channel, pcm} messages to the worklet,
 * which maintains per-channel queues and mixes them on output.  This enables
 * simultaneous BGM + SFX playback without channel serialisation.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** PSP hardware mixes at 44 100 Hz. */
const PSP_SAMPLE_RATE = 44_100;

/** Number of regular channels (0–7). */
const CHANNEL_COUNT = 8;

/** PSP audio format flag for mono output. */
export const PSP_AUDIO_FORMAT_MONO = 0x10;

/** Maximum volume value in PSP units (maps to ×1.0 gain). */
const PSP_VOL_MAX = 0x8000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AudioChannelState {
  reserved: boolean;
  sampleCount: number;
  /** PSP format flag: 0 = stereo, PSP_AUDIO_FORMAT_MONO = mono. */
  format: number;
  leftVol: number;
  rightVol: number;
}

// ── AudioEngine ──────────────────────────────────────────────────────────────

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;

  private readonly channels: AudioChannelState[] = Array.from(
    { length: CHANNEL_COUNT },
    (): AudioChannelState => ({
      reserved: false,
      sampleCount: 0,
      format: 0,
      leftVol: PSP_VOL_MAX,
      rightVol: PSP_VOL_MAX,
    }),
  );

  private srcChannel: AudioChannelState | null = null;
  private srcSampleRate = PSP_SAMPLE_RATE;

  /** sceAudioOutput2 uses a single shared stereo channel (index 9). */
  private output2Channel: AudioChannelState | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** True after init() completes — false when audio is disabled or destroyed. */
  get isReady(): boolean { return this.ctx !== null; }

  async init(): Promise<void> {
    this.ctx = new AudioContext({ sampleRate: PSP_SAMPLE_RATE });

    try {
      await this.ctx.audioWorklet.addModule(
        new URL("./audio-worklet-processor.ts", import.meta.url),
      );
    } catch {
      // Vite dev serves .ts directly; built output uses .js
      await this.ctx.audioWorklet.addModule(
        new URL("./audio-worklet-processor.js", import.meta.url),
      );
    }

    this.workletNode = new AudioWorkletNode(this.ctx, "psp-audio-processor", {
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.workletNode.connect(this.ctx.destination);

    // Browsers may auto-suspend the AudioContext even during a user gesture.
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  destroy(): void {
    this.workletNode?.disconnect();
    this.ctx?.close();
    this.ctx         = null;
    this.workletNode = null;
  }

  // ── PCM output ─────────────────────────────────────────────────────────────

  /**
   * Enqueue `sampleCount` stereo (or mono) frames from `pcm` into the audio
   * pipeline for the given channel.  Volume is applied in integer arithmetic.
   *
   * @param pcm         Raw s16le samples from guest RAM.
   * @param leftVol     PSP left  volume (0–0x8000).
   * @param rightVol    PSP right volume (0–0x8000).
   * @param sampleCount Number of audio frames.
   * @param mono        True when the channel format is PSP_AUDIO_FORMAT_MONO.
   * @param channelId   PSP channel index (0-7 for regular, 8 for SRC).
   */
  enqueueFrames(
    pcm: Int16Array,
    leftVol: number,
    rightVol: number,
    sampleCount: number,
    mono: boolean,
    channelId: number,
  ): void {
    if (!this.ctx || !this.workletNode) return;

    const chunk = new Int16Array(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
      const [rawL, rawR] = mono
        ? [pcm[i] ?? 0, pcm[i] ?? 0]
        : [pcm[i * 2] ?? 0, pcm[i * 2 + 1] ?? 0];

      chunk[i * 2]     = Math.round((rawL * leftVol)  / PSP_VOL_MAX);
      chunk[i * 2 + 1] = Math.round((rawR * rightVol) / PSP_VOL_MAX);
    }
    // Transfer the buffer so the worklet owns it — zero-copy.
    this.workletNode.port.postMessage(
      { channel: channelId, pcm: chunk },
      [chunk.buffer],
    );
  }

  // ── Occupancy ─────────────────────────────────────────────────────────────

  /** Always returns 0 — per-channel queue mode has no single ring to measure. */
  getRestSamples(): number {
    return 0;
  }

  // ── Channel management ─────────────────────────────────────────────────────

  getChannel(index: number): AudioChannelState | null {
    if (index === CHANNEL_COUNT) return this.srcChannel;
    return this.channels[index] ?? null;
  }

  /**
   * Reserve a regular channel.
   * @param index -1 for auto-assign.
   * @returns Assigned channel index, or -1 on failure.
   */
  reserveChannel(index: number, sampleCount: number, format: number): number {
    // PSP passes -1 (PSP_AUDIO_NEXT_CHANNEL) for auto-assign; getGpr() returns
    // it as unsigned 0xFFFFFFFF, so test the signed reinterpretation.
    const i =
      (index | 0) === -1
        ? this.channels.findIndex((c) => !c.reserved)
        : index;

    if (i < 0 || i >= CHANNEL_COUNT) return -1;

    const ch = this.channels[i]!;
    ch.reserved    = true;
    ch.sampleCount = sampleCount;
    ch.format      = format;
    ch.leftVol     = PSP_VOL_MAX;
    ch.rightVol    = PSP_VOL_MAX;
    return i;
  }

  releaseChannel(index: number): void {
    if (index >= 0 && index < CHANNEL_COUNT) {
      this.channels[index]!.reserved = false;
    }
  }

  reserveSRC(sampleCount: number, freq: number, format: number): void {
    this.srcChannel = {
      reserved: true,
      sampleCount,
      format,
      leftVol:  PSP_VOL_MAX,
      rightVol: PSP_VOL_MAX,
    };
    this.srcSampleRate = freq;
  }

  releaseSRC(): void {
    this.srcChannel = null;
  }

  get srcRate(): number {
    return this.srcSampleRate;
  }

  reserveOutput2(sampleCount: number): void {
    this.output2Channel = {
      reserved: true,
      sampleCount,
      format: 0, // always stereo
      leftVol:  PSP_VOL_MAX,
      rightVol: PSP_VOL_MAX,
    };
  }

  releaseOutput2(): void {
    this.output2Channel = null;
  }

  getOutput2Channel(): AudioChannelState | null {
    return this.output2Channel;
  }
}
