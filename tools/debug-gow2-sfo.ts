/** Dump PARAM.SFO entries from gow-sparta.iso. */
import { readFileSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";

const buf = readFileSync("test/fixtures/gow-sparta.iso").buffer as ArrayBuffer;
const vol = parseIso(buf);
const pg = vol.root.children!.find((f: IsoFile) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME")!;
const sfoFile = pg.children!.find((f: IsoFile) => !f.isDirectory && f.name.toUpperCase().startsWith("PARAM.SFO"))!;
const sfo = readFile(buf, sfoFile);
const v = new DataView(sfo.buffer, sfo.byteOffset, sfo.byteLength);
const keyTableStart = v.getUint32(0x08, true);
const dataTableStart = v.getUint32(0x0c, true);
const numEntries = v.getUint32(0x10, true);
for (let i = 0; i < numEntries; i++) {
  const base = 0x14 + i * 16;
  const keyOff = v.getUint16(base, true);
  const fmt = v.getUint16(base + 2, true);
  const len = v.getUint32(base + 4, true);
  const dataOff = v.getUint32(base + 12, true);
  let key = "";
  for (let j = keyTableStart + keyOff; sfo[j] !== 0; j++) key += String.fromCharCode(sfo[j]!);
  let val: string | number;
  if (fmt === 0x0404) val = v.getUint32(dataTableStart + dataOff, true);
  else {
    val = "";
    for (let j = 0; j < len && sfo[dataTableStart + dataOff + j] !== 0; j++)
      val += String.fromCharCode(sfo[dataTableStart + dataOff + j]!);
  }
  console.log(`${key} = ${typeof val === "number" ? "0x" + val.toString(16) : JSON.stringify(val)}`);
}
