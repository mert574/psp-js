/**
 * Boot an ISO and disassemble instructions at a given address.
 * Usage: npx tsx tools/disasm-addr.ts <iso-path> <hex-addr> [count=8]
 */

import { readFileSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { disassemble } from "../src/cpu/disasm.js";

const isoPath = process.argv[2]!;
const addr = parseInt(process.argv[3]!, 16);
const count = parseInt(process.argv[4] ?? "12", 10);

async function main() {
  const buf = readFileSync(isoPath).buffer as ArrayBuffer;
  const vol = parseIso(buf);
  const pg = vol.root.children!.find((f: IsoFile) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME")!;
  const sd = pg.children!.find((f: IsoFile) => f.isDirectory && f.name.toUpperCase() === "SYSDIR")!;
  let data: Uint8Array = readFile(buf, sd.children!.find((f: IsoFile) => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN")!).slice() as Uint8Array<ArrayBuffer>;
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array<ArrayBuffer>;
  const v = new DataView(data.buffer, data.byteOffset, 4);
  if (v.getUint32(0, false) === 0x7e505350) data = (await pspDecryptPRX(data))! as Uint8Array<ArrayBuffer>;

  const emu = new PSPEmulator();
  function walk(node: IsoFile, path: string): void {
    if (node.isDirectory) { for (const c of node.children ?? []) walk(c, path + "/" + c.name.replace(/;1$/, "").toLowerCase()); }
    else { emu.hle.fileData.set("disc0:" + path, readFile(buf, node)); }
  }
  walk(parseIso(buf).root, "");
  await emu.loadElfBinary(data);
  for (let i = 0; i < 3; i++) emu.runFrame();

  console.log(`\nDisassembly at 0x${addr.toString(16)} (${count} instructions):\n`);
  for (let i = 0; i < count; i++) {
    const a = addr + i * 4;
    const raw = emu.bus.readU32(a) >>> 0;
    console.log(`  0x${a.toString(16)}: 0x${raw.toString(16).padStart(8, "0")}  ${disassemble(raw, a)}`);
  }
}
main().catch(console.error);
