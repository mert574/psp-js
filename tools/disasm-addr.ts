/**
 * Boot an ISO and disassemble instructions at a given address.
 * Usage: npx tsx tools/disasm-addr.ts <iso-path> <hex-addr> [count=8]
 */

import { readFileSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { decodeInstruction } from "../src/cpu/decoder.js";

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

  const regNames = [
    "zero","at","v0","v1","a0","a1","a2","a3",
    "t0","t1","t2","t3","t4","t5","t6","t7",
    "s0","s1","s2","s3","s4","s5","s6","s7",
    "t8","t9","k0","k1","gp","sp","fp","ra"
  ];
  const r = (n: number) => "$" + regNames[n];

  console.log(`\nDisassembly at 0x${addr.toString(16)} (${count} instructions):\n`);
  for (let i = 0; i < count; i++) {
    const a = addr + i * 4;
    const raw = emu.bus.readU32(a);
    const op = (raw >>> 26) & 0x3f;
    const fn = raw & 0x3f;
    const rs = (raw >>> 21) & 0x1f;
    const rt = (raw >>> 16) & 0x1f;
    const rd = (raw >>> 11) & 0x1f;
    const imm = (raw & 0xffff) << 16 >> 16;
    const uimm = raw & 0xffff;
    const target = (raw & 0x3ffffff) << 2;

    let dis = `0x${raw.toString(16).padStart(8, "0")}`;
    if (op === 0) {
      if (fn === 0x08) dis += `  jr ${r(rs)}`;
      else if (fn === 0x09) dis += `  jalr ${r(rd)}, ${r(rs)}`;
      else if (fn === 0x21) dis += `  addu ${r(rd)}, ${r(rs)}, ${r(rt)}`;
      else if (fn === 0x23) dis += `  subu ${r(rd)}, ${r(rs)}, ${r(rt)}`;
      else if (fn === 0x25) dis += `  or ${r(rd)}, ${r(rs)}, ${r(rt)}`;
      else if (fn === 0x2b) dis += `  sltu ${r(rd)}, ${r(rs)}, ${r(rt)}`;
      else if (fn === 0x00 && rd === 0) dis += `  nop`;
      else if (fn === 0x00) dis += `  sll ${r(rd)}, ${r(rt)}, ${(raw >>> 6) & 0x1f}`;
      else if (fn === 0x0c) dis += `  syscall 0x${((raw >>> 6) & 0xfffff).toString(16)}`;
      else if (fn === 0x0d) dis += `  break 0x${((raw >>> 6) & 0xfffff).toString(16)}`;
    } else if (op === 0x02) dis += `  j 0x${target.toString(16)}`;
    else if (op === 0x03) dis += `  jal 0x${target.toString(16)}`;
    else if (op === 0x04) dis += `  beq ${r(rs)}, ${r(rt)}, ${imm}`;
    else if (op === 0x05) dis += `  bne ${r(rs)}, ${r(rt)}, ${imm}`;
    else if (op === 0x08) dis += `  addi ${r(rt)}, ${r(rs)}, ${imm}`;
    else if (op === 0x09) dis += `  addiu ${r(rt)}, ${r(rs)}, ${imm}`;
    else if (op === 0x0a) dis += `  slti ${r(rt)}, ${r(rs)}, ${imm}`;
    else if (op === 0x0b) dis += `  sltiu ${r(rt)}, ${r(rs)}, ${uimm}`;
    else if (op === 0x0c) dis += `  andi ${r(rt)}, ${r(rs)}, 0x${uimm.toString(16)}`;
    else if (op === 0x0d) dis += `  ori ${r(rt)}, ${r(rs)}, 0x${uimm.toString(16)}`;
    else if (op === 0x0f) dis += `  lui ${r(rt)}, 0x${uimm.toString(16)}`;
    else if (op === 0x23) dis += `  lw ${r(rt)}, ${imm}(${r(rs)})`;
    else if (op === 0x2b) dis += `  sw ${r(rt)}, ${imm}(${r(rs)})`;

    console.log(`  0x${a.toString(16)}: ${dis}`);
  }
}
main().catch(console.error);
