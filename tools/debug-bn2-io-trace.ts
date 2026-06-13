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
  if (name === "sceIoOpenAsync" || name === "sceIoOpen") {
    for (let i = 0; i < 64; i++) { const c = emu.bus.readU8(a0 + i); if (!c) break; path += String.fromCharCode(c); }
  }
  const tid = emu.hle.currentThreadId;
  orig(code, regs);
  if (name.startsWith("sceIo") || name.includes("Callback") || name.includes("Wakeup") || name.includes("Sleep")) {
    const v0 = regs.getGpr(2) >>> 0;
    let extra = "";
    if (path) extra = ` "${path}"`;
    else if (name.includes("Async") || name.includes("Read") || name.includes("Lseek") || name.includes("Close")) extra = ` fd=${a0} a1=0x${a1.toString(16)} a2=0x${a2.toString(16)}`;
    logs.push(`f${frame} t${tid} ${name}${extra} -> 0x${v0.toString(16)}`);
  }
};
for (let f = 0; f < 240; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }

// Collapse consecutive duplicate lines (ignoring frame number)
let last = "", cnt = 0, lastFull = "";
const out: string[] = [];
for (const s of [...logs, "<end>"]) {
  const k = s.replace(/^f\d+ /, "");
  if (k === last) { cnt++; continue; }
  if (lastFull) out.push(`${lastFull}${cnt > 1 ? ` x${cnt}` : ""}`);
  last = k; cnt = 1; lastFull = s;
}
console.log(`total log lines: ${logs.length}, collapsed: ${out.length}`);
for (const s of out.slice(0, 220)) console.log("  " + s);
if (out.length > 220) { console.log("  ... tail:"); for (const s of out.slice(-30)) console.log("  " + s); }
