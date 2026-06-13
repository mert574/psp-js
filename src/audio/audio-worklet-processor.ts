/**
 * PSP AudioWorkletProcessor — runs in AudioWorkletGlobalScope.
 *
 * Per-channel queue mode: each logical PSP channel (0-8) has its own PCM
 * queue.  The process() callback mixes all channels together on output,
 * enabling simultaneous BGM + SFX playback without serialisation artefacts.
 *
 * AudioWorkletGlobalScope types are declared in audioworklet-env.d.ts.
 */

class PspAudioProcessor extends AudioWorkletProcessor {
  /** Per-channel PCM chunk queues.  Key = channel index (0-8). */
  private readonly channelQueues: Map<number, Int16Array[]>;
  /** Read offset (in stereo frames) into the front chunk of each channel. */
  private readonly channelOffsets: Map<number, number>;
  /** Emulation-speed multiplier: consume this many input frames per output frame
   *  so audio fast-forwards in step with 2×/4× game speed (and drains its backlog
   *  instead of lagging). 1 = real-time. */
  private speed = 1;

  constructor(_options?: AudioWorkletNodeOptions) {
    super();

    this.channelQueues  = new Map();
    this.channelOffsets = new Map();

    this.port.onmessage = (e: MessageEvent<{channel: number; pcm: Int16Array} | {speed: number}>) => {
      if ("speed" in e.data) {
        this.speed = e.data.speed > 0 ? e.data.speed : 1;
        return;
      }
      const { channel, pcm } = e.data;
      let queue = this.channelQueues.get(channel);
      if (!queue) {
        queue = [];
        this.channelQueues.set(channel, queue);
        this.channelOffsets.set(channel, 0);
      }
      queue.push(pcm);
    };
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _params: Record<string, Float32Array>,
  ): boolean {
    const out   = outputs[0];
    const left  = out?.[0];
    const right = out?.[1] ?? left;
    if (!left || !right) return true;

    const frameCount = left.length;

    for (let i = 0; i < frameCount; i++) {
      let sumL = 0;
      let sumR = 0;

      for (const [channel, queue] of this.channelQueues) {
        // Advance past exhausted chunks. With speed>1 the offset can jump several
        // frames at once, so subtract each consumed chunk's length rather than
        // resetting to 0 (which would drop the overflow).
        let offset = this.channelOffsets.get(channel) ?? 0;
        while (queue.length > 0) {
          const head = queue[0]!;
          if (offset < head.length / 2) break;
          queue.shift();
          offset -= head.length / 2;
        }
        this.channelOffsets.set(channel, offset);

        const chunk = queue[0];
        if (chunk) {
          sumL += (chunk[offset * 2]     ?? 0) / 32768.0;
          sumR += (chunk[offset * 2 + 1] ?? 0) / 32768.0;
          this.channelOffsets.set(channel, offset + this.speed);
        }
      }

      // Clamp mixed output to [-1, 1]
      left[i]  = Math.max(-1, Math.min(1, sumL));
      right[i] = Math.max(-1, Math.min(1, sumR));
    }

    return true;
  }
}

registerProcessor("psp-audio-processor", PspAudioProcessor);
