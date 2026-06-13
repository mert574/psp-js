/** Ridge Racer Namco splash: capture exactly what the GE would send to WebGL.
 *  Software shows the logo; WebGL is black. Both consume identical (primType,
 *  vertices, drawState), so the divergence is WebGL-only. This installs a
 *  recording fake webglRenderer (so ge-processor takes the WebGL branch and
 *  hands us its real draw calls) and checks the two WebGL-only paths:
 *    A) framebuffer-as-texture: normFb(texAddr0) collides with a render target.
 *    B) present mismatch: draw-target fbPtr != displayed buffer.
 *  Also decodes one captured texture to confirm the bytes aren't black. */
import { loadGame } from "../test/helpers/boot-game.js";
import { decodeTexture } from "../src/gpu/ge-texture-upload.js";

const emu = await loadGame("test/fixtures/ridge-racer.iso");
const FRAMES = parseInt(process.argv[2] ?? "400", 10);

const normFb = (addr: number): number => {
  const p = addr & 0x1fffffff;
  return p < 0x04000000 ? 0x04000000 + p : p;
};

interface Sig {
  count: number;
  frames: number[];
  texAddr0: number;
  texFmt: number;
  clutFmt: number;
  texFunc: number;
  texFuncAlpha: boolean;
  blend: boolean;
  blendSrc: number;
  blendDst: number;
  atest: boolean;
  atestFunc: number;
  atestRef: number;
  firstColor: number;
  fbPtr: number;
  texW: number;
  texH: number;
  swizzle: boolean;
  decodedNonBlack: number; // count of non-black texels in a 32x32 sample
}

const sigs = new Map<string, Sig>();
const renderTargets = new Set<number>(); // normFb of every fbPtr drawn to
let curFrame = 0;
let wrapped = false;

function decodeSampleNonBlack(state: any): number {
  try {
    const { data, width, height } = decodeTexture((emu.hle as any).bus, state);
    let nb = 0;
    const sx = Math.max(1, (width / 32) | 0);
    const sy = Math.max(1, (height / 32) | 0);
    for (let y = 0; y < height; y += sy) {
      for (let x = 0; x < width; x += sx) {
        const i = (y * width + x) * 4;
        if (data[i]! | data[i + 1]! | data[i + 2]!) nb++;
      }
    }
    return nb;
  } catch {
    return -1;
  }
}

function installRecorder() {
  const ge = (emu.hle as any).geProcessor;
  if (!ge || ge.webglRenderer) return;
  wrapped = true;
  const bus = ge.bus;
  ge.webglRenderer = {
    drawPrimitives(_primType: number, vertices: any[], state: any) {
      renderTargets.add(normFb(state.fbPtr));
      if (!state.throughMode || !state.texEnable) return;
      const ts = state.texState;
      const fs = state.fragState;
      const key = `${ts.texAddr0}|${ts.texFormat}|${ts.clutFormat}|${fs.texFunc}|${fs.alphaBlendEnable}|${fs.alphaTestEnable}`;
      let s = sigs.get(key);
      if (!s) {
        s = {
          count: 0, frames: [],
          texAddr0: ts.texAddr0 >>> 0, texFmt: ts.texFormat, clutFmt: ts.clutFormat,
          texFunc: fs.texFunc, texFuncAlpha: fs.texFuncAlpha,
          blend: fs.alphaBlendEnable, blendSrc: fs.blendSrc, blendDst: fs.blendDst,
          atest: fs.alphaTestEnable, atestFunc: fs.alphaTestFunc, atestRef: fs.alphaTestRef,
          firstColor: vertices[0]?.color >>> 0, fbPtr: normFb(state.fbPtr),
          texW: ts.texWidth0, texH: ts.texHeight0, swizzle: ts.texSwizzle,
          decodedNonBlack: decodeSampleNonBlack(ts),
        };
        sigs.set(key, s);
      }
      s.count++;
      if (s.frames.length < 6) s.frames.push(curFrame);
    },
    clearRect() {},
    getVFBAt() { return null; },
    blitVFB() {},
    invalidateTextures() {},
    findVFBBaseContaining() { return null; },
    readbackToVRAM() {},
    uploadRectFromVRAM() {},
  };
  // keep bus reachable for the decode helper
  (emu as any).bus = bus;
}

for (curFrame = 0; curFrame < FRAMES && !emu.halted; curFrame++) {
  installRecorder();
  emu.runFrame();
}

const dispNorm = normFb((emu.hle as any).framebufAddr >>> 0);
console.log(`ridge-racer halted=${emu.halted} wrapped=${wrapped} frames=${curFrame}`);
console.log(`display buffer (normFb of kernel.framebufAddr) = 0x${dispNorm.toString(16)}`);
console.log(`render targets seen (normFb of fbPtr): ${[...renderTargets].map(a => "0x" + a.toString(16)).join(", ")}`);
console.log(`textured through-mode prim signatures: ${sigs.size}`);
for (const s of [...sigs.values()].sort((a, b) => b.count - a.count)) {
  const tn = normFb(s.texAddr0);
  const collide = renderTargets.has(tn);
  const present = s.fbPtr === dispNorm;
  console.log(
    `\n  texAddr=0x${s.texAddr0.toString(16)} (normFb=0x${tn.toString(16)}) fmt=${s.texFmt} clutFmt=${s.clutFmt} ${s.texW}x${s.texH} swiz=${s.swizzle}` +
    `\n    count=${s.count} frames=[${s.frames.join(",")}${s.count > 6 ? ",..." : ""}]` +
    `\n    texFunc=${s.texFunc} texFuncAlpha=${s.texFuncAlpha} firstVtxColor=0x${(s.firstColor >>> 0).toString(16)}` +
    `\n    blend=${s.blend}(src=${s.blendSrc},dst=${s.blendDst}) atest=${s.atest}(func=${s.atestFunc},ref=${s.atestRef})` +
    `\n    decodedNonBlackTexels(of ~1024)=${s.decodedNonBlack}` +
    `\n    drawTargetFb=0x${s.fbPtr.toString(16)}  -> FB-AS-TEX collision=${collide}  presentMatch=${present}`,
  );
}
