/**
 * PSP AudioWorkletProcessor — runs in AudioWorkletGlobalScope.
 *
 * Per-channel queue mode: each logical PSP channel (0-9) has its own PCM
 * queue.  process() mixes all channels together on output, enabling
 * simultaneous BGM + SFX without serialisation artefacts.
 *
 * Clock handling: the emulator produces audio paced to EMULATED time (the
 * game's audio thread blocks for the sample duration in CoreTiming cycles),
 * while this processor consumes at the AudioContext's WALL-CLOCK 44100 Hz.
 * Those clocks only match when the emulator runs at exactly real time, so we
 * cap the per-channel backlog: if a channel runs too far ahead (emulator burst
 * / faster than real time) we drop the oldest frames so audio can't fall
 * seconds behind the picture. We do NOT gate playback on a minimum buffer —
 * samples play as soon as they arrive (short one-shot SFX must not be held
 * back), and an underrun simply outputs silence until more data arrives.
 *
 * AudioWorkletGlobalScope types are declared in audioworklet-env.d.ts.
 */

const SAMPLE_RATE = 44_100;
/** Drop oldest frames once a channel's backlog passes this (~200 ms) so audio
 *  can't drift unboundedly behind the game. */
const MAX_LATENCY_FRAMES = Math.round(SAMPLE_RATE * 0.2);
/** When trimming, leave this much queued (~70 ms) instead of emptying. */
const TRIM_TARGET_FRAMES = Math.round(SAMPLE_RATE * 0.07);

interface ChannelQueue {
  chunks: Int16Array[];
  /** Read offset, in stereo frames, into the front chunk. */
  offset: number;
  /** Total frames currently queued (across all chunks, minus offset). */
  frames: number;
}

class PspAudioProcessor extends AudioWorkletProcessor {
  private readonly channels = new Map<number, ChannelQueue>();
  /** Emulation-speed multiplier: consume this many input frames per output frame
   *  so audio fast-forwards in step with 2×/4× game speed. 1 = real-time. */
  private speed = 1;

  constructor(_options?: AudioWorkletNodeOptions) {
    super();

    this.port.onmessage = (e: MessageEvent<{ channel: number; pcm: Int16Array } | { speed: number }>) => {
      if ("speed" in e.data) {
        this.speed = e.data.speed > 0 ? e.data.speed : 1;
        return;
      }
      const { channel, pcm } = e.data;
      let q = this.channels.get(channel);
      if (!q) {
        q = { chunks: [], offset: 0, frames: 0 };
        this.channels.set(channel, q);
      }
      q.chunks.push(pcm);
      q.frames += pcm.length >> 1;

      // Latency cap: if the producer ran ahead, drop oldest frames so playback
      // tracks the game instead of lagging further behind every burst.
      if (q.frames > MAX_LATENCY_FRAMES) {
        let drop = q.frames - TRIM_TARGET_FRAMES;
        while (drop > 0 && q.chunks.length > 0) {
          const avail = (q.chunks[0]!.length >> 1) - q.offset;
          if (drop >= avail) {
            q.chunks.shift();
            q.offset = 0;
            q.frames -= avail;
            drop -= avail;
          } else {
            q.offset += drop;
            q.frames -= drop;
            drop = 0;
          }
        }
      }
    };
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0];
    const left = out?.[0];
    const right = out?.[1] ?? left;
    if (!left || !right) return true;

    const n = left.length;
    left.fill(0);
    right.fill(0);

    const speed = this.speed;
    // Channel-outer: add each channel's contribution across the whole buffer in
    // one pass (no per-sample Map iteration on the realtime thread).
    for (const q of this.channels.values()) {
      let off = q.offset;
      let consumed = 0;
      for (let i = 0; i < n; i++) {
        // Skip past exhausted chunks (speed>1 can cross several frames at once).
        while (q.chunks.length > 0 && off >= (q.chunks[0]!.length >> 1)) {
          off -= q.chunks[0]!.length >> 1;
          q.chunks.shift();
        }
        const chunk = q.chunks[0];
        if (!chunk) break; // underrun — rest of the buffer stays silent for this channel
        left[i]! += chunk[off * 2]! / 32768.0;
        right[i]! += chunk[off * 2 + 1]! / 32768.0;
        off += speed;
        consumed += speed;
      }
      q.offset = off;
      q.frames = q.frames > consumed ? q.frames - consumed : 0;
    }

    // Clamp the summed output once.
    for (let i = 0; i < n; i++) {
      const l = left[i]!;
      const r = right[i]!;
      left[i] = l < -1 ? -1 : l > 1 ? 1 : l;
      right[i] = r < -1 ? -1 : r > 1 ? 1 : r;
    }

    return true;
  }
}

registerProcessor("psp-audio-processor", PspAudioProcessor);
