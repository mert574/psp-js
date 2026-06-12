/** Probe cladun's CLUT4 texture sampling: dump texState, sample the quad's UV region,
 *  and locate nonzero texels in raw memory. */
import { loadGame } from "../test/helpers/boot-game.js";

const emu = await loadGame("public/cladun-rpg.iso");
for (let f = 0; f < 60; f++) { emu.runFrame(); await Promise.resolve(); }

const proc = (emu.hle as any).ensureGeProcessor();
const ts = proc.texState;
console.log("texState:", JSON.stringify(ts, (k, v) => typeof v === "number" && k.toLowerCase().includes("addr") ? "0x" + (v >>> 0).toString(16) : v));
console.log("texSwizzle:", proc.texSwizzle, "texFormat:", proc.texFormat, "texW:", proc.texWidth0, "texH:", proc.texHeight0, "bufW:", proc.texBufWidth0);
console.log("clutFormat:", proc.clutFormat, "clutShift:", proc.clutShift, "clutMask:", (proc.clutMask>>>0).toString(16), "clutOffset:", proc.clutOffset);

// Raw texture: find nonzero rows (CLUT4 256 wide = 128 bytes/row)
const texAddr = 0x09027120;
const rowsWithData: number[] = [];
for (let row = 0; row < 256; row++) {
  let nz = 0;
  for (let b = 0; b < 128; b++) if (emu.bus.readU8(texAddr + row * 128 + b)) nz++;
  if (nz > 0) rowsWithData.push(row);
}
console.log(`nonzero rows (linear interpretation): ${rowsWithData.slice(0, 20).join(",")}${rowsWithData.length > 20 ? "..." : ""} (${rowsWithData.length} rows)`);

// Sample over quad region uv x∈[0,0.63], y∈[0.47,0.63]
const mod = await import("../src/gpu/ge-software-raster.js").catch(() => null);
console.log("raster module exports:", mod ? Object.keys(mod) : "n/a");

// use proc's own sampler via a fake fragment call: easier — call the module-level sampleTexture if exported
let sampleFn: any = null;
if (mod && (mod as any).sampleTexture) sampleFn = (mod as any).sampleTexture;
if (sampleFn) {
  let nonzero = 0, total = 0;
  const samples: string[] = [];
  for (let v = 0.47; v <= 0.63; v += 0.01) {
    for (let u = 0; u <= 0.63; u += 0.01) {
      const t = sampleFn(ts, emu.bus, u, v) >>> 0;
      total++;
      if (t !== 0) { nonzero++; if (samples.length < 5) samples.push(`uv=(${u.toFixed(2)},${v.toFixed(2)})→0x${t.toString(16)}`); }
    }
  }
  console.log(`sampled ${total} points in quad uv region: ${nonzero} nonzero. ${samples.join(" ")}`);
}
