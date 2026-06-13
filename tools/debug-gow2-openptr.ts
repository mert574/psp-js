/**
 * Trace gow's failing sceIoOpenAsync calls: dump the path-pointer (a0), the raw
 * bytes there, and whether the game closes failed fds. Answers: is the empty
 * path a garbage/corrupted pointer (memory bug) or a real path the ISO can't
 * resolve (IO bug)?
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const kernel = emu.hle;
const bus = emu.bus;

// Recover past the null-call fault to reach steady state.
const origStep = cpu.step.bind(cpu);
cpu.step = () => {
  if ((cpu.regs.pc >>> 0) === 0) cpu.regs.pc = cpu.regs.gpr[31]! >>> 0;
  return origStep();
};

let trace = false;
const openSamples: string[] = [];
let closes = 0;
let opens = 0;

const origDispatch = kernel.dispatch.bind(kernel);
(kernel as unknown as { dispatch: typeof kernel.dispatch }).dispatch = (code: number, regs: typeof cpu.regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : `code${code}`;
  if (trace && (name === "sceIoOpenAsync" || name === "sceIoOpen")) {
    const ptr = regs.getGpr(4) >>> 0;
    opens++;
    if (openSamples.length < 20) {
      let raw = "";
      for (let i = 0; i < 32; i++) {
        const byteVal = ptr >= 0x08000000 && ptr < 0x0c000000 ? bus.readU8(ptr + i) : -1;
        if (byteVal < 0) { raw += "??"; continue; }
        raw += byteVal === 0 ? "·" : (byteVal >= 32 && byteVal < 127 ? String.fromCharCode(byteVal) : ".");
      }
      const path = kernel.readCString(bus, ptr);
      openSamples.push(`${name} a0=0x${ptr.toString(16)} path="${path}" raw[${raw}]`);
    }
  }
  if (trace && name === "sceIoClose") closes++;
  return origDispatch(code, regs);
};

for (let f = 0; f < 40; f++) emu.runFrame();
trace = true;
for (let f = 0; f < 3; f++) emu.runFrame();

console.log(`opens(async+sync) over 3 frames: ${opens}, closes: ${closes}`);
console.log("first 20 open path-pointer samples:");
for (const s of openSamples) console.log("  " + s);
