/**
 * Trace writes to the list object that holds the null fn-pointer element.
 * Object s1=0x8d72370: count at +0x68, array ptr at +0x54.
 * Usage: npx tsx tools/debug-gow2-list.ts
 */
import { loadGame } from "../test/helpers/boot-game.js";

const S1 = 0x8d72370;
const COUNT_ADDR = S1 + 0x68;
const ARR_PTR_ADDR = S1 + 0x54;

async function main() {
  const emu = await loadGame("test/fixtures/gow-sparta.iso");
  const bus = emu.bus;

  let arrBase = 0;
  const origW32 = bus.writeU32.bind(bus);
  const log: string[] = [];
  bus.writeU32 = (addr: number, value: number) => {
    const a = addr >>> 0;
    if (a === COUNT_ADDR || a === ARR_PTR_ADDR) {
      log.push(
        `[w32] addr=0x${a.toString(16)} val=0x${(value >>> 0).toString(16)} pc=0x${emu.cpu.regs.pc.toString(16)} ra=0x${(emu.cpu.regs.gpr[31]! >>> 0).toString(16)} tid=${emu.hle.currentThreadId}`,
      );
      if (a === ARR_PTR_ADDR) arrBase = value >>> 0;
    }
    if (arrBase !== 0 && a >= arrBase && a < arrBase + 0x40) {
      log.push(
        `[w32-arr] arr[${(a - arrBase) / 4}] = 0x${(value >>> 0).toString(16)} pc=0x${emu.cpu.regs.pc.toString(16)} ra=0x${(emu.cpu.regs.gpr[31]! >>> 0).toString(16)} tid=${emu.hle.currentThreadId}`,
      );
    }
    origW32(addr, value);
  };

  for (let f = 0; f < 20; f++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
    await Promise.resolve();
  }

  console.log(`faulted=${emu.cpu.stepFaulted} pc=0x${emu.cpu.regs.pc.toString(16)}`);
  console.log(`count @0x${COUNT_ADDR.toString(16)} = ${bus.readU32(COUNT_ADDR)}`);
  const arr = bus.readU32(ARR_PTR_ADDR) >>> 0;
  console.log(`arrPtr @0x${ARR_PTR_ADDR.toString(16)} = 0x${arr.toString(16)}`);
  if (arr) {
    for (let i = 0; i < 8; i++) {
      console.log(`  arr[${i}] @0x${(arr + i * 4).toString(16)} = 0x${(bus.readU32(arr + i * 4) >>> 0).toString(16)}`);
    }
  }
  console.log(`\nwrite log (${log.length} entries, last 60):`);
  for (const l of log.slice(-60)) console.log("  " + l);
}
main().catch(console.error);
