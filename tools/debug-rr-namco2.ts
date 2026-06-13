/** Ridge Racer Namco splash, part 2: per-frame compositing structure.
 *  For each frame in a window, record which FBO (render target) received
 *  clears / textured prims / untextured prims, and which buffer is presented
 *  (kernel.framebufAddr). Reveals whether the logo and its background land in
 *  the same per-address FBO (WebGL composites per-FBO; software shares RAM). */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/ridge-racer.iso");
const FROM = parseInt(process.argv[2] ?? "80", 10);
const TO = parseInt(process.argv[3] ?? "180", 10);

const normFb = (addr: number): number => {
  const p = addr & 0x1fffffff;
  return p < 0x04000000 ? 0x04000000 + p : p;
};

interface FbAct { clears: number; texPrim: number; plainPrim: number; }
let perFrame: Map<number, FbAct> = new Map();
let curFrame = 0;

function freshFb(): FbAct { return { clears: 0, texPrim: 0, plainPrim: 0 }; }

function install() {
  const ge = (emu.hle as any).geProcessor;
  if (!ge || ge.webglRenderer) return;
  ge.webglRenderer = {
    drawPrimitives(_p: number, _v: any[], state: any) {
      const fb = normFb(state.fbPtr);
      let a = perFrame.get(fb); if (!a) { a = freshFb(); perFrame.set(fb, a); }
      if (state.texEnable && state.throughMode) a.texPrim++; else a.plainPrim++;
    },
    clearRect(...args: number[]) {
      const fbPtr = args[11]!; // see ge-processor.ts:1794 arg order
      const fb = normFb(fbPtr);
      let a = perFrame.get(fb); if (!a) { a = freshFb(); perFrame.set(fb, a); }
      a.clears++;
    },
    getVFBAt() { return null; },
    blitVFB() {},
    invalidateTextures() {},
    findVFBBaseContaining() { return null; },
    readbackToVRAM() {},
    uploadRectFromVRAM() {},
  };
}

for (curFrame = 0; curFrame < TO && !emu.halted; curFrame++) {
  install();
  perFrame = new Map();
  emu.runFrame();
  if (curFrame >= FROM) {
    const disp = normFb((emu.hle as any).framebufAddr >>> 0);
    const parts = [...perFrame.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([fb, a]) => `0x${fb.toString(16)}{clr=${a.clears},tex=${a.texPrim},plain=${a.plainPrim}}${fb === disp ? "*PRESENT" : ""}`);
    console.log(`f${curFrame} disp=0x${disp.toString(16)} :: ${parts.join("  ") || "(no draws)"}`);
  }
}
console.log(`\nhalted=${emu.halted}`);
