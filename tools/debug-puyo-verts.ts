/** Dump puyo-puyo vertex data for the lists seen at frame ~298. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("public/puyo-puyo.iso");
for (let f = 0; f < 300; f++) { emu.runFrame(); await Promise.resolve(); }

// List 1: sprites VADDR=0x08a20154, VTYPE 0x80011c → through, col8888, s16 pos. stride 12.
console.log("sprites @0x8a20154 (16 vts, stride 12):");
for (let v = 0; v < 16; v++) {
  const a = 0x08a20154 + v * 12;
  const color = emu.bus.readU32(a) >>> 0;
  const x = (emu.bus.readU16(a + 4) << 16) >> 16;
  const y = (emu.bus.readU16(a + 6) << 16) >> 16;
  const z = (emu.bus.readU16(a + 8) << 16) >> 16;
  console.log(`  v${v}: color=0x${color.toString(16).padStart(8, "0")} pos=(${x},${y},${z})`);
}

// List 2: tri-strip VADDR=0x08a2419c and 0x08a24268, VTYPE 0x19f → float tc(8)+col8888(4)+float pos(12)=24
for (const base of [0x08a2419c, 0x08a24268]) {
  console.log(`\ntri-strip verts @0x${base.toString(16)} (4 vts, stride 24):`);
  for (let v = 0; v < 4; v++) {
    const a = base + v * 24;
    const fu = (o: number) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, emu.bus.readU32(a + o)); return b.getFloat32(0); };
    const u = fu(0), tv = fu(4);
    const color = emu.bus.readU32(a + 8) >>> 0;
    const x = fu(12), y = fu(16), zz = fu(20);
    console.log(`  v${v}: uv=(${u.toFixed(2)},${tv.toFixed(2)}) color=0x${color.toString(16).padStart(8, "0")} pos=(${x.toFixed(2)},${y.toFixed(2)},${zz.toFixed(2)})`);
  }
}

// GE state: dump matrices and viewport from the headless processor if accessible
const hk = emu.hle as any;
console.log(`\nframebufAddr=0x${(hk.framebufAddr >>> 0).toString(16)} geFbAddr=0x${(hk.geFbAddr >>> 0).toString(16)} fmt=${hk.framebufFormat}`);
const ge = hk.geProcessor as any;
if (ge) {
  const f = (a: Float32Array) => Array.from(a).map(v => v.toFixed(4)).join(",");
  console.log("worldMat:", f(ge.worldMat));
  console.log("viewMat: ", f(ge.viewMat));
  console.log("projMat: ", f(ge.projMat));
  console.log(`vpScale=(${ge.vpScaleX},${ge.vpScaleY},${ge.vpScaleZ}) vpCenter=(${ge.vpCenterX},${ge.vpCenterY},${ge.vpCenterZ}) geOffset=(${ge.geOffsetX},${ge.geOffsetY})`);
  console.log(`fbPtr=0x${(ge.fbPtr ?? ge.framebufPtr ?? 0).toString(16)} fbWidth=${ge.fbWidth ?? ge.framebufWidth} fbFormat=${ge.fbFormat}`);
  console.log(`scissor=(${ge.scissorX1},${ge.scissorY1})-(${ge.scissorX2},${ge.scissorY2})`);
  // simulate transformVertex on quad corner (0,0,-3.94) and (480,272,-3.94)
  for (const [x, y, z] of [[0, 0, -3.94], [480, 272, -3.94], [240, 136, -3.94]] as const) {
    const r = ge.transformVertex(x, y, z);
    console.log(`transform (${x},${y},${z}) → sx=${r.sx.toFixed(2)} sy=${r.sy.toFixed(2)} sz=${r.sz.toFixed(4)} cw=${r.cw.toFixed(4)}`);
  }
}
