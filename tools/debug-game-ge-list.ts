/** Boot an ISO, dump GE display list commands for a chosen frame window.
 *  Usage: npx tsx tools/debug-game-ge-list.ts <iso> [frames=300] [dumpFrom=295]
 *  Dumps every list enqueued from frame `dumpFrom` on, decoded, plus PRIM details. */
import { loadGame } from "../test/helpers/boot-game.js";
import { GE } from "../src/kernel/nids.js";

const isoPath = process.argv[2] ?? "public/cladun-rpg.iso";
const maxFrames = parseInt(process.argv[3] ?? "300", 10);
const dumpFrom = parseInt(process.argv[4] ?? String(maxFrames - 5), 10);

const CMD: Record<number, string> = {
  0x00: "NOP", 0x01: "VADDR", 0x02: "IADDR", 0x04: "PRIM", 0x05: "BEZIER", 0x06: "SPLINE",
  0x08: "JUMP", 0x09: "BJUMP", 0x0a: "CALL", 0x0b: "RET", 0x0c: "END", 0x0e: "SIGNAL", 0x0f: "FINISH",
  0x10: "BASE", 0x12: "VTYPE", 0x13: "OFFSETADDR", 0x14: "ORIGIN", 0x15: "REGION1", 0x16: "REGION2",
  0x17: "LIGHTING", 0x1c: "CLIP", 0x1d: "CULLFACE", 0x1e: "TEXTURE", 0x1f: "FOG", 0x20: "DITHER",
  0x21: "BLEND_EN", 0x22: "ALPHATEST_EN", 0x23: "ZTEST_EN", 0x24: "STENCIL_EN", 0x25: "ANTIALIAS",
  0x26: "PATCHCULL", 0x27: "COLORTEST_EN", 0x28: "LOGICOP_EN",
  0x36: "WORLDMTX_N", 0x37: "WORLDMTX_D", 0x3a: "VIEWMTX_N", 0x3b: "VIEWMTX_D",
  0x3e: "PROJMTX_N", 0x3f: "PROJMTX_D", 0x42: "VIEWPORT_X", 0x43: "VIEWPORT_Y", 0x44: "VIEWPORT_Z",
  0x45: "VIEWPORT_CX", 0x46: "VIEWPORT_CY", 0x47: "VIEWPORT_CZ", 0x4c: "OFFSET_X", 0x4d: "OFFSET_Y",
  0x9c: "FBPTR", 0x9d: "FBWIDTH", 0x9e: "ZBPTR", 0x9f: "ZBWIDTH",
  0xa0: "TBPTR0", 0xa8: "TBWIDTH0", 0xb0: "CLUTPTR", 0xb1: "CLUTPTRUPPER",
  0xb8: "TSIZE0", 0xc0: "TMODE", 0xc1: "TPF", 0xc2: "CLUTLOAD", 0xc3: "CLUTFMT",
  0xc4: "TFILTER", 0xc5: "TWRAP", 0xc6: "TLEVEL", 0xc7: "TFUNC", 0xc8: "TENVCOLOR",
  0xc9: "TFLUSH", 0xca: "TSYNC", 0xcb: "FOG1", 0xcc: "FOG2", 0xcd: "TEXLODSLOPE",
  0xce: "FRAMEBUFPIXFMT", 0xd0: "CLEARMODE", 0xd2: "SCISSOR1", 0xd3: "SCISSOR2",
  0xd4: "MINZ", 0xd5: "MAXZ", 0xd6: "COLORTEST", 0xd7: "COLORREF", 0xd8: "COLORTESTMASK",
  0xdb: "ALPHATEST", 0xdc: "STENCILTEST", 0xdd: "STENCILOP", 0xde: "ZTEST",
  0xdf: "BLEND", 0xe0: "BLENDFIXA", 0xe1: "BLENDFIXB", 0xe2: "DITH0",
  0xe6: "LOGICOP", 0xe7: "ZMSK", 0xe8: "PMSKC", 0xe9: "PMSKA",
  0xea: "TRANSFERSRC", 0xeb: "TRANSFERSRCW", 0xec: "TRANSFERDST", 0xed: "TRANSFERDSTW",
  0xee: "TRANSFERSRCPOS", 0xef: "TRANSFERDSTPOS", 0xf0: "TRANSFERSIZE", 0xf1: "TRANSFERSTART",
};
const PRIM_TYPES = ["POINTS", "LINES", "LINE_STRIP", "TRIANGLES", "TRI_STRIP", "TRI_FAN", "SPRITES"];

const emu = await loadGame(isoPath);

let frame = 0;
const orig = emu.hle.dispatch.bind(emu.hle);
const enqueued: { frame: number; addr: number; stall: number }[] = [];
emu.hle.dispatch = (code, regs) => {
  const nid = emu.hle.getNidBySyscallForTest(code);
  if ((nid === GE.sceGeListEnQueue || nid === GE.sceGeListEnQueueHead) && frame >= dumpFrom) {
    enqueued.push({ frame, addr: regs.getGpr(4) >>> 0, stall: regs.getGpr(5) >>> 0 });
  }
  orig(code, regs);
};

for (let f = 0; f < maxFrames; f++) {
  frame = f;
  emu.runFrame();
  await Promise.resolve();
}

function dumpList(addr: number, stall: number): void {
  console.log(`\n── list @0x${addr.toString(16)} stall=0x${stall.toString(16)} ──`);
  let pc = addr;
  let base = 0;
  const callStack: number[] = [];
  let lastNoteworthy = "";
  let skipped = 0;
  for (let i = 0; i < 4000; i++) {
    const word = emu.bus.readU32(pc) >>> 0;
    const cmd = word >>> 24;
    const param = word & 0xffffff;
    const name = CMD[cmd] ?? `CMD_${cmd.toString(16)}`;
    let line = `  0x${pc.toString(16)}: ${name.padEnd(14)} 0x${param.toString(16).padStart(6, "0")}`;
    if (cmd === 0x04) {
      const count = param & 0xffff;
      const type = (param >> 16) & 7;
      line += `  ← ${PRIM_TYPES[type]} count=${count}`;
    }
    // Only print state-changing/interesting commands; skip matrix data floods
    const boring = (cmd >= 0x36 && cmd <= 0x41) || cmd === 0x00;
    if (!boring || i < 5) {
      if (skipped) { console.log(`  ... (${skipped} matrix/nop words)`); skipped = 0; }
      console.log(line);
    } else skipped++;
    lastNoteworthy = name;

    if (cmd === 0x10) { base = (param & 0xff0000) << 8; pc += 4; continue; }
    if (cmd === 0x08) { pc = (base | (param & 0xfffffc)) >>> 0; continue; }   // JUMP
    if (cmd === 0x0a) { callStack.push(pc + 4); pc = (base | (param & 0xfffffc)) >>> 0; continue; } // CALL
    if (cmd === 0x0b) { pc = callStack.pop() ?? pc + 4; continue; }            // RET
    if (cmd === 0x0c) { console.log("  END — stop"); return; }                  // END
    pc += 4;
    if (stall && pc === stall) { console.log("  (hit stall)"); return; }
  }
  console.log("  (4000-word cap reached)");
}

console.log(`Enqueued lists from frame ${dumpFrom}: ${enqueued.length}`);
for (const e of enqueued.slice(0, 3)) dumpList(e.addr, e.stall);

// Framebuffer + display state
const hk = emu.hle as any;
console.log(`\ndisplay fb addr=0x${(hk.displayFbAddr ?? 0).toString(16)} stride=${hk.displayFbStride} fmt=${hk.displayFbFormat}`);
