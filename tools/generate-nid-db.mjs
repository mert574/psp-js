// Generate the NID index from this project's declared syscall constants.
import { readFileSync, writeFileSync } from "node:fs";
const source = readFileSync(new URL("../src/kernel/nids.ts", import.meta.url), "utf8");
const entries = new Map();
for (const match of source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(0x[\da-f]+)\s*,/gmi)) {
  const value = Number(match[2]) >>> 0;
  entries.set(`${value}:${match[1]}`, { value, name: match[1] });
}
const sorted = [...entries.values()].sort((a,b)=>a.value-b.value || a.name.localeCompare(b.name,"en"));
const rows = sorted.map(({value,name})=>`<FUNCTION><NID>0x${value.toString(16).toUpperCase().padStart(8,"0")}</NID><NAME>${name}</NAME></FUNCTION>`);
writeFileSync(new URL("../ppsspp_niddb.xml", import.meta.url), `<?xml version="1.0"?>\n<!-- Generated from src/kernel/nids.ts by tools/generate-nid-db.mjs. -->\n<FUNCTIONS>\n${rows.join("\n")}\n</FUNCTIONS>\n`);
console.log(`Generated ${rows.length} project NID entries.`);
