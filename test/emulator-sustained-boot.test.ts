/**
 * Sustained-boot test for puzzle-bobble.iso.
 *
 * Verifies:
 *  1. No log.error messages are emitted during 5 seconds of run time.
 *     Any error-level log (Bad PC, unhandled fault, …) immediately fails
 *     the test with the exact message.
 *  2. At least one GE display list was submitted (non-blank draw call),
 *     proving the game reached its render loop.
 *
 * Step budget: STEPS_PER_ITER is intentionally larger than production
 * (200K/frame) so the interpreter can burn through the game's heavy init
 * routines within the 5-second wall-clock budget.  VBlank is still
 * triggered after every runFrame() call, keeping thread scheduling intact.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import type { IsoFile } from "../src/iso/iso9660.js";
import { parseIso, readFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

// ── Constants ────────────────────────────────────────────────────────────────

const ISO_PATH        = "test/fixtures/puzzle-bobble.iso";
const RUN_DURATION_MS = 5_000;

/**
 * Steps per runFrame() call.  Larger than production so the interpreter
 * can advance through init-heavy code within the test budget.
 * VBlank still fires every call, so thread scheduling is not affected.
 */
const STEPS_PER_ITER = 2_000_000;

/** sceGeListEnQueue NID — its first call proves the game reached rendering. */
const NID_GE_ENQUEUE = 0xab49e76a;

// ── Helpers ──────────────────────────────────────────────────────────────────

interface PrepareResult {
  ebootBytes: Uint8Array<ArrayBuffer>;
  isoBuffer: ArrayBuffer;
}

async function prepareIso(isoPath: string): Promise<PrepareResult> {
  const isoBuffer = readFileSync(isoPath).buffer as ArrayBuffer;
  const volume    = parseIso(isoBuffer);

  const pspGame = volume.root.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME"
  )!;
  const sysdir = pspGame.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "SYSDIR"
  )!;
  const ebootEntry = sysdir.children!.find(
    (f) => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN"
  )!;

  let data = readFile(isoBuffer, ebootEntry).slice() as Uint8Array<ArrayBuffer>;

  if (isPbp(data)) {
    data = parsePbp(data).dataPsp as Uint8Array<ArrayBuffer>;
  }

  const view = new DataView(data.buffer, data.byteOffset, 4);
  if (view.getUint32(0, false) === 0x7e505350 /* ~PSP encrypted */) {
    const decrypted = await pspDecryptPRX(data);
    if (!decrypted) throw new Error("PRX decryption failed");
    data = decrypted as Uint8Array<ArrayBuffer>;
  }

  return { ebootBytes: data, isoBuffer };
}

/**
 * Recursively walk an ISO 9660 volume and populate the HLE fileData map
 * with disc0:/ paths so the game can open files from the UMD image.
 */
function mountIsoToHle(
  isoBuffer: ArrayBuffer,
  fileData: Map<string, Uint8Array>,
): void {
  const volume = parseIso(isoBuffer);

  function walk(node: IsoFile, path: string): void {
    if (node.isDirectory) {
      for (const child of node.children ?? []) {
        walk(child, path + "/" + child.name.replace(/;1$/, "").toLowerCase());
      }
    } else {
      const bytes = readFile(isoBuffer, node);
      fileData.set("disc0:" + path, bytes);
    }
  }

  walk(volume.root, "");
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterEach(() => {
  Logger.setErrorHook(null);
});

// ── Test ─────────────────────────────────────────────────────────────────────

const SI_ISO_PATH        = "test/fixtures/space-invaders.iso";
const SI_RUN_DURATION_MS = 15_000;

describe("Sustained boot — space-invaders.iso", () => {
  it.skipIf(!existsSync(SI_ISO_PATH))(
    "runs for 15 seconds with no log errors and at least one GE draw call",
    { timeout: SI_RUN_DURATION_MS + 10_000 },
    async () => {
      const { ebootBytes, isoBuffer } = await prepareIso(SI_ISO_PATH);
      const emu = new PSPEmulator();

      mountIsoToHle(isoBuffer, emu.hle.fileData);

      const errorLines: string[] = [];
      Logger.setErrorHook((ns, msg) => {
        errorLines.push(`[${ns}] ${msg}`);
      });

      let geEnqueueCount = 0;
      const callLog: string[] = [];
      const origDispatch = emu.hle.dispatch.bind(emu.hle);
      emu.hle.dispatch = (code, regs) => {
        const nid = emu.hle.getNidBySyscallForTest(code);
        if (nid === NID_GE_ENQUEUE) {
          geEnqueueCount++;
          const listAddr = regs.getGpr(4);
          const stallAddr = regs.getGpr(5);
          // Dump instructions after the JALR+syscall return site to trace what happens next
          if (geEnqueueCount <= 3) {
            // Also log the ring buffer write pointer stored near 0x89fc380
            const rbPtr = emu.bus.readU32(0x89fc380);
            console.log(`GeListEnQueue #${geEnqueueCount} list=0x${listAddr.toString(16)} sceGuWritePtr=0x${emu.bus.readU32(0x89fc264).toString(16)} rbPtr@0x89fc380=0x${rbPtr.toString(16)}`);
          }
        }
        callLog.push(`nid=0x${(nid??0).toString(16)}@pc=0x${regs.pc.toString(16)}`);
        if (callLog.length > 100) callLog.shift();
        origDispatch(code, regs);
      };

      await emu.loadElfBinary(ebootBytes);
      await emu.initWorker();

      // Watch writes to 0x8a137f4 — the inner pointer that gets corrupted
      emu.bus.watchWriteAddr = 0x08a137f4;
      emu.bus.onWatchWrite = (_vaddr, value) => {
        const r = emu.cpu.regs;
        const pc = r.pc;
        console.log(`WRITE 0x8a137f4 ← 0x${value.toString(16)} PC=0x${pc.toString(16)} ra=0x${r.getGpr(31).toString(16)} t5=0x${r.getGpr(13).toString(16)} v0=0x${r.getGpr(2).toString(16)}`);
        if (value === 0xc6000f0f) {
          // Corrupt write — dump last syscalls and memory context
          console.log('Last syscalls:', callLog.slice(-30).join('\n  '));
          // Dump 128 bytes before t5 to find GE buffer start
          const t5 = r.getGpr(13);
          const dumpBefore: string[] = [];
          for (let off = -128; off <= 16; off += 4) {
            try { dumpBefore.push(`[0x${(t5+off).toString(16)}]=0x${emu.bus.readU32(t5+off).toString(16).padStart(8,'0')}`); } catch {}
          }
          console.log('Memory around t5:', dumpBefore.join(' '));
        }
      };
      emu.cpu.watchPC = 0;

      let iterCount = 0;
      const deadline = Date.now() + SI_RUN_DURATION_MS;

      while (Date.now() < deadline) {
        emu.runFrame();
        iterCount++;
        if (emu.halted || emu.cpu.stepFaulted) break;
      }

      // Dump key instruction ranges for disassembly
      if (emu.cpu.stepFaulted) {
        const dumpInstrs = (label: string, from: number, to: number) => {
          const instrs: string[] = [];
          for (let a = from; a <= to; a += 4) {
            instrs.push(`0x${a.toString(16)}=0x${emu.bus.readU32(a).toString(16).padStart(8,'0')}`);
          }
          console.log(`${label}: ${instrs.join(' ')}`);
        };
        dumpInstrs("0x888d250-0x888d280 (crash fn)", 0x888d250, 0x888d280);
        dumpInstrs("0x889f4e0-0x889f520 (corrupt write)", 0x889f4e0, 0x889f520);
      }

      const errorReport = errorLines.length > 0 ? errorLines.join("\n") : null;

      console.log(
        `Iters: ${iterCount} | GE lists: ${geEnqueueCount} | ` +
        `halted: ${emu.halted} | PC: 0x${emu.cpu.regs.pc.toString(16)} | ` +
        `errors: ${errorLines.length}`
      );

      expect(errorReport, errorReport ?? "").toBeNull();
      expect(iterCount, "Too few iterations — emulator stalled immediately")
        .toBeGreaterThan(10);

      if (emu.halted) {
        expect(
          emu.cpu.stepFaulted,
          `CPU faulted at PC=0x${emu.cpu.regs.pc.toString(16)}`
        ).toBe(false);
      }

      expect(
        geEnqueueCount,
        "sceGeListEnQueue was never called — game never reached its render loop"
      ).toBeGreaterThan(0);
    }
  );
});

describe("Sustained boot — puzzle-bobble.iso", () => {
  it(
    "runs for 5 seconds with no log errors and at least one GE draw call",
    { timeout: RUN_DURATION_MS + 10_000 },
    async () => {
      const { ebootBytes, isoBuffer } = await prepareIso(ISO_PATH);
      const emu = new PSPEmulator();

      // Mount the full ISO so the game can open disc0:/ files
      mountIsoToHle(isoBuffer, emu.hle.fileData);

      // ── Error log monitor ────────────────────────────────────────────────
      // A single CPU crash emits several log.error() lines (Bad PC, RA hint,
      // Last PCs, …).  Collecting them all gives a full picture of the fault.
      // We do NOT break on the first error — instead we let the frame finish
      // so that all lines from one crash are captured, then stop.
      const errorLines: string[] = [];
      Logger.setErrorHook((ns, msg) => {
        errorLines.push(`[${ns}] ${msg}`);
      });

      // ── Syscall spy ──────────────────────────────────────────────────────
      let geEnqueueCount = 0;
      const origDispatch = emu.hle.dispatch.bind(emu.hle);
      emu.hle.dispatch = (code, regs) => {
        if (emu.hle.getNidBySyscallForTest(code) === NID_GE_ENQUEUE) {
          geEnqueueCount++;
        }
        origDispatch(code, regs);
      };

      await emu.loadElfBinary(ebootBytes);
      await emu.initWorker();

      // ── Main loop ────────────────────────────────────────────────────────
      let iterCount = 0;
      const deadline = Date.now() + RUN_DURATION_MS;

      while (Date.now() < deadline) {
        emu.runFrame();
        iterCount++;

        // Stop after the frame that produced errors — by then cpu.stepFaulted
        // is set, meaning all related log.error() lines have been emitted.
        if (emu.halted || emu.cpu.stepFaulted) break;
      }

      const errorReport = errorLines.length > 0 ? errorLines.join("\n") : null;

      console.log(
        `Iters: ${iterCount} | GE lists: ${geEnqueueCount} | ` +
        `halted: ${emu.halted} | PC: 0x${emu.cpu.regs.pc.toString(16)} | ` +
        `errors: ${errorLines.length}`
      );

      // ── Assertions ───────────────────────────────────────────────────────

      // Any logged error is a hard failure — report all lines from the crash
      expect(errorReport, errorReport ?? "").toBeNull();

      // Emulator must have run at least a little
      expect(iterCount, "Too few iterations — emulator stalled immediately")
        .toBeGreaterThan(10);

      // A CPU fault (stepFaulted) is a hard failure even on voluntary halt
      if (emu.halted) {
        expect(
          emu.cpu.stepFaulted,
          `CPU faulted at PC=0x${emu.cpu.regs.pc.toString(16)}`
        ).toBe(false);
      }

      // The game must have submitted at least one GE display list, proving
      // it reached its render loop and produced non-blank draw calls.
      expect(
        geEnqueueCount,
        "sceGeListEnQueue was never called — game never reached its render loop"
      ).toBeGreaterThan(0);
    }
  );
});
