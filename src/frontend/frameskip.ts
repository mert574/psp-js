// Frame skip controls only how often the rAF loop RENDERS — it never changes how
// fast the game runs. Every mode advances exactly one PSP frame per displayed frame
// (paced to ~59.94fps by the rAF throttle in main.ts). Frame skip only decides
// whether that frame is drawn + presented, so skipping makes ticks cheaper and lets
// a render-bound game stay closer to real time, without altering game timing.

/** 0 = Off (render every frame), -1 = Auto (drop a render when render-bound),
 *  1..N = render 1 of every N+1 frames. */
export type FrameSkipMode = number;

export const FRAMESKIP_OFF = 0;
export const FRAMESKIP_AUTO = -1;
