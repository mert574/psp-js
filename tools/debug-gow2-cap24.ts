/**
 * Test hypothesis: GoW GoS faults because we expose a 56MB user pool
 * (USER_MEM_END=0x0C000000) while PPSSPP gives 24MB (end 0x0A000000,
 * no MEMSIZE=1 in PARAM.SFO). Reserve [0x0A000000, 0x0C000000) right
 * after load so MaxFreeMemSize/FPL see PPSSPP-sized memory, then boot.
 * Usage: npx tsx tools/debug-gow2-cap24.ts [frames=120]
 */
import { readFileSync } from "node:fs";
import { extractEboot, mountIso } from "../test/helpers/boot-game.js";
import { isPbp, parsePbp } from "../src/loader/pbp.js";
import { pspDecryptPRX } from "../src/loader/prx-decrypter.js";
import { PSPEmulator } from "../src/emulator.js";

async function main() {
  const frames = parseInt(process.argv[2] ?? "120", 10);
  const isoBuffer = readFileSync("test/fixtures/gow-sparta.iso").buffer as ArrayBuffer;
  let data = extractEboot(isoBuffer);
  if (isPbp(data)) data = parsePbp(data).dataPsp as Uint8Array<ArrayBuffer>;
  const view = new DataView(data.buffer, data.byteOffset, 4);
  if (view.getUint32(0, false) === 0x7e505350) {
    data = (await pspDecryptPRX(data))! as Uint8Array<ArrayBuffer>;
  }
  const emu = new PSPEmulator();
  mountIso(isoBuffer, emu.hle.fileData);

  // Simulate PPSSPP's 32MB-RAM layout: cap the pool right after userMemory
  // init, before any thread stacks are allocated from the top.
  const origSetHeapBase = emu.hle.setHeapBase.bind(emu.hle);
  emu.hle.setHeapBase = (loadedEnd: number) => {
    origSetHeapBase(loadedEnd);
    const addr = emu.hle.userMemory.allocAt(0x0a000000, 0x02000000, "cap-to-24mb");
    console.log(`cap block at 0x${(addr >>> 0).toString(16)}`);
  };
  await emu.loadElfBinary(data);

  let f = 0;
  for (f = 0; f < frames; f++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
    await Promise.resolve();
  }
  console.log(`ran ${f} frames, halted=${emu.halted} faulted=${emu.cpu.stepFaulted} pc=0x${emu.cpu.regs.pc.toString(16)}`);
  console.log(`ge lists=${emu.hle.geListCount} prims=${emu.hle.gePrimCount} clears=${emu.hle.geClearCount}`);

  // framebuffer pixel check
  const fbAddr = emu.hle.framebufAddr !== 0 ? emu.hle.framebufAddr : emu.hle.geFbAddr;
  let nonBlack = 0;
  if (fbAddr >= 0x04000000) {
    const vram = emu.bus.vramBuffer;
    const off = fbAddr - 0x04000000;
    const stride = emu.hle.framebufWidth || 512;
    const end = Math.min(off + stride * 272 * 4, vram.length);
    for (let i = off; i + 3 < end; i += 4) if (vram[i]! | vram[i + 1]! | vram[i + 2]!) nonBlack++;
  }
  console.log(`fb non-black pixels: ${nonBlack}`);
}
main().catch(console.error);
