/**
 * pspautotests runner — boots a .prx test file in our emulator,
 * captures stdout output, and compares against .expected file.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { PSPEmulator } from "../../src/emulator.js";

export interface AutotestResult {
  passed: boolean;
  actual: string;
  expected: string;
  /** First mismatched line info (for diagnostics) */
  diff?: string;
  /** Number of CPU frames executed */
  frames: number;
}

/**
 * Run a single pspautotests .prx and compare output.
 *
 * @param prxPath - Path to the compiled .prx test file
 * @param expectedPath - Path to the .expected output file
 * @param maxFrames - Max frames to run (default 600 = 10 seconds at 60fps).
 *   Most pspautotests exit via sceKernelExitGame well before this limit.
 */
export async function runAutotest(
  prxPath: string,
  expectedPath: string,
  maxFrames = 600,
): Promise<AutotestResult> {
  if (!existsSync(prxPath)) {
    return { passed: false, actual: "", expected: "", diff: `PRX not found: ${prxPath}`, frames: 0 };
  }
  if (!existsSync(expectedPath)) {
    return { passed: false, actual: "", expected: "", diff: `Expected file not found: ${expectedPath}`, frames: 0 };
  }

  const prxData = new Uint8Array(readFileSync(prxPath));
  const expectedText = readFileSync(expectedPath, "utf-8");

  const emu = new PSPEmulator();
  emu.hle.stdoutBuffer = [];

  // PPSSPP headless boots a bare PRX as "umd0:/<file>" and passes that path
  // as the root thread args (PSPLoaders.cpp Load_PSP_ELF_PBP)
  await emu.loadElfBinary(prxData, `umd0:/${basename(prxPath)}`);

  // pspautotests run as homebrew on ms0:, set initial CWD accordingly
  emu.hle.pspFs.setStartingDirectory("ms0:/PSP/GAME/__autotest");
  // Register standard memory stick directories so sceIoDopen succeeds
  emu.hle.pspFs.registerDirectory("ms0:/PSP/SAVEDATA");
  emu.hle.pspFs.registerDirectory("ms0:/PSP/COMMON");

  let frames = 0;
  for (frames = 0; frames < maxFrames; frames++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
  }

  const actual = emu.hle.stdoutBuffer.join("");

  // Normalize: split on newlines, trim trailing empty lines
  const actualLines = trimTrailingEmpty(actual.split("\n"));
  const expectedLines = trimTrailingEmpty(expectedText.split("\n"));

  // Compare line-by-line (same as PPSSPP Compare.cpp)
  const diff = compareLines(actualLines, expectedLines);

  return {
    passed: diff === null,
    actual,
    expected: expectedText,
    diff: diff ?? undefined,
    frames,
  };
}

/** Remove trailing empty strings from an array of lines. */
function trimTrailingEmpty(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Compare two sets of output lines.
 * Returns null if they match, or a description of the first mismatch.
 */
function compareLines(actual: string[], expected: string[]): string | null {
  const maxLen = Math.max(actual.length, expected.length);
  for (let i = 0; i < maxLen; i++) {
    const a = actual[i];
    const e = expected[i];
    if (a === undefined && e !== undefined) {
      return `Line ${i + 1}: missing output\n  expected: "${e}"`;
    }
    if (a !== undefined && e === undefined) {
      return `Line ${i + 1}: extra output\n  actual: "${a}"`;
    }
    if (a !== e) {
      return `Line ${i + 1}: mismatch\n  expected: "${e}"\n  actual:   "${a}"`;
    }
  }
  return null;
}
