/**
 * Game boot regression tests — boot real ISOs headless and assert the game
 * reaches a healthy rendering state. Skipped when fixtures are missing.
 *
 * Puzzle Bobble is the reference "fully working" game (boots, renders,
 * runs gameplay) — keep it green.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bootGame, PspButton } from "./helpers/boot-game.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const PUZZLE_BOBBLE = join(FIXTURES, "puzzle-bobble.iso");

describe.skipIf(!existsSync(PUZZLE_BOBBLE))("game boot — puzzle-bobble", () => {
  it("boots, renders content, and reaches the intro without faults", async () => {
    // Frame 150+: the savedata "load failed" dialog is up — press cross to
    // dismiss, then the game proceeds to the TAITO logo / intro.
    const report = await bootGame(PUZZLE_BOBBLE, {
      frames: 400,
      input: [{ start: 150, end: 170, buttons: PspButton.Cross }],
    });

    expect(report.faulted).toBe(false);
    expect(report.halted).toBe(false);
    expect(report.frames).toBe(400);
    expect(report.vblanks).toBeGreaterThanOrEqual(400);

    // GE must process real content, not just clear rects
    expect(report.ge.lists).toBeGreaterThan(100);
    expect(report.ge.prims).toBeGreaterThan(report.ge.clears);

    // Software rasterizer must have produced visible pixels in the display fb
    expect(report.fbNonBlackPixels).toBeGreaterThan(10_000);

    // The game must not burn the whole cycle budget every frame (busy-loop guard).
    // Intro frames are mostly idle; allow some heavy frames but not all.
    const heavy = report.stepsPerFrame.filter((s) => s > 3_500_000).length;
    expect(heavy).toBeLessThan(report.stepsPerFrame.length / 2);

    // The BGM/wave system must not be respawning dead worker threads
    const dormant = report.threads.filter((t) => t.state === 4).length;
    expect(dormant).toBeLessThan(10);

    expect(report.errors).toEqual([]);
  }, 120_000);
});
