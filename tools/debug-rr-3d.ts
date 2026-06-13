/** Ridge Racer: does it ever submit transform-mode (3D) prims, and to which FB?
 *  Detects render-to-texture (3D drawn to an off-display framebuffer). */
import { loadGame } from "../test/helpers/boot-game.js";
const emu = await loadGame("test/fixtures/ridge-racer.iso");
const FRAMES = parseInt(process.argv[2] ?? "600", 10);

let wrapped = false;
const winStats = new Map<number, { thru: number; xform: number }>();
const fbTargets = new Map<number, number>(); // fbPtr -> transform-prim count
let curFrame = 0;
function wrap() {
  const ge = (emu.hle as any).geProcessor;
  if (!ge || wrapped) return; wrapped = true;
  const origPrim = ge.doPrim.bind(ge);
  ge.doPrim = (param: number) => {
    const vc = param & 0xffff;
    if (vc > 0) {
      const thru = (ge.vtypeRaw >>> 23) & 1;
      const w = Math.floor(curFrame / 60);
      let s = winStats.get(w); if (!s) { s = { thru: 0, xform: 0 }; winStats.set(w, s); }
      if (thru) s.thru++; else { s.xform++; fbTargets.set(ge.fbPtr >>> 0, (fbTargets.get(ge.fbPtr >>> 0) ?? 0) + 1); }
    }
    origPrim(param);
  };
}
for (curFrame = 0; curFrame < FRAMES && !emu.halted; curFrame++) { wrap(); emu.runFrame(); }
console.log(`ridge-racer halted=${emu.halted} wrapped=${wrapped} frames=${curFrame}`);
console.log("per-60-frame window (thru=2D, xform=3D):");
for (const [w, s] of [...winStats.entries()].sort((a,b)=>a[0]-b[0])) console.log(`  ~frame ${w*60}: 2D=${s.thru} 3D=${s.xform}`);
console.log("transform-mode prims by target framebuffer (fbPtr):");
for (const [fb, n] of [...fbTargets.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  fb=0x${fb.toString(16)}: ${n} 3D prims`);
const disp = (emu.hle as any).displayFbAddr ?? (emu.hle as any).geFbAddr;
console.log(`display FB (approx): 0x${(disp>>>0).toString(16)}`);
