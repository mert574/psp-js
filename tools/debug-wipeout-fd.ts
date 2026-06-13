import { readFileSync } from "node:fs";
import { parseIso, parseIsoFromFile, type IsoFile } from "../src/iso/iso9660.js";
const u8 = readFileSync("test/fixtures/wipeout-pure.iso");
const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

function count(root: IsoFile): { files: string[] } {
  const files: string[] = [];
  (function walk(n: IsoFile, p: string){ for (const c of n.children ?? []) { if (c.isDirectory) walk(c, `${p}/${c.name}`); else files.push(`${p}/${c.name}`); } })(root, "");
  return { files };
}

const sync = count(parseIso(buf));
console.log("RESULT parseIso (sync):", sync.files.length, "files; bnk:", sync.files.filter(f=>/\.bnk/i.test(f)).length);

// parseIsoFromFile needs a File/Blob
const blob = new Blob([u8]);
const file = new File([blob], "wipeout.iso");
const volF = await parseIsoFromFile(file as unknown as File);
const asyncR = count(volF.root);
console.log("RESULT parseIsoFromFile (async):", asyncR.files.length, "files; bnk:", asyncR.files.filter(f=>/\.bnk/i.test(f)).length);
console.log("RESULT sample async-only dirs:", asyncR.files.filter(f=>/Data\/Sound/i.test(f)).slice(0,5).join("\n  "));
