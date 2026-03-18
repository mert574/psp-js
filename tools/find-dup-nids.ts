/**
 * Detect duplicate NID values across all module objects in nids.ts.
 * Run: npx tsx tools/find-dup-nids.ts
 */

import * as nids from "../src/kernel/nids.js";

const { NID_NAMES, ...modules } = nids;

// Collect all entries: { module, name, nid }
const allEntries: Array<{ module: string; name: string; nid: number }> = [];

for (const [modName, modObj] of Object.entries(modules)) {
  if (typeof modObj !== "object" || modObj === null) continue;
  for (const [fnName, nid] of Object.entries(modObj as Record<string, number>)) {
    allEntries.push({ module: modName, name: fnName, nid });
  }
}

// Group by NID value
const byNid = new Map<number, typeof allEntries>();
for (const e of allEntries) {
  if (!byNid.has(e.nid)) byNid.set(e.nid, []);
  byNid.get(e.nid)!.push(e);
}

// Report duplicates
let count = 0;
for (const [nid, entries] of byNid) {
  if (entries.length > 1) {
    count++;
    const hex = "0x" + nid.toString(16).padStart(8, "0");
    console.log(`NID ${hex}:`);
    for (const e of entries) {
      console.log(`  ${e.module}.${e.name}`);
    }
  }
}

if (count === 0) {
  console.log("No duplicate NIDs found.");
} else {
  console.log(`\nTotal: ${count} duplicate NIDs`);
}
