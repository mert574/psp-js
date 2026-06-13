/**
 * GoW streaming divergence: trace the UMD-readiness dance + every getstat/open/
 * devctl with the calling thread id, in order, to find where the DiscSpinnerThread
 * decides to raw-read DATA/ENGLISH/GAME.BIN (PPSSPP) vs not (ours). Flags any
 * reference to GAME.BIN. Recovers past the frame-15 Bad-PC fault.
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const emu = await loadGame("test/fixtures/gow-sparta.iso");
const cpu = emu.cpu;
const kernel = emu.hle as any;
const bus = emu.bus;

// recover past the Bad PC=0 fault so we can watch the whole stream setup
const origStep = cpu.step.bind(cpu);
cpu.step = () => { if ((cpu.regs.pc >>> 0) === 0) cpu.regs.pc = cpu.regs.gpr[31]! >>> 0; return origStep(); };

const WATCH = new Set([
  "sceUmdCheckMedium", "sceUmdActivate", "sceUmdDeactivate", "sceUmdGetDriveStat",
  "sceUmdWaitDriveStat", "sceUmdWaitDriveStatWithTimer", "sceUmdWaitDriveStatCB",
  "sceUmdRegisterUMDCallBack", "sceUmdGetDiscInfo",
  "sceIoGetstat", "sceIoOpen", "sceIoOpenAsync", "sceIoDevctl", "sceIoIoctl",
  "sceIoDopen", "sceIoDread",
]);

const lines: string[] = [];
const dreadByFd = new Map<number, number>();
const origDispatch = kernel.dispatch.bind(kernel);
kernel.dispatch = (code: number, regs: typeof cpu.regs) => {
  const nid = kernel.getNidBySyscallForTest(code);
  const name = nid != null ? NID_NAMES.get(nid) : undefined;
  const a0 = regs.getGpr(4) >>> 0, a1 = regs.getGpr(5) >>> 0, a2 = regs.getGpr(6) >>> 0, a3 = regs.getGpr(7) >>> 0;
  const tid = kernel.currentThreadId;
  let path = "";
  if (name && (name.startsWith("sceIoGetstat") || name.startsWith("sceIoOpen") || name === "sceIoDopen")) {
    try { path = kernel.readCString(bus, a0); } catch { /* ignore */ }
  }
  origDispatch(code, regs);
  const v0 = regs.getGpr(2) >>> 0;
  if (name === "sceIoDread") { dreadByFd.set(a0, (dreadByFd.get(a0) ?? 0) + 1); return; }
  if (name && WATCH.has(name) && lines.length < 200) {
    let extra = "";
    if (name === "sceIoGetstat" && a1 !== 0) {
      // SceIoStat.st_private[0] at offset 0x40 holds the start sector PPSSPP writes
      extra = ` sector=0x${(bus.readU32(a1 + 0x40) >>> 0).toString(16)}`;
    }
    const pstr = path ? ` "${path}"` : "";
    lines.push(`t${tid} ${name}(a0=0x${a0.toString(16)} a1=0x${a1.toString(16)} a2=0x${a2.toString(16)} a3=0x${a3.toString(16)})${pstr} → 0x${v0.toString(16)}${extra}`);
  }
};

for (let f = 0; f < 120 && !emu.halted; f++) emu.runFrame();

console.log(`gow halted=${emu.halted}`);
console.log(`GAME.BIN referenced: ${lines.some(l => /game\.bin/i.test(l))}`);
console.log(`sce_lbn opens: ${lines.filter(l => /sce_lbn/i.test(l)).length}`);
console.log("--- UMD + IO timeline ---");
for (const l of lines) console.log(l);
