/**
 * Ordered timeline of syscalls (args + v0) interleaved with writes to the
 * wiped object slot arr[0]=0x99fa550 and its object 0x99fa5e0, for the last
 * stretch before the Bad PC=0x0 fault.
 * Usage: npx tsx tools/debug-gow2-timeline.ts
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const ARR0 = 0x99fa550;
const OBJ = 0x99fa5e0;

async function main() {
  const emu = await loadGame("test/fixtures/gow-sparta.iso");
  const bus = emu.bus;
  const log: string[] = [];
  const push = (s: string) => {
    log.push(s);
    if (log.length > 400) log.shift();
  };

  const ow32 = bus.writeU32.bind(bus);
  bus.writeU32 = (addr, value) => {
    const a = addr >>> 0;
    if (a === ARR0 || (a >= OBJ && a < OBJ + 0x14)) {
      push(`  [w32] 0x${a.toString(16)} = 0x${(value >>> 0).toString(16)} pc=0x${emu.cpu.regs.pc.toString(16)}`);
    }
    ow32(addr, value);
  };
  const ow8 = bus.writeU8.bind(bus);
  let w8count = 0;
  bus.writeU8 = (addr, value) => {
    const a = addr >>> 0;
    if (a >= ARR0 && a < ARR0 + 4 && w8count++ < 2) {
      push(`  [w8-memset] 0x${a.toString(16)} = ${value & 0xff} pc=0x${emu.cpu.regs.pc.toString(16)}`);
    }
    ow8(addr, value);
  };

  const origDispatch = emu.hle.dispatch.bind(emu.hle);
  emu.hle.dispatch = (code: number, regs) => {
    const nid = emu.hle.getNidBySyscallForTest(code);
    const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid!.toString(16)}`) : `code${code}`;
    const g = (r: number) => (regs.gpr[r]! >>> 0).toString(16);
    const pre = `t${emu.hle.currentThreadId} ${name}(${g(4)},${g(5)},${g(6)},${g(7)}) ra=0x${g(31)}`;
    origDispatch(code, regs);
    const v0 = (emu.cpu.regs.gpr[2]! >>> 0).toString(16);
    push(`${pre} → ${v0}`);
  };

  for (let f = 0; f < 20; f++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
    await Promise.resolve();
  }

  console.log(`faulted=${emu.cpu.stepFaulted}`);
  console.log(log.join("\n"));
}
main().catch(console.error);
