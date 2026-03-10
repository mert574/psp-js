import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
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

  const bus = new MemoryBus();
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
  const SYSCALL_RET = 0xFFFFF;
  bus.writeU32(TRAMPOLINE, 0x0000000c | (SYSCALL_RET << 6));
  bus.writeU32(TRAMPOLINE + 4, 0);

  let moduleReturned = false;
  hle.register(SYSCALL_RET, (regs) => {
    moduleReturned = true;
    if (hle.pendingThreadEntry != null) {
      const { entry, arglen, argp, sp, k0 } = hle.pendingThreadEntry;
      regs.pc = entry;
      regs.setGpr(4, arglen);
      regs.setGpr(5, argp);
      regs.setGpr(26, k0);
      regs.setGpr(29, sp);
      hle.pendingThreadEntry = null;
      regs.setGpr(31, TRAMPOLINE);
    } else {
      cpu.stepFaulted = true;
    }
  });

  cpu.regs.setGpr(31, TRAMPOLINE);

  const syscallLog: { code: number; nid: number | undefined }[] = [];
  const origDispatch = hle.dispatch.bind(hle);
  hle.dispatch = (code, regs) => {
    const nid = (hle as any).syscallToNid?.get(code) as number | undefined;
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
    expect(result.moduleReturned).toBe(true);
    expect(result.steps).toBeGreaterThan(100);
  });
});

describe("EBOOT boot — space-invaders.iso", () => {
  const ISO_PATH = "test/fixtures/space-invaders.iso";

  it.skipIf(!existsSync(ISO_PATH))(
    "should boot without crashing for 2M steps",
    { timeout: 60_000 },
    async () => {
      const result = await bootIso(ISO_PATH, 2_000_000);
      expect(result.moduleReturned).toBe(true);
      expect(result.steps).toBeGreaterThan(1000);
      console.log(`Syscalls fired: ${result.syscallLog.length}`);

      // Log unimplemented NIDs for debugging
      const unimpl = result.syscallLog.filter(s => s.nid !== undefined);
      const nidCounts = new Map<number, number>();
      for (const s of unimpl) {
        if (s.nid !== undefined) nidCounts.set(s.nid, (nidCounts.get(s.nid) ?? 0) + 1);
      }
      console.log(`Unique NIDs called: ${nidCounts.size}`);
    }
  );
});
