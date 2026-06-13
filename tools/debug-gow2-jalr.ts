/**
 * gow fault: find which guest-callback mechanism runs the dispatch loop
 * (0x88e5100) during the table[0]==NULL window. Logs every _invokeGeCb with
 * its target, plus the slot writes and the null-window call.
 */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const bus = emu.bus;
const kernel = emu.hle;
const SLOT = 0x99fcb60;

const events: string[] = [];
const push = (s: string) => { events.push(s); if (events.length > 40) events.shift(); };

const ow32 = bus.writeU32.bind(bus);
bus.writeU32 = (addr, value) => {
  if ((addr >>> 0) === SLOT) {
    push(`[w32] slot=0x${(value >>> 0).toString(16)} pc=0x${cpu.regs.pc.toString(16)} t${kernel.currentThreadId}`);
  }
  ow32(addr, value);
};
const ow8 = bus.writeU8.bind(bus);
bus.writeU8 = (addr, value) => {
  const a = addr >>> 0;
  if (a >= SLOT && a < SLOT + 4) {
    push(`[w8] 0x${a.toString(16)}=${value & 0xff} pc=0x${cpu.regs.pc.toString(16)} t${kernel.currentThreadId}`);
  }
  ow8(addr, value);
};
const ow16 = bus.writeU16.bind(bus);
bus.writeU16 = (addr, value) => {
  const a = addr >>> 0;
  if (a >= SLOT - 1 && a < SLOT + 4) {
    push(`[w16] 0x${a.toString(16)}=0x${(value & 0xffff).toString(16)} pc=0x${cpu.regs.pc.toString(16)} t${kernel.currentThreadId}`);
  }
  ow16(addr, value);
};

type InvokeFn = (func: number, a0: number, a1: number, a2: number) => void;
const k = kernel as unknown as { _invokeGeCb: InvokeFn };
const origInvoke = k._invokeGeCb.bind(kernel);
k._invokeGeCb = (func, a0, a1, a2) => {
  push(`[cb] func=0x${(func >>> 0).toString(16)} a0=0x${(a0 >>> 0).toString(16)} a1=0x${(a1 >>> 0).toString(16)} t${kernel.currentThreadId} pausedPc=0x${cpu.regs.pc.toString(16)}`);
  origInvoke(func, a0, a1, a2);
};

let nullCall = "";
const ring = new Array<number>(96).fill(0);
let ringI = 0;
const origStep = cpu.step.bind(cpu);
cpu.step = () => {
  const pc = cpu.regs.pc >>> 0;
  ring[ringI++ % 96] = pc;
  if (pc === 0x88e5100 && bus.readU32(SLOT) === 0 && !nullCall) {
    nullCall = `[CALL-NULL] t${kernel.currentThreadId} ra=0x${(cpu.regs.gpr[31]! >>> 0).toString(16)}`;
    push(nullCall);
    // Dump the last 96 pcs, compressed to transitions (skip sequential runs)
    const seq: string[] = [];
    let prev = -10;
    for (let i = 0; i < 96; i++) {
      const p = ring[(ringI + i) % 96]!;
      if (p !== prev + 4) seq.push(p.toString(16));
      prev = p;
    }
    push("[ring] " + seq.join(" "));
  }
  return origStep();
};

for (let f = 0; f < 20; f++) {
  emu.runFrame();
  if (emu.halted) break;
}

console.log("RESULT halted:", emu.halted, "nullCall:", nullCall);
console.log(events.join("\n"));
