/**
 * Frontend PMF player — thin wrapper around PsmfDecoder.
 * Handles canvas creation and looping rAF playback.
 */

import { PsmfDecoder } from "../media/psmf-decoder.js";
import { Logger } from "../utils/logger.js";

const log = Logger.get("PSMF");

export interface PmfPlayer {
  play(): void;
  stop(): void;
  readonly canvas: HTMLCanvasElement;
}

export async function decodePmfNative(pmfData: Uint8Array): Promise<PmfPlayer> {
  const decoder = new PsmfDecoder();
  await decoder.init(pmfData);
  decoder.onLog = (msg: string) => log.info(msg);
  const frames = await decoder.decode();

  const width  = 480;
  const height = 272;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  let stopped = false;
  let animFrame = 0;
  let frameIdx = 0;
  let startTime = 0;

  if (frames.length === 0) {
    throw new Error("No frames decoded from PMF");
  }

  const frameDuration = 33333; // µs
  const totalDuration = (frames[frames.length - 1]!.pts - frames[0]!.pts) + frameDuration;

  function renderLoop(ts: number) {
    if (stopped || frames.length === 0) return;
    if (startTime === 0) startTime = ts;
    const elapsed = (ts - startTime) * 1000; // ms → µs
    const loopedTime = (elapsed % totalDuration) + frames[0]!.pts;

    let best = 0;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i]!.pts <= loopedTime) best = i;
      else break;
    }
    if (best !== frameIdx) {
      frameIdx = best;
      ctx.drawImage(frames[frameIdx]!.bitmap, 0, 0, width, height);
    }
    animFrame = requestAnimationFrame(renderLoop);
  }

  // Draw first frame immediately
  ctx.drawImage(frames[0]!.bitmap, 0, 0, width, height);

  return {
    canvas,
    play() {
      stopped = false;
      startTime = 0;
      frameIdx = 0;
      animFrame = requestAnimationFrame(renderLoop);
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(animFrame);
    },
  };
}
