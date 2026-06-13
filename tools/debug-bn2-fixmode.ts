import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/burnout-legends.iso");
const logs: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0, a2 = regs.getGpr(6) >>> 0;
  let path = "";
  if (name === "sceIoOpen" || name === "sceIoOpenAsync") {
    for (let i = 0; i < 64; i++) { const c = emu.bus.readU8(a0 + i); if (!c) break; path += String.fromCharCode(c); }
  }
  orig(code, regs);
  const v0 = regs.getGpr(2) >>> 0;
  // FIX UNDER TEST: rewrite st_mode type bits to SCE_STM_FDIR(0x1000)/FREG(0x2000)
  if (name === "sceIoDread" && v0 === 1) {
    const m = emu.bus.readU32(a1) >>> 0;
    if (m & 0x10000) emu.bus.writeU32(a1, 0x116d);
    else if (m & 0x20000) emu.bus.writeU32(a1, 0x216d);
  }
  if (name === "sceIoGetstat" && v0 === 0) {
    const m = emu.bus.readU32(a1) >>> 0;
    if (m & 0x10000) emu.bus.writeU32(a1, 0x116d);
    else if (m & 0x20000) emu.bus.writeU32(a1, 0x216d);
  }
  if (logs.length < 400) {
    if (name === "sceIoOpen" || name === "sceIoOpenAsync") logs.push(`f${frame} t${emu.hle.currentThreadId} ${name} "${path}" -> 0x${v0.toString(16)}`);
    if (name === "sceIoReadAsync" || name === "sceIoRead") logs.push(`f${frame} t${emu.hle.currentThreadId} ${name} fd=${a0} size=0x${a2.toString(16)} -> 0x${v0.toString(16)}`);
    if (name === "sceKernelWakeupThread") logs.push(`f${frame} t${emu.hle.currentThreadId} WakeupThread(${a0}) -> 0x${v0.toString(16)}`);
  }
};
for (let f = 0; f < 400; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }

// collapse
let last = "", cnt = 0, lastFull = "";
const out: string[] = [];
for (const s of [...logs, "<end>"]) {
  const k = s.replace(/^f\d+ /, "");
  if (k === last) { cnt++; continue; }
  if (lastFull) out.push(`${lastFull}${cnt > 1 ? ` x${cnt}` : ""}`);
  last = k; cnt = 1; lastFull = s;
}
for (const s of out.slice(0, 120)) console.log("  " + s);
console.log(`\n(total events: ${logs.length})`);
// thread states at the end
const k: any = emu.hle;
for (const [id, t] of k.threads) {
  console.log(`t${id} "${t.name}" state=${t.state} waitType=${t.waitType} pc=0x${(t.context?.pc>>>0).toString(16)} prio=${t.priority}`);
}
// is main thread still in the 0x11 spin?
console.log(`current tid=${k.currentThreadId} pc=0x${(emu.cpu.regs.pc>>>0).toString(16)}`);
