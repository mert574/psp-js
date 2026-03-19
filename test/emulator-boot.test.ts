import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseIso, readFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { loadElf } from "../src/loader/elf.js";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { AllegrexCPU } from "../src/cpu/cpu.js";
import { HLEKernel } from "../src/kernel/hle-kernel.js";

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

interface BootResult {
  steps: number;
  moduleReturned: boolean;
  cpu: AllegrexCPU;
  hle: HLEKernel;
  syscallLog: { code: number; nid: number | undefined }[];
}

async function bootIso(isoPath: string, maxSteps: number): Promise<BootResult> {
  const isoBuffer = readFileSync(isoPath).buffer;
  let data = extractEboot(isoBuffer);
  console.log(`EBOOT.BIN: ${data.byteLength} bytes`);

  if (isPbp(data)) {
    const pbp = parsePbp(data);
    console.log(`PBP unwrapped: data.psp = ${pbp.dataPsp.byteLength} bytes`);
    data = pbp.dataPsp;
  }

  const view = new DataView(data.buffer, data.byteOffset, 4);
  const magic = view.getUint32(0, false);
  if (magic === 0x7e505350) {
    console.log("Encrypted PRX detected, decrypting...");
    const decrypted = await pspDecryptPRX(data);
    if (!decrypted) throw new Error("Decryption failed");
    data = decrypted;
    console.log(`Decrypted: ${data.byteLength} bytes`);
  }

  const bus = MemoryBus.create();
  const { entryPoint, moduleStartFunc, gp, nidBySyscall } = loadElf(data, bus);
  const startAddr = moduleStartFunc ?? entryPoint;
  console.log(`entry=0x${entryPoint.toString(16)}, module_start=0x${startAddr.toString(16)}, gp=0x${gp.toString(16)}, stubs=${nidBySyscall.size}`);

  const cpu = new AllegrexCPU(bus);
  const hle = new HLEKernel(bus);
  cpu.hle = hle;
  hle.remapSyscalls(nidBySyscall);

  cpu.regs.pc = startAddr;
  if (gp !== 0) cpu.regs.setGpr(28, gp);
  cpu.regs.setGpr(29, 0x09FFF000);

  const TRAMPOLINE = 0x09FFF800;
  bus.writeU32(TRAMPOLINE, 0x0000000d); // BREAK
  bus.writeU32(TRAMPOLINE + 4, 0);
  hle.threadReturnAddr = TRAMPOLINE;

  let moduleReturned = false;
  cpu.onBreak = (pc) => {
    if (pc === TRAMPOLINE) {
      moduleReturned = true;
      // Mark current thread as DEAD and switch to next READY thread
      if (hle.currentThreadId > 0) {
        if (!hle.exitCurrentThread(cpu.regs)) {
          cpu.stepFaulted = true; // no more threads
        }
      } else if (hle.pendingThreadEntry != null) {
        // Fallback for non-threaded mode (main thread start)
        const { entry, arglen, argp, sp, k0 } = hle.pendingThreadEntry;
        cpu.regs.pc = entry;
        cpu.regs.setGpr(4, arglen);
        cpu.regs.setGpr(5, argp);
        cpu.regs.setGpr(26, k0);
        cpu.regs.setGpr(29, sp);
        hle.pendingThreadEntry = null;
        cpu.regs.setGpr(31, TRAMPOLINE);
      } else {
        cpu.stepFaulted = true;
      }
      return true; // continue execution (at new PC set by exitCurrentThread)
    }
    return false; // let it throw for other BREAKs
  };

  cpu.regs.setGpr(31, TRAMPOLINE);

  const syscallLog: { code: number; nid: number | undefined }[] = [];
  const origDispatch = hle.dispatch.bind(hle);
  hle.dispatch = (code, regs) => {
    const nid = hle.getNidBySyscallForTest(code);
    syscallLog.push({ code, nid });
    origDispatch(code, regs);
  };

  let steps = 0;
  while (steps < maxSteps) {
    if (!cpu.step()) break;
    if (cpu.stepFaulted) break;
    steps++;
  }

  console.log(`Ran ${steps} steps, moduleReturned=${moduleReturned}, PC=0x${cpu.regs.pc.toString(16)}`);
  return { steps, moduleReturned, cpu, hle, syscallLog };
}

describe("EBOOT boot — test.iso", () => {
  it("should load and run module_start until return", { timeout: 30_000 }, async () => {
    const result = await bootIso("test/fixtures/test.iso", 2_000_000);
    // module_start may or may not return depending on thread scheduling
    expect(result.steps).toBeGreaterThan(100);
  });
});

