/**
 * Check VRAM contents after booting a game.
 * Usage: npx tsx tools/check-vram.ts <iso-path> [frames=100]
 */
import { readFileSync, existsSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";

const isoPath = process.argv[2]!;
const maxFrames = parseInt(process.argv[3] ?? "100", 10);

function extractEboot(buf: ArrayBuffer): Uint8Array {
  const vol = parseIso(buf);
  const pg = vol.root.children!.find(f => f.isDirectory && f.name.toUpperCase() === "PSP_GAME")!;
  const sd = pg.children!.find(f => f.isDirectory && f.name.toUpperCase() === "SYSDIR")!;
  const eb = sd.children!.find(f => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN")!;
  return readFile(buf, eb).slice();
}

function mountIso(buf: ArrayBuffer, fd: Map<string, Uint8Array>): void {
  const vol = parseIso(buf);
  (function walk(n: IsoFile, p: string) {
    if (n.isDirectory) { for (const c of n.children ?? []) walk(c, p + "/" + c.name.replace(/;1$/, "").toLowerCase()); }
    else fd.set("disc0:" + p, readFile(buf, n));
  })(vol.root, "");
}

async function main() {
  const buf = readFileSync(isoPath).buffer as ArrayBuffer;
  let data = extractEboot(buf);
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array<ArrayBuffer>;
  const view = new DataView(data.buffer, data.byteOffset, 4);
  if (view.getUint32(0, false) === 0x7e505350) {
    const dec = await pspDecryptPRX(data);
    if (!dec) { console.error("Decrypt failed"); process.exit(1); }
    data = dec as Uint8Array<ArrayBuffer>;
  }

  const emu = new PSPEmulator();
  mountIso(buf, emu.hle.fileData);
  await emu.loadElfBinary(data);

  for (let f = 0; f < maxFrames; f++) {
    emu.runFrame();
    if (emu.halted) break;
  }

  const fbAddr = emu.hle.framebufAddr;
  const geFbAddr = emu.hle.geFbAddr;
  console.log(`framebufAddr: 0x${fbAddr.toString(16)}`);
  console.log(`geFbAddr:     0x${geFbAddr.toString(16)}`);
  console.log(`fbWidth:      ${emu.hle.framebufWidth}`);
  console.log(`fbFormat:     ${emu.hle.framebufFormat}`);
  console.log(`GE prims:     ${emu.hle.gePrimCount}`);
  console.log(`GE lists:     ${emu.hle.geListCount}`);

  const vram = emu.bus.vramBuffer;
  const addr = fbAddr !== 0 ? fbAddr : geFbAddr;
  if (addr === 0) { console.log("No framebuffer set!"); return; }

  const offset = (addr & 0x1FFFFFFF) - 0x04000000;
  if (offset < 0 || offset + 480*272*4 > vram.length) {
    console.log(`FB offset 0x${offset.toString(16)} out of VRAM range`);
    return;
  }

  let nonZero = 0;
  for (let i = 0; i < 480 * 272 * 4; i++) {
    if (vram[offset + i] !== 0) nonZero++;
  }
  console.log(`VRAM non-zero bytes at FB: ${nonZero} / ${480*272*4} (${(nonZero/(480*272*4)*100).toFixed(1)}%)`);

  // Sample a few pixels
  for (let y = 0; y < 272; y += 68) {
    const row: string[] = [];
    for (let x = 0; x < 480; x += 60) {
      const px = offset + (y * 512 + x) * 4;
      row.push(`${vram[px]!.toString(16).padStart(2,'0')}${vram[px+1]!.toString(16).padStart(2,'0')}${vram[px+2]!.toString(16).padStart(2,'0')}${vram[px+3]!.toString(16).padStart(2,'0')}`);
    }
    console.log(`  y=${y}: ${row.join(' ')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
