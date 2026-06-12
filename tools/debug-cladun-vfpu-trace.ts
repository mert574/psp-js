/** Single-step trace of cladun's gum routine around 0x8905b00-0x8905c40.
 *  Logs each executed instruction's pc+raw and vfpr deltas. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("public/cladun-rpg.iso");
const regs = emu.cpu.regs as any;
const cpu = emu.cpu as any;

const LO = 0x8905b00, HI = 0x8905c40;
let tracing = false;
let traced = 0;
const MAX_TRACE = 300;
let prevVfpr = new Float32Array(128);
let prevPc = 0;

const origStep = cpu.step.bind(cpu);
cpu.step = () => {
  const pc = regs.pc >>> 0;
  const inRange = pc >= LO && pc < HI;
  if (!tracing && inRange && traced < MAX_TRACE) { tracing = true; prevVfpr.set(regs.vfpr); }
  let raw = 0;
  if (tracing) { raw = emu.bus.readU32(pc) >>> 0; prevPc = pc; }
  const r = origStep();
  if (tracing && traced < MAX_TRACE) {
    const deltas: string[] = [];
    for (let i = 0; i < 128; i++) {
      if (!Object.is(regs.vfpr[i], prevVfpr[i])) {
        deltas.push(`v[${i}]=${regs.vfpr[i].toPrecision(5)}`);
        prevVfpr[i] = regs.vfpr[i];
      }
    }
    console.log(`0x${prevPc.toString(16)}: 0x${raw.toString(16).padStart(8, "0")}${deltas.length ? "  → " + deltas.join(" ") : ""}`);
    traced++;
    if (!(regs.pc >= LO && regs.pc < HI)) {
      // left the window — note where we went (calls into helpers)
      console.log(`  (pc now 0x${(regs.pc >>> 0).toString(16)})`);
      if (traced >= MAX_TRACE) tracing = false;
    }
  }
  return r;
};

for (let f = 0; f < 60 && traced < MAX_TRACE; f++) { emu.runFrame(); await Promise.resolve(); }
console.log(`done, traced=${traced}`);
