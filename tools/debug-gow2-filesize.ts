/** Print sizes of the files GoW streams during boot. */
import { readFileSync } from "node:fs";
import { parseIso, type IsoFile } from "../src/iso/iso9660.js";

const buf = readFileSync("test/fixtures/gow-sparta.iso").buffer as ArrayBuffer;
const vol = parseIso(buf);
function walk(n: IsoFile, p: string): void {
  if (n.isDirectory) { for (const c of n.children ?? []) walk(c, p + "/" + c.name); }
  else if (/KRATOS_FX|FRONTEND_ASSETS|ATT_000/.test(n.name)) {
    console.log(`${p}/${n.name} size=0x${n.size.toString(16)} (${n.size})`);
  }
}
walk(vol.root, "");
