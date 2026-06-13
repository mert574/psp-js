/** Verify our ISO reader returns the correct LBA/size for the files GoW streams,
 *  to compare against PPSSPP's sce_lbn sectors (GAME.BIN expected lba 0x96ec0,
 *  size 65016; FRONTEND lba 0x46480). A wrong entry could make the game skip a read. */
import { readFileSync } from "node:fs";
import { parseIso, type IsoFile } from "../src/iso/iso9660.js";

const buf = readFileSync("test/fixtures/gow-sparta.iso");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
const vol = parseIso(ab);

function find(node: IsoFile, parts: string[]): IsoFile | null {
  if (parts.length === 0) return node;
  const want = parts[0]!.toUpperCase();
  const c = (node.children ?? []).find(
    (k) => k.name.toUpperCase() === want || k.name.toUpperCase() === want + ";1",
  );
  return c ? find(c, parts.slice(1)) : null;
}

const paths = [
  ["PSP_GAME", "USRDIR", "DATA", "ENGLISH", "GAME.BIN"],
  ["PSP_GAME", "USRDIR", "DATA", "FRONTEND_ASSETS.BIN"],
  ["PSP_GAME", "USRDIR", "MOVIES", "R6_INTRO.PMF"],
  ["PSP_GAME", "USRDIR", "DATA", "KRATOS_FX.BIN"],
];
for (const p of paths) {
  const f = find(vol.root, p);
  if (f) console.log(`${p.join("/")}: lba=0x${f.lba.toString(16)} size=${f.size} (0x${f.size.toString(16)})`);
  else console.log(`${p.join("/")}: NOT FOUND`);
}
