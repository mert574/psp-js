/** Is GoW's DiscSpinnerThread blocked on a sync object we never signal, so it
 *  never reaches the GAME.BIN raw read PPSSPP does? Maps thread name→tid, traces
 *  the DiscSpinnerThread's syscalls, and dumps all thread states at the end. */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const kernel = emu.hle as any;
const bus = emu.bus;

const os = cpu.step.bind(cpu);
cpu.step = () => { if ((cpu.regs.pc >>> 0) === 0) cpu.regs.pc = cpu.regs.gpr[31]! >>> 0; return os(); };

const nameByTid = new Map<number, string>();
let spinnerTid = -1;
const spinnerCalls: string[] = [];

const WT = ["NONE", "DELAY", "VBLANK", "SLEEP", "SEMA", "EVENT_FLAG", "AUDIO", "ATRAC_DECODE",
  "GE_DRAW_SYNC", "GE_LIST_SYNC", "THREAD_END", "MUTEX", "FPL", "VPL", "MODULE", "LWMUTEX", "CTRL", "ASYNC_IO"];
const TS = ["?", "RUNNING", "READY", "WAITING", "SUSPEND", "DORMANT", "DEAD"];

const od = kernel.dispatch.bind(kernel);
kernel.dispatch = (c: number, r: any) => {
  const nid = kernel.getNidBySyscallForTest(c);
  const name = nid != null ? NID_NAMES.get(nid) : undefined;
  if (name === "sceKernelCreateThread") {
    let s = ""; const p = r.getGpr(4) >>> 0;
    for (let i = 0; i < 32; i++) { const b = bus.readU8(p + i); if (b === 0) break; s += String.fromCharCode(b); }
    od(c, r);
    const tid = r.getGpr(2) >>> 0;
    nameByTid.set(tid, s);
    if (s === "DiscSpinnerThread") spinnerTid = tid;
    return;
  }
  const tid = kernel.currentThreadId;
  if (tid === spinnerTid && spinnerTid >= 0 && name && spinnerCalls.length < 120) {
    const a0 = r.getGpr(4) >>> 0, a1 = r.getGpr(5) >>> 0, a2 = r.getGpr(6) >>> 0;
    let path = "";
    if (name.startsWith("sceIoOpen") || name === "sceIoGetstat" || name === "sceIoDopen") {
      try { path = kernel.readCString(bus, a0); } catch { /* */ }
    }
    od(c, r);
    spinnerCalls.push(`${name}(0x${a0.toString(16)},0x${a1.toString(16)},0x${a2.toString(16)})${path ? ` "${path}"` : ""} → 0x${(r.getGpr(2) >>> 0).toString(16)}`);
    return;
  }
  return od(c, r);
};

for (let f = 0; f < 80 && !emu.halted; f++) emu.runFrame();

console.log(`gow halted=${emu.halted} spinnerTid=${spinnerTid}`);
console.log("\n--- thread states at end ---");
for (const [tid, t] of kernel.threads as Map<number, any>) {
  const nm = nameByTid.get(tid) ?? t.name ?? "?";
  let waiting = "";
  if (TS[t.state] === "WAITING") {
    const wt = WT[t.waitType] ?? t.waitType;
    let id = "";
    if (t.waitType === 4) id = ` sema=${t.waitSemaId}`;
    else if (t.waitType === 5) id = ` evf=${t.waitEvfId}`;
    else if (t.waitType === 11) id = ` mutex=${t.waitMutexId}`;
    else if (t.waitType === 15) id = ` lwmutex=${t.waitMutexId}`;
    else if (t.waitType === 10) id = ` threadEnd=${t.waitThreadEndId}`;
    waiting = ` wait=${wt}${id}`;
  }
  console.log(`  t${tid} "${nm}" state=${TS[t.state] ?? t.state}${waiting} pc=0x${(t.context?.pc ?? 0).toString(16)}`);
}

console.log("\n--- DiscSpinnerThread syscalls ---");
for (const l of spinnerCalls) console.log("  " + l);
