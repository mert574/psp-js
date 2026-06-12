/** Decrypt a game's EBOOT.BIN and report what comes out (ELF magic, sections, gzip). */
import { readFileSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";

const isoPath = process.argv[2] ?? "public/metal-slug.iso";
const buf = readFileSync(isoPath).buffer as ArrayBuffer;
const vol = parseIso(buf);

function find(node: IsoFile, path: string): IsoFile | null {
  const parts = path.split("/");
  let cur: IsoFile | undefined = node;
  for (const p of parts) {
    cur = cur?.children?.find((c) => c.name.toUpperCase().replace(/;1$/, "") === p);
    if (!cur) return null;
  }
  return cur;
}

const f = find(vol.root, "PSP_GAME/SYSDIR/EBOOT.BIN")!;
const data = readFile(buf, f).slice();
console.log(`EBOOT size=${data.length}`);
const out = await pspDecryptPRX(data as Uint8Array<ArrayBuffer>);
if (!out) { console.log("decrypt returned null"); process.exit(1); }
console.log(`decrypted size=${out.length}`);
const dv = new DataView(out.buffer, out.byteOffset, Math.min(64, out.length));
let hex = "";
for (let i = 0; i < 64 && i < out.length; i++) hex += dv.getUint8(i).toString(16).padStart(2, "0") + (i % 16 === 15 ? "\n" : " ");
console.log(hex);
const magic = dv.getUint32(0, false);
console.log(`magic=0x${magic.toString(16)} (${magic === 0x7f454c46 ? "ELF ✓" : magic === 0x1f8b0800 || (dv.getUint16(0, false) === 0x1f8b) ? "GZIP" : "???"})`);
