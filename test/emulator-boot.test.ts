import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseIso, readFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { loadElf } from "../src/loader/elf.js";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { AllegrexCPU, SyscallException } from "../src/cpu/cpu.js";
import { HLEKernel } from "../src/kernel/hle-kernel.js";

const ISO_PATH = "test/fixtures/test.iso";

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

describe("EBOOT boot", () => {
  it("should load and run module_start until return", async () => {
    const isoBuffer = readFileSync(ISO_PATH).buffer;
    let data = extractEboot(isoBuffer);
    console.log(`EBOOT.BIN: ${data.byteLength} bytes`);

    // Unwrap PBP
    if (isPbp(data)) {
      const pbp = parsePbp(data);
      console.log(`PBP unwrapped: data.psp = ${pbp.dataPsp.byteLength} bytes`);
      data = pbp.dataPsp;
    }

    // Decrypt if needed
    const view = new DataView(data.buffer, data.byteOffset, 4);
    const magic = view.getUint32(0, false);
    if (magic === 0x7e505350) {
      console.log("Encrypted PRX detected, decrypting...");
      const decrypted = await pspDecryptPRX(data);
      expect(decrypted).not.toBeNull();
      data = decrypted!;
      console.log(`Decrypted: ${data.byteLength} bytes`);
    }

    // Load ELF
    const bus = new MemoryBus();
    const { entryPoint, moduleStartFunc, nidBySyscall } = loadElf(data, bus);
    console.log(`ELF entry: 0x${entryPoint.toString(16)}`);
    console.log(`module_start_func: ${moduleStartFunc != null ? '0x' + moduleStartFunc.toString(16) : 'null'}`);
    console.log(`Import stubs: ${nidBySyscall.size} syscall codes assigned`);

    const startAddr = moduleStartFunc ?? entryPoint;

    // Set up CPU + HLE
    const cpu = new AllegrexCPU(bus);
    const hle = new HLEKernel(bus);
    cpu.hle = hle;
    hle.remapSyscalls(nidBySyscall);

    cpu.regs.pc = startAddr;
    cpu.regs.setGpr(29, 0x09FFF000); // $sp

    // Write module-return trampoline
    const TRAMPOLINE = 0x09FFF800;
    const SYSCALL_RET = 0xFFFFF;
    bus.writeU32(TRAMPOLINE, 0x0000000c | (SYSCALL_RET << 6));
    bus.writeU32(TRAMPOLINE + 4, 0); // NOP

    let moduleReturned = false;
    hle.register(SYSCALL_RET, (regs) => {
      console.log("[TEST] module_start returned, v0 =", regs.getGpr(2));
      moduleReturned = true;
      if (hle.pendingThreadEntry != null) {
        console.log(`[TEST] Pending thread entry: 0x${hle.pendingThreadEntry.toString(16)}`);
        regs.pc = hle.pendingThreadEntry;
        hle.pendingThreadEntry = null;
        regs.setGpr(31, TRAMPOLINE);
      } else {
        cpu.stepFaulted = true;
      }
    });

    cpu.regs.setGpr(31, TRAMPOLINE); // $ra

    // Run up to 100k steps
    const MAX_STEPS = 2_000_000;
    let steps = 0;
    const syscallLog: { code: number; nid: number | undefined; pc: number; a0: number; a1: number }[] = [];

    // Intercept dispatch to log syscalls with full context
    const origDispatch = hle.dispatch.bind(hle);
    hle.dispatch = (code, regs) => {
      const nid = (hle as any).syscallToNid?.get(code) as number | undefined;
      syscallLog.push({ code, nid, pc: regs.pc, a0: regs.getGpr(4), a1: regs.getGpr(5) });
      origDispatch(code, regs);
    };

    // After the sbrk thread starts (post module_start), trace last instructions
    const lastPCs: { pc: number; raw: number }[] = [];
    while (steps < MAX_STEPS) {
      if (moduleReturned) {
        try {
          lastPCs.push({ pc: cpu.regs.pc, raw: bus.readU32(cpu.regs.pc) });
        } catch { lastPCs.push({ pc: cpu.regs.pc, raw: 0 }); }
        if (lastPCs.length > 30) lastPCs.shift();
      }
      if (!cpu.step()) break;
      if (moduleReturned && cpu.stepFaulted) break;
      steps++;
    }
    if (lastPCs.length > 0) {
      console.log(`\nLast instructions before halt:`);
      for (const { pc, raw } of lastPCs.slice(-15)) {
        console.log(`  PC=0x${pc.toString(16)} raw=0x${raw.toString(16).padStart(8, '0')}`);
      }
      // Dump key registers
      console.log(`\nRegisters at halt:`);
      for (let r = 0; r < 32; r++) {
        const v = cpu.regs.getGpr(r);
        if (v !== 0) console.log(`  r${r}=0x${v.toString(16)}`);
      }
    }

    console.log(`\nRan ${steps} steps`);
    console.log(`Module returned: ${moduleReturned}`);
    console.log(`Final PC: 0x${cpu.regs.pc.toString(16)}`);
    console.log(`Syscalls fired (${syscallLog.length}):`);
    for (const s of syscallLog) {
      const nidStr = s.nid != null ? `0x${s.nid.toString(16).padStart(8, "0")}` : "???";
      console.log(`  code=0x${s.code.toString(16)} NID=${nidStr} pc=0x${s.pc.toString(16)} a0=0x${s.a0.toString(16)} a1=0x${s.a1.toString(16)}`);
    }


    expect(moduleReturned).toBe(true);
  });
});
