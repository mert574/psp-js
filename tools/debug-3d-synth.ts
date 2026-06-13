/**
 * Definitive test of the shared transform+raster path WITHOUT needing a game to
 * reach 3D: drive a clean GEProcessor with identity matrices, a viewport that maps
 * NDC straight to screen, and ONE white transform-mode (non-through) triangle.
 * Then scan VRAM. Pixels written → transform/raster works (3D bug is elsewhere).
 * No pixels → the shared 3D path is broken; we then narrow which stage.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { GEProcessor } from "../src/gpu/ge-processor.js";

const emu = await loadGame("test/fixtures/puzzle-bobble.iso");
const bus = emu.bus;
const p = new GEProcessor(bus) as unknown as Record<string, unknown> & {
  doPrim: (param: number) => void;
};

// Framebuffer: VRAM, 512-wide, 8888.
p.fbPtr = 0x04000000;
p.fbWidth = 512;
p.fbFormat = 3;

// Viewport: NDC [-1,1] -> screen. sx = ndcX*scaleX + centerX - geOffsetX/16.
p.vpScaleX = 240; p.vpCenterX = 240;
p.vpScaleY = -136; p.vpCenterY = 136;   // PSP flips Y
p.vpScaleZ = 65535; p.vpCenterZ = 0;
p.geOffsetX = 0; p.geOffsetY = 0;
p.scissorX1 = 0; p.scissorY1 = 0; p.scissorX2 = 479; p.scissorY2 = 271;

// Identity world/view (4x3) + proj (4x4) are the defaults; leave them.
// Disable everything that could reject fragments.
p.clearMode = false; p.depthTestEnable = false; p.texEnable = false;
p.cullEnable = false; p.lightingEnable = false;

// vtype: transform (bit23=0), float position (posFmt=3 << 7), color8888 (colorFmt=7 << 2)
const VTYPE = (3 << 7) | (7 << 2);
p.vtypeRaw = VTYPE;

// Write 3 vertices: [u32 color][f32 x][f32 y][f32 z], 16 bytes each (color before pos).
// A big triangle around screen center in NDC.
const VADDR = 0x08200000;
const dv = new DataView(new ArrayBuffer(16 * 3));
const verts = [
  [-0.5, -0.5, 0],
  [0.5, -0.5, 0],
  [0.0, 0.5, 0],
];
for (let i = 0; i < 3; i++) {
  dv.setUint32(i * 16 + 0, 0xffffffff, true);      // white opaque ABGR
  dv.setFloat32(i * 16 + 4, verts[i]![0]!, true);
  dv.setFloat32(i * 16 + 8, verts[i]![1]!, true);
  dv.setFloat32(i * 16 + 12, verts[i]![2]!, true);
}
for (let i = 0; i < 16 * 3; i++) bus.writeU8(VADDR + i, dv.getUint8(i));
p.vertexAddr = VADDR;

// Draw: primType=3 (triangles), vertCount=3.
p.doPrim((3 << 16) | 3);

// Scan VRAM for non-black pixels.
const vram = bus.vramBuffer;
let nonBlack = 0;
let firstX = -1, firstY = -1;
for (let y = 0; y < 272; y++) {
  for (let x = 0; x < 480; x++) {
    const idx = (y * 512 + x) * 4;
    if (vram[idx]! || vram[idx + 1]! || vram[idx + 2]! || vram[idx + 3]!) {
      nonBlack++;
      if (firstX < 0) { firstX = x; firstY = y; }
    }
  }
}
console.log(`synthetic transform-mode triangle → non-black VRAM pixels: ${nonBlack}`);
console.log(`first pixel at: ${firstX},${firstY}`);
console.log(`expected: a filled triangle near screen center (~240,136)`);
