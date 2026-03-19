/**
 * pspautotests — GPU / GE tests
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
      console.log(`  FAILED after ${result.frames} frames`);
      console.log(`  ${result.diff}`);
      const actualLines = result.actual.split("\n").slice(0, 20);
      console.log("  Actual output (first 20 lines):");
      for (const line of actualLines) {
        console.log(`    ${line}`);
      }
    }
    expect(result.passed, result.diff).toBe(true);
  });
}

describe("pspautotests — gpu/ge", () => {
  autotest("gpu/ge/break");
  autotest("gpu/ge/context");
  autotest("gpu/ge/edram");
  autotest("gpu/ge/enqueueparam");
  autotest("gpu/ge/get");
  autotest("gpu/ge/queue");
});

describe("pspautotests — gpu/callbacks", () => {
  autotest("gpu/callbacks/ge_callbacks");
});

describe("pspautotests — gpu/displaylist", () => {
  autotest("gpu/displaylist/displaylist");
});

describe("pspautotests — gpu/signals", () => {
  autotest("gpu/signals/simple");
  autotest("gpu/signals/continue");
  autotest("gpu/signals/suspend");
});
