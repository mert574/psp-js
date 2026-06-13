/**
 * Check whether gow's reads hand it correct data. Traces every sceIoRead/
 * sceIoReadAsync + Lseek with fd, position, size, first bytes, and flags
 * re-reads of the same (fd,offset) — a "stuck re-reading garbage" pattern.
 * Also counts async completions vs issues to catch reads that never finish.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { IO } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const k = emu.hle;
const bus = emu.bus;

const NID = {
  open: IO.sceIoOpen, openAsync: IO.sceIoOpenAsync,
  read: IO.sceIoRead, readAsync: IO.sceIoReadAsync,
  lseek: IO.sceIoLseek, lseekAsync: IO.sceIoLseekAsync,
};

const opens = new Map<number, string>(); // fd -> path
const log: string[] = [];
let readIssued = 0, shortReads = 0;

/** Total size of an opened file in our mounted FS, or -1 if unknown. */
function fileSize(path: string): number {
  for (const [key, data] of k.fileData) {
    if (key.toLowerCase() === path.toLowerCase()) return data.length;
  }
  return -1;
}

const orig = k.dispatch.bind(k);
(k as unknown as { dispatch: (c: number, r: typeof emu.cpu.regs, b: typeof bus) => void }).dispatch = (code, regs, b) => {
  const nid = k.getNidBySyscallForTest(code);
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0, a2 = regs.getGpr(6) >>> 0;
  if (nid === NID.open || nid === NID.openAsync) {
    let s = ""; for (let p = a0; s.length < 64; p++) { const c = bus.readU8(p); if (c === 0) break; s += String.fromCharCode(c); }
    orig(code, regs, b);
    opens.set(regs.getGpr(2) >>> 0, s);
    return;
  }
  if (nid === NID.read || nid === NID.readAsync) {
    readIssued++;
    orig(code, regs, b);
    const path = opens.get(a0) ?? `fd${a0.toString(16)}`;
    const total = fileSize(path);
    // sync read returns bytes in v0; async result is delivered later, so flag
    // by comparing requested size against the remaining file bytes instead.
    const isShort = total >= 0 && a2 > total; // requested more than the whole file
    if (isShort) shortReads++;
    if (log.length < 80) {
      log.push(`${nid === NID.read ? "Read " : "ReadA"} ${path} reqSize=0x${a2.toString(16)} fileSize=0x${total.toString(16)} buf=0x${a1.toString(16)}${isShort ? "  <<< SHORT (req>file)" : ""}`);
    }
    return;
  }
  orig(code, regs, b);
};

for (let f = 0; f < 30; f++) {
  emu.runFrame();
  if (emu.halted || emu.cpu.stepFaulted) break;
}

console.log(`RESULT halted=${emu.halted} faulted=${emu.cpu.stepFaulted} pc=0x${emu.cpu.regs.pc.toString(16)}`);
console.log(`RESULT reads issued=${readIssued} shortReads=${shortReads}`);
console.log("RESULT opens:");
for (const [fd, p] of opens) console.log(`  fd=0x${fd.toString(16)} ${p}`);
console.log("RESULT read trace (first 80):");
for (const l of log) console.log("  " + l);
