#!/usr/bin/env npx tsx
// Auto-timeout
setTimeout(() => { console.error("\n[TIMEOUT]"); process.exit(1); }, 30_000).unref();
import { readFileSync } from "node:fs";
import { parseIso, readFile } from "../src/iso/iso9660.js";
import type { IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";

function findEboot(dir: IsoFile): IsoFile | undefined {
  for (const c of dir.children ?? []) {
    if (!c.isDirectory && c.name.toUpperCase().replace(/;1$/, "") === "EBOOT.BIN") return c;
    if (c.isDirectory) { const f = findEboot(c); if (f) return f; }
  }
}
function mountIso(path: string, fileData: Map<string, Uint8Array>) {
  const buf = readFileSync(path).buffer as ArrayBuffer;
  const vol = parseIso(buf);
  function walk(node: IsoFile, p: string) {
    if (node.isDirectory) { for (const c of node.children ?? []) walk(c, p + "/" + c.name.replace(/;1$/, "").toLowerCase()); }
    else fileData.set("disc0:" + p, readFile(buf, node));
  }
  walk(vol.root, "");
}
async function loadEboot(isoPath: string): Promise<Uint8Array> {
  const buf = readFileSync(isoPath).buffer as ArrayBuffer;
  const vol = parseIso(buf);
  const entry = findEboot(vol.root)!;
  let data = readFile(buf, entry).slice() as Uint8Array;
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array;
  const v = new DataView(data.buffer, data.byteOffset, 4);
  if (v.getUint32(0, false) === 0x7e505350) data = (await pspDecryptPRX(data)) as Uint8Array;
  return data;
}

Logger.minLevel = "warn";
const data = await loadEboot("test/fixtures/space-invaders.iso");
const emu = new PSPEmulator();
mountIso("test/fixtures/space-invaders.iso", emu.hle.fileData);

// Intercept thread creation and track thread states
const origDispatch = emu.hle.dispatch.bind(emu.hle);
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  if (nid === 0x446d8de6) { // sceKernelCreateThread
    const entry = regs.getGpr(5);
    console.log(`CreateThread entry=0x${entry.toString(16)} prio=${regs.getGpr(6)} stack=${regs.getGpr(7)}`);
  }
  if (nid === 0xf475845d) { // sceKernelStartThread
    const tid = regs.getGpr(4);
    console.log(`StartThread tid=${tid} argLen=${regs.getGpr(5)} argp=0x${regs.getGpr(6).toString(16)}`);
  }
  origDispatch(code, regs);
};

await emu.loadElfBinary(data);

for (let f = 0; f < 60; f++) {
  emu.runFrame(2_000_000);
  if (emu.halted || emu.cpu.stepFaulted) { console.log(`Stopped at frame ${f + 1}`); break; }
}

// Dump thread states
console.log(`\n=== Thread states ===`);
console.log(`Current thread: ${emu.hle.currentThreadId}`);
for (const [id, thread] of (emu.hle as any).threads as Map<number, any>) {
  console.log(`  tid=${id} state=${thread.state} prio=${thread.priority} pc=0x${thread.context?.pc?.toString(16) ?? '?'} waitType=${thread.waitType ?? '?'}`);
}

console.log(`\nPC=0x${emu.cpu.regs.pc.toString(16)} halted=${emu.halted} faulted=${emu.cpu.stepFaulted}`);
