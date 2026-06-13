import { readFileSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";

const buf = readFileSync("test/fixtures/gow-sparta.iso").buffer as ArrayBuffer;
const vol = parseIso(buf);
const pg = vol.root.children!.find((f: IsoFile) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME")!;
const sd = pg.children!.find((f: IsoFile) => f.isDirectory && f.name.toUpperCase() === "SYSDIR")!;
let d: Uint8Array = readFile(buf, sd.children!.find((f: IsoFile) => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN")!).slice() as Uint8Array<ArrayBuffer>;
if (isPbp(d)) d = parsePbp(d).dataPsp as Uint8Array<ArrayBuffer>;
const v0 = new DataView(d.buffer, d.byteOffset, 4);
if (v0.getUint32(0, false) === 0x7e505350) d = (await pspDecryptPRX(d))! as Uint8Array<ArrayBuffer>;
const view = new DataView(d.buffer, d.byteOffset);
const le = true;
const phoff = view.getUint32(0x1c, le), phentsize = view.getUint16(0x2a, le), phnum = view.getUint16(0x2c, le);
console.log(`ELF type=0x${view.getUint16(0x10, le).toString(16)} phnum=${phnum}`);
let prevEnd = -1;
for (let i = 0; i < phnum; i++) {
  const ph = phoff + i * phentsize;
  const t = view.getUint32(ph, le);
  if (t !== 1) continue; // PT_LOAD
  const vaddr = view.getUint32(ph + 0x08, le), filesz = view.getUint32(ph + 0x10, le), memsz = view.getUint32(ph + 0x14, le), align = view.getUint32(ph + 0x1c, le);
  const gap = prevEnd >= 0 ? vaddr - prevEnd : 0;
  console.log(`PT_LOAD vaddr=0x${vaddr.toString(16)} filesz=0x${filesz.toString(16)} memsz=0x${memsz.toString(16)} align=0x${align.toString(16)} end=0x${(vaddr+memsz).toString(16)}${gap>0?`  GAP_FROM_PREV=0x${gap.toString(16)}`:""}`);
  prevEnd = vaddr + memsz;
}
