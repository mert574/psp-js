/**
 * pspautotests integration — runs compiled PSP test programs and compares
 * their stdout output against expected baselines.
 *
 * Requires: git submodule init && git submodule update in ppsspp-reference/
 * Tests auto-skip if the submodule is not initialized.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { runAutotest } from "./run-autotest.js";

const TESTS_ROOT = "ppsspp-reference/pspautotests/tests";
const SUBMODULE_MARKER = `${TESTS_ROOT}/cpu/cpu_alu/cpu_alu.prx`;

function autotest(name: string, timeout = 30_000) {
  const prxPath = `${TESTS_ROOT}/${name}.prx`;
  const expectedPath = `${TESTS_ROOT}/${name}.expected`;

  it(name, { timeout }, async () => {
    if (!existsSync(SUBMODULE_MARKER)) {
      console.log("  [SKIP] pspautotests submodule not initialized");
      return;
    }
    if (!existsSync(prxPath)) {
      console.log(`  [SKIP] ${prxPath} not found`);
      return;
    }
    const result = await runAutotest(prxPath, expectedPath);
    if (!result.passed) {
      // Print first diff for diagnostics
      console.log(`  FAILED after ${result.frames} frames`);
      console.log(`  ${result.diff}`);
      // Print first 20 lines of actual output for context
      const actualLines = result.actual.split("\n").slice(0, 20);
      console.log("  Actual output (first 20 lines):");
      for (const line of actualLines) {
        console.log(`    ${line}`);
      }
    }
    expect(result.passed, result.diff).toBe(true);
  });
}

// ── CPU Tests ───────────────────────────────────────────────────────────────
// These test raw MIPS instruction correctness — most likely to pass.

describe("pspautotests — cpu", () => {
  autotest("cpu/cpu_alu/cpu_alu");
  autotest("cpu/cpu_alu/cpu_branch");
  autotest("cpu/cpu_alu/cpu_branch2");
  autotest("cpu/fpu/fpu");
  autotest("cpu/lsu/lsu");
  autotest("cpu/icache/icache");
});

// ── VFPU Tests ──────────────────────────────────────────────────────────────

describe("pspautotests — vfpu", () => {
  autotest("cpu/vfpu/colors");
  autotest("cpu/vfpu/convert");
  // autotest("cpu/vfpu/gum"); // SKIP: needs GE init, runs 600 frames
  autotest("cpu/vfpu/matrix");
  autotest("cpu/vfpu/vavg");
});

// ── Misc Tests ──────────────────────────────────────────────────────────────

describe("pspautotests — misc", () => {
  autotest("misc/deadbeef", 60_000);
  autotest("misc/libc");
  autotest("misc/testgp");
  autotest("string/string");
  autotest("hash/hash");
  autotest("loader/bss/bss");
  autotest("malloc/malloc", 60_000);
});

// ── Thread Tests ────────────────────────────────────────────────────────────

describe("pspautotests — threads", () => {
  autotest("threads/k0/k0");
  autotest("threads/threads/threads");
  autotest("threads/alarm/alarm");
  autotest("threads/callbacks/callbacks");
  autotest("threads/events/events");
  autotest("threads/fpl/fpl");
  autotest("threads/mbx/mbx");
  autotest("threads/mutex/mutex");
  autotest("threads/semaphores/semaphores");
  autotest("threads/vpl/vpl");
});

// ── Kernel / Sysmem Tests ───────────────────────────────────────────────────

describe("pspautotests — kernel", () => {
  autotest("sysmem/sysmem");
  autotest("sysmem/freesize");
  autotest("sysmem/memblock");
  autotest("power/power");
  autotest("rtc/rtc");
  autotest("intr/intr");
});

// ── Display / IO Tests ──────────────────────────────────────────────────────

describe("pspautotests — display/io", () => {
  autotest("display/display");
  autotest("io/cwd/cwd");
  autotest("ctrl/ctrl");
});

