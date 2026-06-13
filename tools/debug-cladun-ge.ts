/**
 * Capture how cladun composes its frame: prim target framebuffers, block
 * transfer destinations, and the scanned-out display address. Headless, so the
 * inline GE runs the software path (writes into VRAM) — this tells us which
 * composition path the WebGL renderer must reproduce.
 *
 * Usage: npx tsx tools/debug-cladun-ge.ts [iso=test/fixtures/cladun-rpg.iso] [frames=200]
 */

import { readFileSync, existsSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

const isoPath = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "test/fixtures/cladun-rpg.iso";
const maxFrames = parseInt(process.argv[3] ?? "200", 10);

if (!existsSync(isoPath)) { console.error(`ISO not found: ${isoPath}`); process.exit(1); }

function extractEboot(buf: ArrayBuffer): Uint8Array {
  const v = parseIso(buf);
  const g = v.root.children!.find(f => f.isDirectory && f.name.toUpperCase() === "PSP_GAME")!;
  const s = g.children!.find(f => f.isDirectory && f.name.toUpperCase() === "SYSDIR")!;
  const e = s.children!.find(f => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN")!;
  return readFile(buf, e).slice();
}
function mountIso(buf: ArrayBuffer, fileData: Map<string, Uint8Array>): void {
  const v = parseIso(buf);
  (function walk(n: IsoFile, p: string) {
    if (n.isDirectory) for (const c of n.children ?? []) walk(c, p + "/" + c.name.replace(/;1$/, "").toLowerCase());
    else fileData.set("disc0:" + p, readFile(buf, n));
  })(v.root, "");
}

const hex = (n: number) => "0x" + (n >>> 0).toString(16);

async function main() {
  const isoBuffer = readFileSync(isoPath).buffer as ArrayBuffer;
  let data = extractEboot(isoBuffer);
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array<ArrayBuffer>;
  const dv = new DataView(data.buffer, data.byteOffset, 4);
  if (dv.getUint32(0, false) === 0x7e505350) {
    const dec = await pspDecryptPRX(data);
    if (!dec) { console.error("decrypt failed"); process.exit(1); }
    data = dec as Uint8Array<ArrayBuffer>;
  }

  Logger.setErrorHook(() => {});
  Logger.setWarnHook(() => {});

  const emu = new PSPEmulator();
  mountIso(isoBuffer, emu.hle.fileData);
  await emu.loadElfBinary(data);

  const ge = emu.hle.ensureGeProcessor() as any;

  // toPhysical mirror (strip top virtual bits, VRAM-relative → absolute)
  const phys = (a: number) => {
    const p = a & 0x1fffffff;
    return p < 0x04000000 ? 0x04000000 + p : p;
  };

  const primFb = new Map<number, number>();    // fb addr → prim count
  const primFmt = new Map<number, Set<number>>();
  const xferDst = new Map<number, { count: number; w: number; h: number; bpp: number; stride: number }>();
  let xferTotal = 0;

  const sig = new Map<string, number>(); // draw-state signature → prim count

  // Per-texAddr: prim count, texture dims, on-screen bounding box, z range.
  const byTex = new Map<string, { n: number; tw: number; th: number; bw: number;
    minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number; depth: Set<number> }>();
  const recordVert = (key: string, v: any) => {
    const e = byTex.get(key)!;
    if (v.x < e.minX) e.minX = v.x; if (v.x > e.maxX) e.maxX = v.x;
    if (v.y < e.minY) e.minY = v.y; if (v.y > e.maxY) e.maxY = v.y;
    if (v.z < e.minZ) e.minZ = v.z; if (v.z > e.maxZ) e.maxZ = v.z;
  };
  const ensureTex = (key: string) => {
    if (!byTex.has(key)) byTex.set(key, { n: 0, tw: ge.texWidth0, th: ge.texHeight0, bw: ge.texBufWidth0,
      minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9, depth: new Set() });
    return byTex.get(key)!;
  };
  const texKey = () => `tex=${ge.texEnable ? hex(ge.texAddr0) : "none"}`;

  const origSprite = ge.drawSprite.bind(ge);
  ge.drawSprite = (v0: any, v1: any) => {
    const k = texKey(); const e = ensureTex(k); e.n++; e.depth.add(ge.depthTestEnable ? 1 : 0);
    recordVert(k, v0); recordVert(k, v1);
    origSprite(v0, v1);
  };
  const origTri = ge.drawTriangle.bind(ge);
  ge.drawTriangle = (v0: any, v1: any, v2: any) => {
    const k = texKey(); const e = ensureTex(k); e.n++; e.depth.add(ge.depthTestEnable ? 1 : 0);
    recordVert(k, v0); recordVert(k, v1); recordVert(k, v2);
    origTri(v0, v1, v2);
  };

  let clearRects = 0, clearRectsDepth = 0;
  const clearZ = new Set<number>();
  const origClear = ge.doClearRect.bind(ge);
  ge.doClearRect = (v0: any, v1: any) => {
    clearRects++;
    if (ge.clearDepthWrite) { clearRectsDepth++; clearZ.add(Number(v1.z.toFixed(4))); }
    origClear(v0, v1);
  };

  const origPrim = ge.doPrim.bind(ge);
  ge.doPrim = (param: number) => {
    const primType = (param >>> 16) & 7;
    const through = (ge.vtypeRaw >>> 23) & 1;
    const s = `prim=${primType} through=${through} tex=${ge.texEnable ? 1 : 0} texFmt=${ge.texFormat}`
      + ` clutFmt=${ge.clutFormat} blend=${ge.alphaBlendEnable ? 1 : 0} depthTest=${ge.depthTestEnable ? 1 : 0}`
      + ` depthFunc=${ge.depthFunc} zWriteDis=${ge.depthWriteDisable ? 1 : 0} clearMode=${ge.clearMode ? 1 : 0}`
      + ` texAddr=${ge.texAddr0 ? hex(ge.texAddr0) : "0"}`;
    sig.set(s, (sig.get(s) ?? 0) + 1);
    origPrim(param);
    const fb = phys(ge.fbPtr);
    primFb.set(fb, (primFb.get(fb) ?? 0) + 1);
    if (!primFmt.has(fb)) primFmt.set(fb, new Set());
    primFmt.get(fb)!.add(ge.fbFormat);
  };

  const origXfer = ge.doBlockTransfer.bind(ge);
  ge.doBlockTransfer = () => {
    const dst = phys(ge.trDst);
    const w = (ge.trSize & 0x3ff) + 1;
    const h = ((ge.trSize >>> 10) & 0x3ff) + 1;
    const e = xferDst.get(dst) ?? { count: 0, w, h, bpp: ge.trBpp, stride: ge.trDstW || 512 };
    e.count++; e.w = w; e.h = h; e.bpp = ge.trBpp; e.stride = ge.trDstW || 512;
    xferDst.set(dst, e);
    xferTotal++;
    origXfer();
  };

  for (let f = 0; f < maxFrames; f++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
  }

  console.log(`\n=== cladun GE composition (${maxFrames} frames) ===`);
  console.log(`display framebuf (sceDisplaySetFrameBuf): ${hex(phys(emu.hle.framebufAddr))} w=${emu.hle.framebufWidth} fmt=${emu.hle.framebufFormat}`);
  console.log(`GE prims total: ${emu.hle.gePrimCount}, block transfers total: ${xferTotal}`);
  console.log(`clearMode rects: ${clearRects} (clearing depth: ${clearRectsDepth}); clear-z values: {${[...clearZ].join(",")}}`);

  console.log(`\nPrim target framebuffers (addr → prim count, formats):`);
  for (const [fb, c] of [...primFb.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${hex(fb)} → ${c} prims, fmt={${[...(primFmt.get(fb) ?? [])].join(",")}}`);

  console.log(`\nDraw-state signatures (count → state):`);
  for (const [s, c] of [...sig.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(c).padStart(4)} ${s}`);

  console.log(`\nPer-texture: count, texdims, screen bbox, z range, depthTest:`);
  for (const [k, e] of [...byTex.entries()].sort((a, b) => b[1].n - a[1].n))
    console.log(`  ${k}: n=${e.n} texW=${e.tw} texH=${e.th} bw=${e.bw}`
      + ` bbox=[${e.minX.toFixed(0)},${e.minY.toFixed(0)} .. ${e.maxX.toFixed(0)},${e.maxY.toFixed(0)}]`
      + ` z=[${e.minZ.toFixed(3)},${e.maxZ.toFixed(3)}] depthTest={${[...e.depth].join(",")}}`);

  console.log(`\nBlock-transfer destinations (addr → count, last rect):`);
  for (const [dst, e] of [...xferDst.entries()].sort((a, b) => b[1].count - a[1].count))
    console.log(`  ${hex(dst)} → ${e.count}x  ${e.w}x${e.h} bpp=${e.bpp} stride=${e.stride}`);

  console.log("");
}
main().catch(e => { console.error(e); process.exit(1); });
