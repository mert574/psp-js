#!/usr/bin/env npx tsx
/**
 * Watch writes to a specific memory address to find what corrupts $ra.
 * Usage: npx tsx tools/watch-ra.ts <iso> [target-vaddr]
 */
import { readFileSync } from "node:fs";
import { parseIso, readFile, type IsoFile } from "../src/iso/iso9660.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";
import { Logger } from "../src/utils/logger.js";
import { toPhysical } from "../src/memory/memory-map.js";

// Auto-timeout
setTimeout(() => { console.error("\n[TIMEOUT]"); process.exit(1); }, 30_000).unref();

// Suppress verbose logs

const isoPath = process.argv[2] ?? "test/fixtures/wipeout-pure.iso";
const targetVaddr = parseInt(process.argv[3] ?? "0x0bfdf084", 16);

const isoBuffer = readFileSync(isoPath).buffer;

function findEboot(dir: IsoFile): IsoFile | undefined {
  for (const c of dir.children ?? []) {
    if (!c.isDirectory && c.name.toUpperCase().replace(/;1$/, "") === "EBOOT.BIN") return c;
    if (c.isDirectory) { const f = findEboot(c); if (f) return f; }
  }
}

function loadAllFiles(emu: PSPEmulator, dir: IsoFile, prefix: string): void {
  for (const c of dir.children ?? []) {
    if (c.isDirectory) {
      loadAllFiles(emu, c, prefix + c.name + "/");
    } else {
      emu.hle.fileData.set(prefix + c.name, readFile(isoBuffer, c).slice());
    }
  }
}

const volume = parseIso(isoBuffer);
const ebootFile = findEboot(volume.root);
if (!ebootFile) { console.error("No EBOOT.BIN"); process.exit(1); }

let data: Uint8Array = readFile(isoBuffer, ebootFile).slice();
if (isPbp(data)) data = parsePbp(data).dataPsp;
const magic = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
if (magic === 0x7e505350) {
  const dec = await pspDecryptPRX(data);
  if (!dec) { console.error("Decrypt failed"); process.exit(1); }
  data = dec;
}

const emu = new PSPEmulator();
const pspGame = volume.root.children!.find(f => f.isDirectory && f.name.toUpperCase() === "PSP_GAME");
if (pspGame) loadAllFiles(emu, pspGame, "disc0:/PSP_GAME/");

await emu.loadElfBinary(data);

// Watch writes to the target address
const physAddr = toPhysical(targetVaddr);
console.log(`Watching writes to vaddr=0x${targetVaddr.toString(16)} phys=0x${physAddr.toString(16)}`);

// Hook saveContext/restoreContext to track thread 3's $sp
const origSave = emu.hle.saveContext.bind(emu.hle);
emu.hle.saveContext = (thread, regs) => {
  origSave(thread, regs);
  if (thread.id === 3) {
    const savedSp = thread.context.gpr[29];
    const savedPc = thread.context.pc;
    console.log(`SAVE T3: sp=0x${savedSp!.toString(16)} pc=0x${savedPc.toString(16)}`);
  }
};
const origRestore = emu.hle.restoreContext.bind(emu.hle);
emu.hle.restoreContext = (thread, regs) => {
  if (thread.id === 3) {
    const savedSp = thread.context.gpr[29];
    const savedPc = thread.context.pc;
    console.log(`RESTORE T3: sp=0x${savedSp!.toString(16)} pc=0x${savedPc.toString(16)}`);
  }
  origRestore(thread, regs);
};

emu.bus.watchWriteAddr = physAddr;
let writeCount = 0;
emu.bus.onWatchWrite = (vaddr, value) => {
  writeCount++;
  const pc = emu.cpu.regs.pc;
  const sp = emu.cpu.regs.getGpr(29);
  const ra = emu.cpu.regs.getGpr(31);
  const tid = emu.hle.currentThreadId;
  // Log last 20 writes (near crash)
  if (writeCount > 200) {
    console.log(`WRITE #${writeCount} @0x${vaddr.toString(16)} = 0x${value.toString(16).padStart(8,'0')} | pc=0x${pc.toString(16)} sp=0x${sp.toString(16)} ra=0x${ra.toString(16)} tid=${tid}`);
  }
};

for (let f = 0; f < 5; f++) {
  if (emu.halted) break;
  emu.runFrame();
}
console.log(`Done: halted=${emu.halted} pc=0x${emu.cpu.regs.pc.toString(16)}`);
