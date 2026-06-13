/**
 * Log memory-related syscalls (args + returns) to find where GoW gets the
 * 0x99fa280 + 0x40000 region it memsets over live heap data.
 * Usage: npx tsx tools/debug-gow2-mem.ts
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const WATCH = new Set([
  "sceKernelAllocPartitionMemory",
  "sceKernelFreePartitionMemory",
  "sceKernelGetBlockHeadAddr",
  "sceKernelMaxFreeMemSize",
  "sceKernelTotalFreeMemSize",
  "sceKernelVolatileMemTryLock",
  "sceKernelVolatileMemLock",
  "sceKernelVolatileMemUnlock",
  "scePowerVolatileMemLock",
  "scePowerVolatileMemTryLock",
  "sceKernelCreateFpl",
  "sceKernelCreateVpl",
  "sceKernelTryAllocateFpl",
  "sceKernelAllocateFpl",
  "sceKernelTryAllocateVpl",
  "sceKernelAllocateVpl",
  "sceKernelSuspendDispatchThread",
  "sceKernelResumeDispatchThread",
]);

async function main() {
  const emu = await loadGame("test/fixtures/gow-sparta.iso");
  const bus = emu.bus;
  const log: string[] = [];

  const origDispatch = emu.hle.dispatch.bind(emu.hle);
  emu.hle.dispatch = (code: number, regs) => {
    const nid = emu.hle.getNidBySyscallForTest(code);
    const name = nid != null ? NID_NAMES.get(nid) : undefined;
    const watch = name !== undefined && WATCH.has(name);
    let pre = "";
    if (watch) {
      const g = (r: number) => "0x" + (regs.gpr[r]! >>> 0).toString(16);
      pre = `${name}(a0=${g(4)}, a1=${g(5)}, a2=${g(6)}, a3=${g(7)}) ra=${g(31)} tid=${emu.hle.currentThreadId}`;
    }
    origDispatch(code, regs);
    if (watch) {
      const v0 = emu.cpu.regs.gpr[2]! >>> 0;
      let extra = "";
      // For VolatileMemLock/TryLock, a1/a2 are out-pointers (addr, size)
      log.push(`${pre} → v0=0x${v0.toString(16)}${extra}`);
    }
  };

  for (let f = 0; f < 20; f++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
    await Promise.resolve();
  }
  console.log(`faulted=${emu.cpu.stepFaulted} pc=0x${emu.cpu.regs.pc.toString(16)}`);
  console.log(`\nlog (${log.length} entries):`);
  for (const l of log) console.log("  " + l);
  void bus;
}
main().catch(console.error);
