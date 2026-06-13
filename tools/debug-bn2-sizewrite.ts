import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

// Phase 1: find s3 (the file-handle struct) at first ReadAsync
const emu1 = await loadGame("test/fixtures/burnout-legends.iso");
let s3 = 0;
const orig1 = emu1.hle.dispatch.bind(emu1.hle);
emu1.hle.dispatch = (code, regs) => {
  const nid = emu1.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (name === "sceIoReadAsync" && !s3) {
    s3 = regs.getGpr(19) >>> 0;
    console.log(`s3 = 0x${s3.toString(16)}`);
    for (let o = 0; o <= 0x34; o += 4) console.log(`  *(s3+0x${o.toString(16)}) = 0x${(emu1.bus.readU32(s3+o)>>>0).toString(16)}`);
  }
  orig1(code, regs);
};
for (let f = 0; f < 3 && !s3; f++) { emu1.runFrame(); await Promise.resolve(); }
if (!s3) { console.log("no ReadAsync seen"); process.exit(1); }

// Phase 2: fresh boot, watch writes to [s3+8, s3+0x18)
const emu2 = await loadGame("test/fixtures/burnout-legends.iso");
const bus: any = emu2.bus;
const lo = s3 + 8, hi = s3 + 0x18;
const writes: string[] = [];
const cpu: any = emu2.cpu;
const regs2: any = emu2.cpu.regs;
const wrapW = (fn: string) => {
  const orig = bus[fn].bind(bus);
  bus[fn] = (addr: number, val: number) => {
    if ((addr >>> 0) >= lo && (addr >>> 0) < hi && writes.length < 40) {
      writes.push(`${fn}(0x${(addr>>>0).toString(16)}, 0x${(val>>>0).toString(16)}) pc=0x${(regs2.pc>>>0).toString(16)} tid=${emu2.hle.currentThreadId}`);
    }
    return orig(addr, val);
  };
};
wrapW("writeU32"); wrapW("writeU16"); wrapW("writeU8");
let stopped = false;
const orig2 = emu2.hle.dispatch.bind(emu2.hle);
emu2.hle.dispatch = (code, regs) => {
  const nid = emu2.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (name === "sceIoReadAsync" && !stopped) {
    stopped = true;
    console.log("\nwrites to s3+8..s3+0x17 before first ReadAsync:");
    for (const w of writes) console.log("  " + w);
  }
  orig2(code, regs);
};
for (let f = 0; f < 3 && !stopped; f++) { emu2.runFrame(); await Promise.resolve(); }
