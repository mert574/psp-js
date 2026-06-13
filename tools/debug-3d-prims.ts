/**
 * Why are 3D models invisible (in BOTH renderers → shared transform path)? Wrap the
 * GE vertex transform and collect, for transform-mode draws, the post-transform
 * screen-coord bounding box + clip-w sign. Degenerate/off-screen output = transform
 * or matrix-load bug.
 */
import { loadGame } from "../test/helpers/boot-game.js";

const isoPath = process.argv[2] ?? "test/fixtures/gta.iso";
const FRAMES = parseInt(process.argv[3] ?? "120", 10);
const emu = await loadGame(isoPath);

type TV = { sx: number; sy: number; sz: number; cw: number; viewZ: number };
let n = 0, onScreen = 0, wNeg = 0, behind = 0;
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
let wrapped = false;

const primByType = { through: 0, transform: 0 };
const primTypeHist = new Map<number, number>();
function tryWrap(): void {
  const ge = (emu.hle as unknown as { geProcessor: ({ transformVertex: (x: number, y: number, z: number) => TV; vtypeRaw: number; doPrim: (p: number) => void }) | null }).geProcessor;
  if (!ge || wrapped) return;
  wrapped = true;
  const origPrim = ge.doPrim.bind(ge);
  ge.doPrim = (param: number): void => {
    const vertCount = param & 0xffff;
    const pt = (param >>> 16) & 7;
    if (vertCount > 0) {
      const isThrough = (ge.vtypeRaw >>> 23) & 1;
      if (isThrough) primByType.through++; else primByType.transform++;
      if (!isThrough) primTypeHist.set(pt, (primTypeHist.get(pt) ?? 0) + 1);
    }
    origPrim(param);
  };
  const orig = ge.transformVertex.bind(ge);
  ge.transformVertex = (x: number, y: number, z: number): TV => {
    const r = orig(x, y, z);
    n++;
    if (r.sx >= 0 && r.sx < 480 && r.sy >= 0 && r.sy < 272) onScreen++;
    if (r.cw <= 0) wNeg++;
    if (r.sz < 0 || r.sz > 1) behind++;
    if (r.sx < minX) minX = r.sx; if (r.sx > maxX) maxX = r.sx;
    if (r.sy < minY) minY = r.sy; if (r.sy > maxY) maxY = r.sy;
    if (r.sz < minZ) minZ = r.sz; if (r.sz > maxZ) maxZ = r.sz;
    return r;
  };
}

for (let f = 0; f < FRAMES && !emu.halted; f++) { tryWrap(); emu.runFrame(); }

const ge = (emu.hle as unknown as { geProcessor: { _dbgPrimCount: number; vtypeRaw: number } | null }).geProcessor;
console.log(`iso=${isoPath} halted=${emu.halted} wrapped=${wrapped}`);
console.log(`transform-mode vertices transformed: ${n}`);
console.log(`  on-screen (0..480,0..272): ${onScreen}  (${n ? ((100 * onScreen) / n).toFixed(1) : 0}%)`);
console.log(`  clip-w <= 0 (behind/degenerate): ${wNeg}`);
console.log(`  depth sz outside 0..1: ${behind}`);
console.log(`  screen X range: ${minX.toFixed(1)} .. ${maxX.toFixed(1)}`);
console.log(`  screen Y range: ${minY.toFixed(1)} .. ${maxY.toFixed(1)}`);
console.log(`  depth Z range:  ${minZ.toFixed(4)} .. ${maxZ.toFixed(4)}`);
console.log(`total prims drawn (_dbgPrimCount): ${ge?._dbgPrimCount ?? "n/a"}`);
console.log(`doPrim calls: through=${primByType.through} transform=${primByType.transform}`);
console.log(`transform-mode prim types (2=tri,3=tristrip,4=trifan,...): ${[...primTypeHist].map(([t, c]) => `${t}:${c}`).join(" ") || "none"}`);
