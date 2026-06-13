import { readFileSync } from "node:fs";
import { parseIso, type IsoFile } from "../src/iso/iso9660.js";
const buf = readFileSync("test/fixtures/gta.iso").buffer as ArrayBuffer;
const vol = parseIso(buf);
function walk(n: IsoFile, p: string, depth: number) {
  if (depth > 8) return;
  if (n.isDirectory) { for (const c of n.children ?? []) walk(c, p + "/" + c.name, depth + 1); }
  else console.log(`${p} size=0x${n.size.toString(16)} keys=${JSON.stringify(Object.keys(n))}`, JSON.stringify(n, (k, v) => k === "children" ? undefined : v).slice(0, 200));
}
walk(vol.root, "", 0);
