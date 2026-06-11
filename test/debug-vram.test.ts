import { describe, it } from "vitest";
import { readFileSync } from "fs";
import { parseIso, readFile } from "../src/iso/iso9660.js";
import { PSPEmulator } from "../src/emulator.js";
import { ThreadState } from "../src/kernel/hle-kernel.js";

function extractEboot(isoBuffer: ArrayBuffer): Uint8Array {
  const volume = parseIso(isoBuffer);
  const pspGame = volume.root.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME"
  )!;
  const sysdir = pspGame.children!.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "SYSDIR"
  )!;
  const eboot = sysdir.children!.find(
    (f) => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN"
  )!;
  return readFile(isoBuffer, eboot).slice();
}

describe("VRAM debug", () => {
  it("diagnoses why VRAM is empty", async () => {
    const isoBuffer = readFileSync("test/fixtures/test.iso").buffer;
    const eboot = extractEboot(isoBuffer);

    const emu = new PSPEmulator();
    await emu.loadElfBinary(eboot);

    // Count GE enqueue via syscall spy
    let geEnQueueCount = 0;

    // Count syscall frequencies
    const syscallCounts = new Map<number, number>();
    const origDispatch = emu.hle.dispatch.bind(emu.hle);
    emu.hle.dispatch = (code: number, regs: any) => {
      syscallCounts.set(code, (syscallCounts.get(code) ?? 0) + 1);
      if (emu.hle.getNidBySyscallForTest(code) === 0xab49e76a) geEnQueueCount++;
      origDispatch(code, regs);
    };

    const deadline = Date.now() + 5000;
    let frames = 0;
    while (Date.now() < deadline && !emu.halted) {
      emu.runFrame(200_000);
      frames++;
    }

    const vram32 = new Uint32Array(emu.bus.vramBuffer.buffer, emu.bus.vramBuffer.byteOffset, emu.bus.vramBuffer.byteLength >>> 2);
    let nonZeroCount = 0;
    for (let i = 0; i < vram32.length; i++) {
      if (vram32[i] !== 0) nonZeroCount++;
    }
    const first16 = Array.from(emu.bus.vramBuffer.slice(0, 16)).map(b => b.toString(16).padStart(2, "0")).join(" ");

    console.log("=== VRAM DIAGNOSTIC ===");
    console.log(`sceGeListEnQueue calls (executeList): ${geEnQueueCount}`);
    console.log(`Total frames ran: ${frames}`);
    console.log(`hle.framebufAddr: 0x${((emu.hle as any).framebufAddr ?? 0).toString(16)}`);
    console.log(`Non-zero Uint32 values in vramBuffer: ${nonZeroCount}`);
    console.log(`First 16 bytes of vramBuffer: ${first16}`);
    console.log(`Halted: ${emu.halted}`);
    console.log(`Current PC: 0x${emu.cpu.regs.pc.toString(16)}`);
    console.log(`currentThreadId: ${(emu.hle as any).currentThreadId}`);

    // Print thread states
    const threads = (emu.hle as any).threads as Map<number, any>;
    for (const [tid, t] of threads) {
      console.log(`Thread ${tid}: state=${ThreadState[t.state]} waitType=${t.waitType} pc=0x${t.context.gpr[31]?.toString(16)}`);
    }

    // Print top syscalls
    const sorted = [...syscallCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log("Top syscalls (code: count):");
    for (const [code, cnt] of sorted) {
      const nid = (emu.hle as any).syscallToNid?.get(code) ?? emu.hle.getNidBySyscallForTest?.(code);
      console.log(`  0x${code.toString(16)} (NID 0x${(nid ?? 0).toString(16)}): ${cnt}`);
    }
  }, 15000);
});
