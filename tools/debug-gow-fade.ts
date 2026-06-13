/** GoW intro fade-in: capture per-frame blend/alpha state of textured prims so
 *  we can see HOW the fade is done and why WebGL diverges from software.
 *  Installs a recording fake webglRenderer so ge-processor hands us its real
 *  draw calls (primType, vertices, drawState). */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const TO = parseInt(process.argv[2] ?? "60", 10);

const normFb = (a: number) => { const p = a & 0x1fffffff; return p < 0x04000000 ? 0x04000000 + p : p; };

let curFrame = 0;
// per-frame: list of compact prim descriptors (blended or textured only)
const perFrame: string[][] = [];

function install() {
  const ge = (emu.hle as any).geProcessor;
  if (!ge || ge.webglRenderer) return;
  ge.webglRenderer = {
    drawPrimitives(primType: number, vertices: any[], state: any) {
      const fs = state.fragState;
      const ts = state.texState;
      // only care about blended or textured draws (the fade)
      if (!fs.alphaBlendEnable && !state.texEnable) return;
      const c0 = (vertices[0]?.color >>> 0) || 0;
      const a0 = (c0 >>> 24) & 0xff;
      const desc =
        `t${primType} n${vertices.length} fb=${normFb(state.fbPtr).toString(16)} tex=${state.texEnable ? ts.texFormat : "-"}` +
        ` tf=${fs.texFunc}${fs.texFuncAlpha ? "A" : ""} env=${(fs.texEnvColor >>> 0).toString(16)}` +
        ` vA=${a0}(c=${c0.toString(16)})` +
        ` bl=${fs.alphaBlendEnable ? `${fs.blendSrc}/${fs.blendDst}op${fs.blendOp}` : "off"}` +
        (fs.blendSrc === 10 || fs.blendDst === 10 ? ` fixA=${(fs.blendFixedA >>> 0).toString(16)} fixB=${(fs.blendFixedB >>> 0).toString(16)}` : "") +
        ` at=${fs.alphaTestEnable ? `${fs.alphaTestFunc}>${fs.alphaTestRef}` : "off"}` +
        (state.colorDoubling ? " DBL" : "");
      (perFrame[curFrame] ??= []).push(desc);
    },
    clearRect() {}, getVFBAt() { return null; }, blitVFB() {},
    invalidateTextures() {}, findVFBBaseContaining() { return null; },
    readbackToVRAM() {}, uploadRectFromVRAM() {},
  };
}

for (curFrame = 0; curFrame < TO && !emu.halted; curFrame++) {
  install();
  emu.runFrame();
}

console.log(`gow halted=${emu.halted} frames=${curFrame}`);
for (let f = 0; f < perFrame.length; f++) {
  const list = perFrame[f];
  if (!list || list.length === 0) continue;
  // dedupe identical descriptors within a frame, with counts
  const counts = new Map<string, number>();
  for (const d of list) counts.set(d, (counts.get(d) ?? 0) + 1);
  console.log(`f${f}:`);
  for (const [d, n] of counts) console.log(`   x${n} ${d}`);
}
