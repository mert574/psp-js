/** Register flash0 fonts (like the browser), boot cladun to the menu, and trace
 *  sceFont glyph rendering + ATRAC BGM state to diagnose invisible text + short BGM loop. */
import { readFileSync, readdirSync } from "node:fs";
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("public/cladun-rpg.iso");

// Register flash0 fonts exactly like main.ts does
const fontDir = "public/flash0/font";
for (const f of readdirSync(fontDir)) {
  if (f.endsWith(".pgf")) {
    emu.hle.fileData.set(`flash0:/font/${f}`, new Uint8Array(readFileSync(`${fontDir}/${f}`)));
  }
}

const fontCalls = new Map<string, number>();
const atracOpens: string[] = [];
const orig = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  const name = nid != null ? (NID_NAMES.get(nid) ?? "") : "";
  if (name.startsWith("sceFont")) fontCalls.set(name, (fontCalls.get(name) ?? 0) + 1);
  if (name === "sceAtracSetDataAndGetID" || name === "sceAtracSetData" || name === "sceAtracSetHalfwayBufferAndGetID") {
    atracOpens.push(`${name} buf=0x${(regs.getGpr(4)>>>0).toString(16)} size=0x${(regs.getGpr(5)>>>0).toString(16)}`);
  }
  orig(code, regs);
};

for (let f = 0; f < 350; f++) { emu.runFrame(); await Promise.resolve(); }

console.log("=== sceFont calls ===");
for (const [k, v] of [...fontCalls.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${k}: ${v}`);

console.log("\n=== ATRAC contexts ===");
const ctxs = (emu.hle as any).atracContexts ?? (emu.hle as any).atrac?.contexts;
if (ctxs) {
  for (const [id, c] of (ctxs instanceof Map ? ctxs : Object.entries(ctxs))) {
    console.log(`  atrac[${id}]: totalSamples=${c.info?.totalSamples} loopStart=${c.info?.loopStart} loopEnd=${c.info?.loopEnd} loopNum=${c.loopNum} decodePos=${c.decodePos}`);
  }
} else {
  console.log("  (no atracContexts field; opens:)", atracOpens.slice(0,5));
}
console.log("\nfont files registered:", [...emu.hle.fileData.keys()].filter(k=>k.includes("font")).length);
console.log("pgfFonts loaded:", (emu.hle as any).pgfFonts?.filter(Boolean).length, "/", (emu.hle as any).pgfFonts?.length);
