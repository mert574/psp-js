/** Dump cladun's sprite vertex colors + quad texture to see if it draws black on purpose. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("public/cladun-rpg.iso");
for (let f = 0; f < 300; f++) { emu.runFrame(); await Promise.resolve(); }

// Sprites: VADDR=0x9f4ff54, VTYPE=0x80011c → through, ARGB8888 color, s16 pos.
// Stride: color(4) + pos(3×2=6) → aligned to 4 → 12 bytes? PSP layout: [color][pos], align color 4, pos 2.
// Actually order is: tc, color, normal, pos. color offset 0 (no tc), pos at 4. size 4+6=10 → align 4 → 12.
console.log("sprite vertices @0x9f4ff54 (32 vts, trying stride 12):");
for (let v = 0; v < 32; v++) {
  const a = 0x9f4ff54 + v * 12;
  const color = emu.bus.readU32(a) >>> 0;
  const x = (emu.bus.readU16(a + 4) << 16) >> 16;
  const y = (emu.bus.readU16(a + 6) << 16) >> 16;
  const z = (emu.bus.readU16(a + 8) << 16) >> 16;
  if (v < 8 || v % 8 === 0) console.log(`  v${v}: color=0x${color.toString(16).padStart(8, "0")} pos=(${x},${y},${z})`);
}

console.log("\nraw bytes @0x9f4ff54:");
let hex = "";
for (let i = 0; i < 96; i++) hex += emu.bus.readU8(0x9f4ff54 + i).toString(16).padStart(2, "0") + (i % 16 === 15 ? "\n" : " ");
console.log(hex);

// Quad: VADDR=0x9efa5c0, VTYPE=0x19f → float tc, ARGB8888 col, float pos, transform mode
console.log("quad vertices @0x9efa5c0 (4 vts, float tc + col8888 + float pos = 8+4+12=24, align→24):");
for (let v = 0; v < 4; v++) {
  const a = 0x9efa5c0 + v * 24;
  const fu = (o: number) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, emu.bus.readU32(a + o)); return b.getFloat32(0); };
  const u = fu(0), tv = fu(4);
  const color = emu.bus.readU32(a + 8) >>> 0;
  const x = fu(12), y = fu(16), zz = fu(20);
  console.log(`  v${v}: uv=(${u.toFixed(2)},${tv.toFixed(2)}) color=0x${color.toString(16).padStart(8, "0")} pos=(${x.toFixed(2)},${y.toFixed(2)},${zz.toFixed(2)})`);
}

// Texture at 0x09027120 — check nonzero bytes
let nz = 0;
for (let i = 0; i < 0x4000; i++) if (emu.bus.readU8(0x09027120 + i)) nz++;
console.log(`\ntexture @0x9027120: ${nz}/16384 nonzero bytes`);
// CLUT at 0x09026d20
let cl = "";
for (let i = 0; i < 64; i++) cl += emu.bus.readU8(0x09026d20 + i).toString(16).padStart(2, "0") + " ";
console.log(`clut @0x9026d20: ${cl}`);

// VRAM content at fb 0x04000000: count nonzero in first 512*272*4
const vram = emu.bus.vramBuffer;
let vnz = 0;
for (let i = 0; i < 512 * 272 * 4; i++) if (vram[i]) vnz++;
console.log(`vram fb0 nonzero bytes: ${vnz}`);
console.log(`framebufAddr=0x${(emu.hle.framebufAddr >>> 0).toString(16)} geFbAddr=0x${((emu.hle as any).geFbAddr ?? 0).toString(16)}`);
