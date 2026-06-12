import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";
const emu = await loadGame("public/burnout-legends.iso");
const k = emu.hle as any;
let handlerRuns = 0;
let inHandler = false;
const innerCalls = new Map<string, number>();
const origInvoke = k._invokeGeCb.bind(k);
k._invokeGeCb = (func: number, a0: number, a1: number, a2?: number) => {
  const isBurnoutH = (func >>> 0) === 0x8a3823c;
  if (isBurnoutH) { handlerRuns++; inHandler = true; }
  const r = origInvoke(func, a0, a1, a2);
  if (isBurnoutH) inHandler = false;
  return r;
};
const origDisp = k.dispatch.bind(k);
k.dispatch = (code: number, regs: any) => {
  if (inHandler) {
    const nid = k.getNidBySyscallForTest(code);
    const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
    innerCalls.set(name, (innerCalls.get(name) ?? 0) + 1);
  }
  origDisp(code, regs);
};
let vblWithIntr = 0, vblTotal = 0;
const origVbl = k.onVblank?.bind(k);
for (let f = 0; f < 200; f++) { emu.runFrame(); await Promise.resolve(); }
console.log("burnout VBlank handler (0x8a3823c) runs:", handlerRuns);
console.log("syscalls made inside handler:");
for (const [n,c] of [...innerCalls.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${n}: ${c}`);
console.log("interruptsEnabled now:", k.interruptsEnabled);
const sub = k.subIntrs.get(30*32+1);
console.log("subIntr(30,1):", sub ? `handler=0x${(sub.handler>>>0).toString(16)} enabled=${sub.enabled}` : "MISSING");
