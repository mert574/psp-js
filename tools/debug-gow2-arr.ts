/**
 * Find what zeroes arr[0] @ 0x99fa550 (the registered-object slot whose null
 * pointer causes the Bad PC=0x0 fault). Hooks all bus write widths and
 * writeBytes, plus polls the raw RAM byte each step boundary via syscall hook.
 * Usage: npx tsx tools/debug-gow2-arr.ts
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { NID_NAMES } from "../src/kernel/nids.js";

const TARGET = 0x99fa550;

async function main() {
  const emu = await loadGame("test/fixtures/gow-sparta.iso");
  const bus = emu.bus;
  const log: string[] = [];
  const where = () =>
    `pc=0x${emu.cpu.regs.pc.toString(16)} ra=0x${(emu.cpu.regs.gpr[31]! >>> 0).toString(16)} tid=${emu.hle.currentThreadId}`;

  const hit = (a: number, len: number) => a < TARGET + 4 && a + len > TARGET;

  const ow32 = bus.writeU32.bind(bus);
  bus.writeU32 = (addr, value) => {
    if (hit(addr >>> 0, 4)) log.push(`[w32] 0x${(addr >>> 0).toString(16)} = 0x${(value >>> 0).toString(16)} ${where()}`);
    ow32(addr, value);
  };
  const ow16 = bus.writeU16.bind(bus);
  bus.writeU16 = (addr, value) => {
    if (hit(addr >>> 0, 2)) log.push(`[w16] 0x${(addr >>> 0).toString(16)} = 0x${(value & 0xffff).toString(16)} ${where()}`);
    ow16(addr, value);
  };
  let dumped = false;
  const ow8 = bus.writeU8.bind(bus);
  bus.writeU8 = (addr, value) => {
    if (hit(addr >>> 0, 1)) {
      log.push(`[w8] 0x${(addr >>> 0).toString(16)} = 0x${(value & 0xff).toString(16)} ${where()}`);
      if (!dumped) {
        dumped = true;
        const names = ["zero","at","v0","v1","a0","a1","a2","a3","t0","t1","t2","t3","t4","t5","t6","t7","s0","s1","s2","s3","s4","s5","s6","s7","t8","t9","k0","k1","gp","sp","fp","ra"];
        const regs: string[] = [];
        for (let r = 0; r < 32; r++) regs.push(`${names[r]}=0x${(emu.cpu.regs.gpr[r]! >>> 0).toString(16)}`);
        log.push(`[regs] ${regs.join(" ")}`);
        const c = emu.cpu as unknown as { traceBuffer: Uint32Array; traceIdx: number };
        const trace: string[] = [];
        for (let i = Math.max(0, c.traceIdx - 128); i < c.traceIdx; i++) trace.push("0x" + c.traceBuffer[i & 127]!.toString(16));
        log.push(`[trace] ${trace.join(" ")}`);
        // dump some stack
        const sp = emu.cpu.regs.gpr[29]! >>> 0;
        const st: string[] = [];
        for (let o = 0; o < 0x60; o += 4) st.push(`[sp+${o.toString(16)}]=0x${(bus.readU32(sp + o) >>> 0).toString(16)}`);
        log.push(`[stack] ${st.join(" ")}`);
      }
    }
    ow8(addr, value);
  };
  const owb = bus.writeBytes.bind(bus);
  bus.writeBytes = (addr, data) => {
    if (hit(addr >>> 0, data.length)) log.push(`[wbytes] 0x${(addr >>> 0).toString(16)} len=${data.length} ${where()}`);
    owb(addr, data);
  };

  // Watch the raw RAM in case something writes to the typed array directly:
  // check the value at each syscall dispatch.
  const ramOff = TARGET - 0x08000000;
  const ramView = new DataView(bus.ramBuffer.buffer, bus.ramBuffer.byteOffset);
  let last = -1;
  const origDispatch = emu.hle.dispatch.bind(emu.hle);
  emu.hle.dispatch = (code: number, regs) => {
    const cur = ramView.getUint32(ramOff, true);
    if (cur !== last) {
      const nid = emu.hle.getNidBySyscallForTest(code);
      const name = nid != null ? (NID_NAMES.get(nid) ?? `0x${nid.toString(16)}`) : "?";
      log.push(`[poll@syscall ${name}] arr[0] now 0x${cur.toString(16)} ${where()}`);
      last = cur;
    }
    origDispatch(code, regs);
  };

  for (let f = 0; f < 20; f++) {
    emu.runFrame();
    const cur = ramView.getUint32(ramOff, true);
    if (cur !== last) {
      log.push(`[poll@frame ${f}] arr[0] now 0x${cur.toString(16)}`);
      last = cur;
    }
    if (emu.halted || emu.cpu.stepFaulted) break;
    await Promise.resolve();
  }

  console.log(`faulted=${emu.cpu.stepFaulted} pc=0x${emu.cpu.regs.pc.toString(16)}`);
  console.log(`arr[0] final = 0x${ramView.getUint32(ramOff, true).toString(16)}`);
  console.log(`\nlog (${log.length} entries):`);
  for (const l of log) console.log("  " + l);
}
main().catch(console.error);
