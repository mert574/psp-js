// Auto frame skipping: decide how many PSP frames to run per displayed frame.
//
// The emulator's game-internal time is driven by emulated CoreTiming cycles, but
// wall-clock pacing lives in the rAF loop. When the host can't emulate a frame in
// ~16.7ms the game runs in slow motion. Frame skip makes skipped frames cheaper
// (the GE draw + present are suppressed) so more PSP frames fit per wall-second,
// pulling the game back toward 1x real time. It only recovers draw/present cost,
// not MIPS interpreter cost, and audio stays 1x (this is not fast-forward).

/** 0 = Off, -1 = Auto, 1..N = always skip N frames between renders. */
export type FrameSkipMode = number;

export const FRAMESKIP_OFF = 0;
export const FRAMESKIP_AUTO = -1;

/** ~16.683ms — true PSP frame period (vsync is 59.94Hz). */
export const PSP_FRAME_MS = 1001 / 60;
/** Cap so a tab-switch / GC stall can't burst-run a huge batch of frames. */
export const MAX_CATCHUP_MS = 250;
/** Force a real render at least every (MAX_SKIP + 1) frames so the screen never
 *  freezes (PPSSPP caps frame skip around here too). */
export const MAX_SKIP = 8;

export interface FrameSkipResult {
  /** Total PSP frames to run this displayed frame (>= 1; only the last is drawn). */
  frames: number;
  /** Carried-over real time not yet consumed (Auto mode). */
  accumulator: number;
}

/**
 * Pure decision: given the mode, the leftover real-time accumulator, and how much
 * real time passed since the last displayed frame, return how many PSP frames to
 * run now and the new accumulator. Side-effect free so it can be unit-tested.
 */
export function computeFramesToRun(
  mode: FrameSkipMode,
  accumulatorMs: number,
  realDeltaMs: number,
): FrameSkipResult {
  if (mode === FRAMESKIP_AUTO) {
    const acc = accumulatorMs + Math.min(realDeltaMs, MAX_CATCHUP_MS);
    const frames = Math.floor(acc / PSP_FRAME_MS);
    if (frames > MAX_SKIP + 1) {
      // Too far behind (a stall): run the cap and drop the unplayable debt so we
      // don't fast-forward afterward. Missed frames are lost, not replayed.
      return { frames: MAX_SKIP + 1, accumulator: 0 };
    }
    // Carry the sub-frame remainder. frames can be 0 when less than one PSP frame
    // of real time has passed (e.g. a 120Hz rAF) — that tick just presents nothing
    // new. This is what holds the game at 59.94fps regardless of display refresh.
    return { frames, accumulator: acc - frames * PSP_FRAME_MS };
  }
  if (mode > 0) {
    // Fixed: N skipped + 1 rendered.
    return { frames: mode + 1, accumulator: 0 };
  }
  return { frames: 1, accumulator: 0 };
}
