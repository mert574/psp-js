import { describe, it, expect } from "vitest";
import {
  computeFramesToRun,
  FRAMESKIP_OFF,
  FRAMESKIP_AUTO,
  PSP_FRAME_MS,
  MAX_SKIP,
  MAX_CATCHUP_MS,
} from "../src/frontend/frameskip.js";

describe("computeFramesToRun", () => {
  it("Off mode always runs exactly one frame and keeps no accumulator", () => {
    const r = computeFramesToRun(FRAMESKIP_OFF, 0, 1000);
    expect(r.frames).toBe(1);
    expect(r.accumulator).toBe(0);
  });

  it("fixed mode N runs N+1 frames (N skipped + 1 rendered)", () => {
    expect(computeFramesToRun(2, 0, 16).frames).toBe(3);
    expect(computeFramesToRun(3, 0, 16).frames).toBe(4);
    expect(computeFramesToRun(1, 0, 16).accumulator).toBe(0);
  });

  it("Auto runs one frame at a normal ~60fps delta", () => {
    const r = computeFramesToRun(FRAMESKIP_AUTO, 0, PSP_FRAME_MS);
    expect(r.frames).toBe(1);
  });

  it("Auto paces to ~59.94fps on a faster-than-60Hz display (no over-run)", () => {
    // Simulate a 120Hz rAF: ticks of half a PSP frame. Over many ticks the number
    // of frames run must track real time, not the refresh rate.
    let acc = 0;
    let frames = 0;
    const TICKS = 240; // 2 seconds of 120Hz ticks
    for (let i = 0; i < TICKS; i++) {
      const r = computeFramesToRun(FRAMESKIP_AUTO, acc, PSP_FRAME_MS / 2);
      acc = r.accumulator;
      frames += r.frames;
    }
    // 2s of real time -> ~120 PSP frames, NOT 240 (one per tick).
    expect(frames).toBeGreaterThanOrEqual(118);
    expect(frames).toBeLessThanOrEqual(121);
  });

  it("Auto runs more frames when real time ran ahead", () => {
    // 3 PSP frames' worth of real time passed since the last displayed frame.
    const r = computeFramesToRun(FRAMESKIP_AUTO, 0, PSP_FRAME_MS * 3);
    expect(r.frames).toBe(3);
  });

  it("Auto floors to whole frames and carries the remainder", () => {
    // 2.5 frames of real time -> run 2, carry ~0.5 frame.
    const r = computeFramesToRun(FRAMESKIP_AUTO, 0, PSP_FRAME_MS * 2.5);
    expect(r.frames).toBe(2);
    expect(r.accumulator).toBeCloseTo(PSP_FRAME_MS * 0.5, 3);
    // The carried half-frame plus another 2.5 frames -> 3 frames next tick.
    const r2 = computeFramesToRun(FRAMESKIP_AUTO, r.accumulator, PSP_FRAME_MS * 2.5);
    expect(r2.frames).toBe(3);
  });

  it("Auto runs zero frames on a sub-frame delta and banks the time", () => {
    // 1ms is far less than one PSP frame: run nothing, carry the 1ms forward.
    const r = computeFramesToRun(FRAMESKIP_AUTO, 0, 1);
    expect(r.frames).toBe(0);
    expect(r.accumulator).toBeCloseTo(1, 5);
  });

  it("Auto clamps a huge stall to MAX_CATCHUP then MAX_SKIP+1 frames", () => {
    // A 5s tab-switch stall must not burst-run hundreds of frames.
    const r = computeFramesToRun(FRAMESKIP_AUTO, 0, 5000);
    expect(r.frames).toBe(MAX_SKIP + 1);
    // Debt past the cap is dropped, not banked, so the next frame isn't a burst.
    expect(r.accumulator).toBe(0);
    // The catch-up window admits more frames than the cap, so the cap is what binds.
    expect(MAX_CATCHUP_MS / PSP_FRAME_MS).toBeGreaterThan(MAX_SKIP + 1);
  });
});
