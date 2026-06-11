/**
 * One-shot headless game diagnostic — boots an ISO and logs everything needed
 * to find why a game is stuck, without rewriting ad-hoc scripts each time.
 *
 * Usage:
 *   npx tsx tools/game-diag.ts <iso-path> [frames=300] [options]
 *
 * Options:
 *   --press <frame>:<button>[:<holdFrames>]   inject input (cross, circle,
 *       square, triangle, start, select, up, down, left, right, l, r).
 *       Repeatable. Default hold = 20 frames.
 *   --sample-pc       sample hot PCs (slower, finds busy loops)
 *
 * Example (dismiss a dialog at frame 200, press start at 400):
 *   npx tsx tools/game-diag.ts test/fixtures/puzzle-bobble.iso 600 \
 *     --press 200:cross --press 400:start --sample-pc
 */

import { existsSync } from "node:fs";
import { bootGame, PspButton, type InputAction } from "../test/helpers/boot-game.js";

const BUTTON_NAMES: Record<string, number> = {
  cross: PspButton.Cross, circle: PspButton.Circle,
  square: PspButton.Square, triangle: PspButton.Triangle,
  start: PspButton.Start, select: PspButton.Select,
  up: PspButton.Up, down: PspButton.Down, left: PspButton.Left, right: PspButton.Right,
  l: PspButton.LTrigger, r: PspButton.RTrigger,
};

const args = process.argv.slice(2);
const isoPath = args[0];
const positional = args.filter((a) => !a.startsWith("--"));
const frames = parseInt(positional[1] ?? "300", 10);

if (!isoPath || !existsSync(isoPath)) {
  console.error("Usage: npx tsx tools/game-diag.ts <iso-path> [frames] [--press f:button[:hold]] [--sample-pc]");
  process.exit(1);
}

const input: InputAction[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--press" && args[i + 1]) {
    const [f, name, hold] = args[i + 1]!.split(":");
    const btn = BUTTON_NAMES[name?.toLowerCase() ?? ""];
    if (btn === undefined) { console.error(`Unknown button: ${name}`); process.exit(1); }
    const start = parseInt(f!, 10);
    input.push({ start, end: start + (hold ? parseInt(hold, 10) : 20), buttons: btn });
  }
}

const THREAD_STATE = ["RUNNING", "READY", "WAITING", "SUSPEND", "DORMANT", "DEAD"];
const WAIT_TYPE = ["NONE", "DELAY", "VBLANK", "SLEEP", "SEMA", "EVENT_FLAG", "AUDIO",
  "ATRAC_DECODE", "GE_DRAW_SYNC", "GE_LIST_SYNC", "THREAD_END", "MUTEX", "FPL", "VPL",
  "MODULE", "LWMUTEX", "CTRL"];

const report = await bootGame(isoPath, {
  frames,
  input,
  pcSampleEvery: args.includes("--sample-pc") ? 64 : 0,
});

console.log(`\n=== ${isoPath} — ${report.frames}/${frames} frames ===`);
console.log(`time: ${report.elapsedMs}ms (${report.fps.toFixed(1)} fps), vblanks: ${report.vblanks}`);
console.log(`halted: ${report.halted}, faulted: ${report.faulted}, pc: 0x${report.emu.cpu.regs.pc.toString(16)}`);

console.log(`\nGE: lists=${report.ge.lists} prims=${report.ge.prims} clears=${report.ge.clears} enqueues=${report.ge.enqueues}`);
console.log(`Display FB non-black pixels: ${report.fbNonBlackPixels} ${report.fbNonBlackPixels === 0 ? "← BLACK SCREEN" : ""}`);
if (report.ge.prims > 0 && report.ge.prims === report.ge.clears) {
  console.log("⚠ prims == clears: the game draws ONLY clear rects (stuck before rendering content)");
}

console.log(`\nSteps/frame (every 10th): ${report.stepsPerFrame.slice(-8).join(", ")}`);
const budget = 3_700_000;
const lastSteps = report.stepsPerFrame[report.stepsPerFrame.length - 1] ?? 0;
if (lastSteps > budget * 0.95) {
  console.log("⚠ full cycle budget burned every frame — a thread is busy-looping (use --sample-pc)");
}

console.log("\nSteps per thread:");
for (const [tid, steps] of [...report.stepsPerThread.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  t${tid}: ${steps.toLocaleString()}`);
}

console.log("\nThreads (non-dormant):");
for (const t of report.threads.filter((t) => t.state !== 4).slice(0, 12)) {
  console.log(`  t${t.id} prio=${t.priority} ${THREAD_STATE[t.state] ?? t.state}/${WAIT_TYPE[t.waitType] ?? t.waitType}`);
}
const dormant = report.threads.filter((t) => t.state === 4).length;
if (dormant > 10) console.log(`  ⚠ ${dormant} DORMANT threads — game may be respawning a failing worker thread`);

console.log("\nTop syscalls (thread:name → count):");
for (const [key, n] of [...report.syscalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`  ${key}: ${n}`);
}

if (report.hotPcs.size > 0) {
  console.log("\nHot PCs (sampled):");
  for (const [pc, n] of [...report.hotPcs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  0x${pc.toString(16)}: ${n}`);
  }
}

if (report.stubCalls.length > 0) {
  console.log(`\nStub calls (${report.stubCalls.length} unique):`);
  for (const [name, n] of report.stubCalls.slice(0, 12)) console.log(`  ${name}: ${n}`);
}

if (report.warnings.length > 0) {
  console.log(`\nWarnings (${report.warnings.length}):`);
  for (const w of report.warnings.slice(0, 15)) console.log(`  ${w}`);
}
if (report.errors.length > 0) {
  console.log(`\nERRORS (${report.errors.length}):`);
  for (const e of report.errors.slice(0, 15)) console.log(`  ${e}`);
}
console.log("");
