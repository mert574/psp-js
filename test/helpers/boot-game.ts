/**
 * Headless game-boot harness shared by integration tests and tools/game-diag.ts.
 *
 * Boots an ISO in node (no browser, no WebGL — the GE processor software-
 * rasterizes into VRAM) and runs frames with optional scripted input,
 * collecting everything needed to diagnose a stuck game in one pass:
 * per-thread CPU attribution, syscall histogram, GE stats, VRAM pixel
 * counts, warnings/errors, and hot-PC samples.
 */

import { readFileSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../../src/loader/pbp.js";
import { pspDecryptPRX } from "../../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../../src/emulator.js";
import { NID_NAMES } from "../../src/kernel/nids.js";
import { Logger } from "../../src/utils/logger.js";

/** PSP pad button bits (mirrors src/frontend/input.ts PspButton, which is a
 *  const enum and can't be re-exported as a runtime value). */
export const PspButton = {
  Select: 0x0001, Start: 0x0008,
  Up: 0x0010, Right: 0x0020, Down: 0x0040, Left: 0x0080,
  LTrigger: 0x0100, RTrigger: 0x0200,
  Triangle: 0x1000, Circle: 0x2000, Cross: 0x4000, Square: 0x8000,
} as const;

/** One scripted input action: hold `buttons` from frame `start` to frame `end` (exclusive). */
export interface InputAction {
  start: number;
  end: number;
  buttons: number;
}

export interface BootOptions {
  frames?: number;
  /** Scripted button presses (frame-based). */
  input?: InputAction[];
  /** Sample the PC every N steps for the hot-PC histogram (0 = off, slows emulation). */
  pcSampleEvery?: number;
}

export interface BootReport {
  emu: PSPEmulator;
  frames: number;
  elapsedMs: number;
  fps: number;
  halted: boolean;
  faulted: boolean;
  vblanks: number;
  /** Steps executed per frame (sampled every 10th frame). */
  stepsPerFrame: number[];
  /** Total steps attributed to the thread that was current when each CPU slice started. */
  stepsPerThread: Map<number, number>;
  /** "t<tid>:<syscall name or nid>" → call count. */
  syscalls: Map<string, number>;
  ge: { lists: number; prims: number; clears: number; enqueues: number };
  threads: Array<{ id: number; state: number; waitType: number; priority: number }>;
  /** Non-black pixels in the display framebuffer region of VRAM (graphics smoke check). */
  fbNonBlackPixels: number;
  warnings: string[];
  errors: string[];
  stubCalls: Array<[string, number]>;
  /** pc → samples (only when pcSampleEvery > 0). */
  hotPcs: Map<number, number>;
}

export function extractEboot(isoBuffer: ArrayBuffer): Uint8Array {
  const volume = parseIso(isoBuffer);
  const pspGame = volume.root.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME",
  )!;
  const sysdir = pspGame.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "SYSDIR",
  )!;
  const eboot = sysdir.children!.find(
    (f) => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN",
  )!;
  return readFile(isoBuffer, eboot).slice();
}

export function mountIso(isoBuffer: ArrayBuffer, fileData: Map<string, Uint8Array>): void {
  const volume = parseIso(isoBuffer);
  function walk(node: IsoFile, path: string): void {
    if (node.isDirectory) {
      for (const child of node.children ?? []) {
        walk(child, path + "/" + child.name.replace(/;1$/, "").toLowerCase());
      }
    } else {
      fileData.set("disc0:" + path, readFile(isoBuffer, node));
    }
  }
  walk(volume.root, "");
}

/** Load an ISO into a fresh emulator, ready to run frames. */
export async function loadGame(isoPath: string): Promise<PSPEmulator> {
  const isoBuffer = readFileSync(isoPath).buffer as ArrayBuffer;
  let data = extractEboot(isoBuffer);
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array<ArrayBuffer>;
  const view = new DataView(data.buffer, data.byteOffset, 4);
  if (view.getUint32(0, false) === 0x7e505350) {
    const dec = await pspDecryptPRX(data);
    if (!dec) throw new Error("EBOOT.BIN decryption failed");
    data = dec as Uint8Array<ArrayBuffer>;
  }
  const emu = new PSPEmulator();
  mountIso(isoBuffer, emu.hle.fileData);
  await emu.loadElfBinary(data);
  return emu;
}

/** Boot an ISO and run frames, collecting the full diagnostic report. */
export async function bootGame(isoPath: string, opts: BootOptions = {}): Promise<BootReport> {
  const maxFrames = opts.frames ?? 300;
  const input = opts.input ?? [];

  const warnings: string[] = [];
  const errors: string[] = [];
  Logger.setErrorHook((ns, msg) => { if (errors.length < 100) errors.push(`[${ns}] ${msg}`); });
  Logger.setWarnHook((_level, ns, msg) => { if (warnings.length < 100) warnings.push(`[${ns}] ${msg}`); });

  const emu = await loadGame(isoPath);

  // Scripted input
  let currentFrame = 0;
  emu.hle.inputSnapshot = () => {
    let buttons = 0;
    for (const a of input) {
      if (currentFrame >= a.start && currentFrame < a.end) buttons |= a.buttons;
    }
    return { buttons, analog: { x: 0, y: 0 } };
  };

  // Syscall histogram (per thread, with names)
  const syscalls = new Map<string, number>();
  let geEnqueues = 0;
  const origDispatch = emu.hle.dispatch.bind(emu.hle);
  emu.hle.dispatch = (code: number, regs) => {
    const nid = emu.hle.getNidBySyscallForTest(code);
    if (nid != null) {
      if (nid === 0xab49e76a) geEnqueues++;
      const name = NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`;
      const key = `t${emu.hle.currentThreadId}:${name}`;
      syscalls.set(key, (syscalls.get(key) ?? 0) + 1);
    }
    origDispatch(code, regs);
  };

  // Per-thread step attribution
  const stepsPerThread = new Map<number, number>();
  const cpu = emu.cpu as unknown as { run(max?: number): number; step(): boolean };
  const origRun = cpu.run.bind(cpu);
  let stepsThisFrame = 0;
  cpu.run = (max?: number) => {
    const tid = emu.hle.currentThreadId;
    const ran = origRun(max);
    stepsThisFrame += ran;
    stepsPerThread.set(tid, (stepsPerThread.get(tid) ?? 0) + ran);
    return ran;
  };

  // Hot-PC sampling
  const hotPcs = new Map<number, number>();
  if (opts.pcSampleEvery && opts.pcSampleEvery > 0) {
    const every = opts.pcSampleEvery;
    const origStep = cpu.step.bind(cpu);
    let n = 0;
    cpu.step = () => {
      if (n++ % every === 0) {
        const pc = emu.cpu.regs.pc;
        hotPcs.set(pc, (hotPcs.get(pc) ?? 0) + 1);
      }
      return origStep();
    };
  }

  const stepsPerFrame: number[] = [];
  const start = Date.now();
  let frames = 0;
  for (frames = 0; frames < maxFrames; frames++) {
    currentFrame = frames;
    stepsThisFrame = 0;
    emu.runFrame();
    if (frames % 10 === 0) stepsPerFrame.push(stepsThisFrame);
    if (emu.halted || emu.cpu.stepFaulted) break;
  }
  const elapsedMs = Date.now() - start;

  // Display framebuffer pixel check (software raster writes VRAM in headless mode)
  const fbAddr = emu.hle.framebufAddr !== 0 ? emu.hle.framebufAddr : emu.hle.geFbAddr;
  let fbNonBlackPixels = 0;
  if (fbAddr >= 0x04000000) {
    const vram = emu.bus.vramBuffer;
    const offset = fbAddr - 0x04000000;
    const stride = emu.hle.framebufWidth || 512;
    // Assume 32bpp for the smoke check; 16bpp formats still produce nonzero bytes.
    const end = Math.min(offset + stride * 272 * 4, vram.length);
    for (let i = offset; i + 3 < end; i += 4) {
      if (vram[i] | vram[i + 1]! | vram[i + 2]!) fbNonBlackPixels++;
    }
  }

  const threads = [...emu.hle.threads.values()].map((t) => ({
    id: t.id, state: t.state, waitType: t.waitType, priority: t.priority,
  }));

  return {
    emu,
    frames,
    elapsedMs,
    fps: frames / (elapsedMs / 1000),
    halted: emu.halted,
    faulted: emu.cpu.stepFaulted,
    vblanks: emu.hle.vblankCount,
    stepsPerFrame,
    stepsPerThread,
    syscalls,
    ge: {
      lists: emu.hle.geListCount,
      prims: emu.hle.gePrimCount,
      clears: emu.hle.geClearCount,
      enqueues: geEnqueues,
    },
    threads,
    fbNonBlackPixels,
    warnings,
    errors,
    stubCalls: [...emu.hle.stubCalls.entries()].sort((a, b) => b[1] - a[1]),
    hotPcs,
  };
}
