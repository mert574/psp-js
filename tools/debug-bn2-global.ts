import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/burnout-legends.iso");
const bus: any = emu.bus;
const regs: any = emu.cpu.regs;
const WATCH = [0x8bb2f10, 0x8bb2f14, 0x8bb2ef0];
const writes: string[] = [];
const wrapW = (fn: string) => {
  const orig = bus[fn].bind(bus);
  bus[fn] = (addr: number, val: number) => {
    const a = addr >>> 0;
    for (const w of WATCH) if (a >= w && a < w + 4) {
      if (writes.length < 60) writes.push(`${fn}(0x${a.toString(16)}, 0x${(val>>>0).toString(16)}) pc=0x${(regs.pc>>>0).toString(16)} tid=${emu.hle.currentThreadId}`);
    }
    return orig(addr, val);
  };
};
wrapW("writeU32"); wrapW("writeU16"); wrapW("writeU8");
let stopped = false;
const orig2 = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, r) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (name === "sceIoReadAsync" && !stopped) {
    stopped = true;
    console.log("writes to globals before first ReadAsync:");
    for (const w of writes) console.log("  " + w);
    console.log(`current: mode(0x8bb2ef0)=0x${(emu.bus.readU32(0x8bb2ef0)>>>0).toString(16)} sizeLo=0x${(emu.bus.readU32(0x8bb2f10)>>>0).toString(16)} sizeHi=0x${(emu.bus.readU32(0x8bb2f14)>>>0).toString(16)}`);
  }
  orig2(code, r);
};
for (let f = 0; f < 3 && !stopped; f++) { emu.runFrame(); await Promise.resolve(); }
if (!stopped) { console.log("no ReadAsync; writes so far:"); for (const w of writes) console.log("  " + w); }
