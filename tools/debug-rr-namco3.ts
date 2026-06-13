/** Ridge Racer Namco splash, part 3: dump the exact clears + logo prim geometry
 *  for one drawn frame, so we can see the background clear colors and the logo
 *  quad's screen position / UVs / vertex colors (what WebGL receives). */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("test/fixtures/ridge-racer.iso");
const TARGET = parseInt(process.argv[2] ?? "94", 10);

const normFb = (addr: number): number => {
  const p = addr & 0x1fffffff;
  return p < 0x04000000 ? 0x04000000 + p : p;
};

let curFrame = 0;
let logging = false;

function install() {
  const ge = (emu.hle as any).geProcessor;
  if (!ge || ge.webglRenderer) return;
  ge.webglRenderer = {
    drawPrimitives(primType: number, vertices: any[], state: any) {
      if (!logging) return;
      const ts = state.texState;
      const fs = state.fragState;
      const vtx = vertices.slice(0, 4).map((v: any) =>
        `(x=${v.x.toFixed(1)},y=${v.y.toFixed(1)},z=${v.z.toFixed(3)},u=${v.u.toFixed(1)},v=${v.v.toFixed(1)},c=0x${(v.color >>> 0).toString(16)})`).join(" ");
      const vt = ts.vtypeRaw >>> 0;
      console.log(`  PRIM type=${primType} n=${vertices.length} fb=0x${normFb(state.fbPtr).toString(16)} through=${state.throughMode} tex=${state.texEnable} vtypeRaw=0x${vt.toString(16)} posFmt=${(vt >>> 7) & 3}`);
      console.log(`    texAddr=0x${(ts.texAddr0 >>> 0).toString(16)} fmt=${ts.texFormat} ${ts.texWidth0}x${ts.texHeight0} bw=${ts.texBufWidth0} swiz=${ts.texSwizzle} clutFmt=${ts.clutFormat} clutAddr=0x${(ts.clutAddr >>> 0).toString(16)}`);
      console.log(`    texFunc=${fs.texFunc} texFuncAlpha=${fs.texFuncAlpha} blend=${fs.alphaBlendEnable}(${fs.blendSrc}/${fs.blendDst}) atest=${fs.alphaTestEnable}(f=${fs.alphaTestFunc},r=${fs.alphaTestRef}) ctest=${fs.colorTestEnable}`);
      console.log(`    verts: ${vtx}`);
    },
    clearRect(...a: number[]) {
      if (!logging) return;
      const [x0, y0, x1, y1, r, g, b, al, cw, aw, dw, fbPtr] = a;
      console.log(`  CLEAR fb=0x${normFb(fbPtr!).toString(16)} rect=(${x0},${y0})-(${x1},${y1}) rgba=(${r},${g},${b},${al}) colorW=${cw} alphaW=${aw} depthW=${dw}`);
    },
    getVFBAt() { return null; },
    blitVFB() {},
    invalidateTextures() {},
    findVFBBaseContaining() { return null; },
    readbackToVRAM() {},
    uploadRectFromVRAM() {},
  };
}

for (curFrame = 0; curFrame <= TARGET && !emu.halted; curFrame++) {
  install();
  logging = curFrame === TARGET;
  if (logging) console.log(`=== frame ${curFrame} (disp before = 0x${normFb((emu.hle as any).framebufAddr >>> 0).toString(16)}) ===`);
  emu.runFrame();
}
console.log(`disp after = 0x${normFb((emu.hle as any).framebufAddr >>> 0).toString(16)} halted=${emu.halted}`);
