/**
 * Experiment: defer sceIoReadAsync data write + result like PPSSPP
 * (IoAsyncFinish on helper thread + __IoSchedAsync us delay), instead of our
 * synchronous copy. PollAsync/GetAsyncStat return 1 while pending.
 * If the Bad PC=0x0 fault at frame 11 disappears, root cause is confirmed.
 * Usage: npx tsx tools/debug-gow2-defer.ts [frames=300]
 */
import { loadGame } from "../test/helpers/boot-game.js";
import { IO } from "../src/kernel/nids.js";
import type { AllegrexRegisters } from "../src/cpu/registers.js";

async function main() {
  const frames = parseInt(process.argv[2] ?? "300", 10);
  const emu = await loadGame("test/fixtures/gow-sparta.iso");
  const kernel = emu.hle;
  const handlers = (kernel as unknown as { handlers: Map<number, (regs: unknown, bus: unknown) => void> }).handlers;

  const origRead = handlers.get(IO.sceIoReadAsync)!;
  const origPoll = handlers.get(IO.sceIoPollAsync)!;
  const origStat = handlers.get(IO.sceIoGetAsyncStat)!;
  const origWait = handlers.get(IO.sceIoWaitAsync)!;
  const origWaitCB = handlers.get(IO.sceIoWaitAsyncCB)!;

  const pending = new Map<number, { buf: number; size: number }>();

  const fakeRegs = (fd: number, buf: number, size: number) => {
    const g = new Uint32Array(32);
    g[4] = fd; g[5] = buf; g[6] = size;
    return {
      getGpr: (r: number) => g[r]!,
      setGpr: (r: number, v: number) => { g[r] = v >>> 0; },
      gpr: g,
    } as unknown as AllegrexRegisters;
  };

  const ct = kernel.coreTiming!;
  const evId = ct.registerEventType("debugAsyncIo", (_cyclesLate: number, userdata: number) => {
    const op = pending.get(userdata);
    if (!op) return;
    pending.delete(userdata);
    // Run the original synchronous handler now: copies data, sets
    // hasAsyncResult, fires the IO callback.
    origRead(fakeRegs(userdata, op.buf, op.size), emu.bus);
    console.log(`[defer] completed fd=${userdata} buf=0x${op.buf.toString(16)} size=0x${op.size.toString(16)}`);
  });

  handlers.set(IO.sceIoReadAsync, (regs: AllegrexRegisters) => {
    const fd = regs.getGpr(4), buf = regs.getGpr(5), size = regs.getGpr(6);
    if (pending.has(fd)) { regs.setGpr(2, 0x80020329); return; } // ASYNC_BUSY
    pending.set(fd, { buf, size });
    const us = Math.max(100, Math.floor(size / 100)); // PPSSPP __IoRead us
    ct.scheduleEvent(ct.usToCycles(us), evId, fd);
    console.log(`[defer] queued fd=${fd} buf=0x${buf.toString(16)} size=0x${size.toString(16)} us=${us}`);
    regs.setGpr(2, 0);
  });

  const pendingAware = (orig: (regs: unknown, bus: unknown) => void, blocking: boolean) =>
    (regs: AllegrexRegisters, bus: unknown) => {
      const fd = regs.getGpr(4);
      const resPtr = regs.getGpr(5);
      if (pending.has(fd)) {
        if (blocking) {
          // approximate: complete now, then run the original wait
          const op = pending.get(fd)!;
          pending.delete(fd);
          origRead(fakeRegs(fd, op.buf, op.size), emu.bus);
          orig(regs, bus);
          console.log(`[wait-sync] fd=${fd} result=0x${(emu.bus.readU32(resPtr) >>> 0).toString(16)}`);
        } else {
          regs.setGpr(2, 1); // PPSSPP: "not ready"
        }
        return;
      }
      orig(regs, bus);
      const v0 = emu.cpu.regs.gpr[2]! >>> 0;
      if (v0 === 0 && resPtr) {
        console.log(`[poll-done] fd=${fd} result=0x${(emu.bus.readU32(resPtr) >>> 0).toString(16)}`);
      }
    };

  // Log opens to identify fds
  for (const nidName of ["sceIoOpen", "sceIoOpenAsync"] as const) {
    const nid = IO[nidName];
    const orig = handlers.get(nid)!;
    const wrapper = (regs: AllegrexRegisters, bus: unknown) => {
      const pathPtr = regs.getGpr(4);
      let path = "";
      for (let i = 0; i < 128; i++) {
        const ch = emu.bus.readU8(pathPtr + i);
        if (ch === 0) break;
        path += String.fromCharCode(ch);
      }
      orig(regs, bus);
      console.log(`[open] ${nidName}("${path}") → fd=${emu.cpu.regs.gpr[2]! | 0}`);
    };
    handlers.set(nid, wrapper as never);
  }

  handlers.set(IO.sceIoPollAsync, pendingAware(origPoll, false));
  handlers.set(IO.sceIoGetAsyncStat, pendingAware(origStat, false));
  handlers.set(IO.sceIoWaitAsync, pendingAware(origWait, true));
  handlers.set(IO.sceIoWaitAsyncCB, pendingAware(origWaitCB, true));

  // Handlers were also copied under syscall codes at remap time — override
  // those entries too so dispatch actually hits our wrappers.
  const syscallToNid = (kernel as unknown as { syscallToNid: Map<number, number> }).syscallToNid;
  for (const [code, nid] of syscallToNid) {
    for (const target of [IO.sceIoReadAsync, IO.sceIoPollAsync, IO.sceIoGetAsyncStat, IO.sceIoWaitAsync, IO.sceIoWaitAsyncCB, IO.sceIoOpen, IO.sceIoOpenAsync] as number[]) {
      if (nid === target) handlers.set(code, handlers.get(target)!);
    }
  }

  // Watch the second fault's list: s1=0x8ce6fb0, count at +0x6c, array at +0x58.
  const LIST2 = 0x8ce6fb0;

  let f = 0;
  for (f = 0; f < frames; f++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
    await Promise.resolve();
  }
  console.log(`\nran ${f} frames, halted=${emu.halted} faulted=${emu.cpu.stepFaulted} pc=0x${emu.cpu.regs.pc.toString(16)}`);
  console.log(`ge lists=${kernel.geListCount} prims=${kernel.gePrimCount} clears=${kernel.geClearCount}`);

  const fbAddr = kernel.framebufAddr !== 0 ? kernel.framebufAddr : kernel.geFbAddr;
  let nonBlack = 0;
  if (fbAddr >= 0x04000000) {
    const vram = emu.bus.vramBuffer;
    const off = fbAddr - 0x04000000;
    const stride = kernel.framebufWidth || 512;
    const end = Math.min(off + stride * 272 * 4, vram.length);
    for (let i = off; i + 3 < end; i += 4) if (vram[i]! | vram[i + 1]! | vram[i + 2]!) nonBlack++;
  }
  console.log(`fb non-black pixels: ${nonBlack}`);

  if (emu.cpu.stepFaulted) {
    const count = emu.bus.readU32(LIST2 + 0x6c);
    const arr = emu.bus.readU32(LIST2 + 0x58) >>> 0;
    console.log(`\nlist2 @0x${LIST2.toString(16)}: count=${count} arr=0x${arr.toString(16)}`);
    for (let i = 0; i < Math.min(count, 24); i++) {
      const el = emu.bus.readU32(arr + i * 4) >>> 0;
      console.log(`  arr[${i}] @0x${(arr + i * 4).toString(16)} = 0x${el.toString(16)}${el >= 0x08800000 && el < 0x0c000000 ? "" : "  ← BAD"}`);
    }
  }
}
main().catch(console.error);
