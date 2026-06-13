import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/burnout-legends.iso");
const logs: string[] = [];
let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
const rdStr = (addr: number, max = 64) => {
  let s = "";
  for (let i = 0; i < max; i++) { const c = emu.bus.readU8(addr + i); if (!c) break; s += String.fromCharCode(c); }
  return s;
};
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0, a2 = regs.getGpr(6) >>> 0, a3 = regs.getGpr(7) >>> 0;
  const tid = emu.hle.currentThreadId;
  let pre = "";
  if (name === "sceIoDopen") pre = `"${rdStr(a0)}"`;
  if (name === "sceIoDevctl") pre = `dev="${rdStr(a0)}" cmd=0x${a1.toString(16)} in=0x${a2.toString(16)} inlen=${a3}`;
  if (name === "sceIoGetstat") pre = `"${rdStr(a0)}" statPtr=0x${a1.toString(16)}`;
  if (name === "sceIoLseek" || name === "sceIoLseek32" || name === "sceIoLseekAsync" || name === "sceIoLseek32Async") pre = `fd=${a0} off=${a1} whence=${a2}`;
  orig(code, regs);
  const v0 = regs.getGpr(2) >>> 0;
  if (name === "sceIoDread" && v0 === 1) {
    // SceIoDirent: SceIoStat (size at offset 8, u64) + name at offset 0x38... wait check layout
    // ScePspIoStat: mode(4) attr(4) size(8) ctime(16)... dirent name at +0x38? PSP dirent: stat(0x38 bytes? no...)
    // SceIoStat = mode 4, attr 4, size 8, 3x ScePspDateTime(16 each = 48), private 6*4=24 => 88 = 0x58
    // d_name at offset 0x58, 256 bytes
    const size = emu.bus.readU32(a1 + 8);
    const nm = rdStr(a1 + 0x58, 32);
    logs.push(`f${frame} t${tid} sceIoDread(fd=${a0}) -> 1 name="${nm}" size=${size}`);
    return;
  }
  if (["sceIoDopen", "sceIoDclose", "sceIoDevctl", "sceIoGetstat", "sceIoLseek", "sceIoLseek32", "sceIoLseekAsync", "sceIoLseek32Async"].includes(name)) {
    logs.push(`f${frame} t${tid} ${name} ${pre} -> 0x${v0.toString(16)}`);
  }
};
for (let f = 0; f < 30; f++) { frame = f; emu.runFrame(); await Promise.resolve(); }
for (const s of logs) console.log("  " + s);
