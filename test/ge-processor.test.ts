import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { GEProcessor } from "../src/gpu/ge-processor.js";
import { GE_CMD } from "../src/gpu/ge-commands.js";

/**
 * Helper: build a GE command word (opcode in top 8 bits, param in bottom 24).
 */
function geCmd(opcode: number, param: number = 0): number {
  return ((opcode & 0xFF) << 24) | (param & 0x00FFFFFF);
}

/**
 * Write an array of u32 GE commands into memory at `addr`.
 */
function writeCommandList(bus: MemoryBus, addr: number, cmds: number[]): void {
  for (let i = 0; i < cmds.length; i++) {
    bus.writeU32(addr + i * 4, cmds[i]);
  }
}

/**
 * Write a through-mode vertex with s16 position + 8888 color at `addr`.
 * vtype for this: through(bit23) | color8888(7<<2) | pos_s16(2<<7) = 0x80011C
 * Layout: color(u32) + x(s16) + y(s16) + z(s16) + pad(s16)
 */
function writeVertex_color8888_pos16(
  bus: MemoryBus, addr: number,
  x: number, y: number, z: number, color: number,
): number {
  // color (8888) — 4 bytes aligned to 4
  bus.writeU32(addr, color);
  addr += 4;
  // position s16 — aligned to 2 (already aligned after 4)
  bus.writeU16(addr, x & 0xFFFF); addr += 2;
  bus.writeU16(addr, y & 0xFFFF); addr += 2;
  bus.writeU16(addr, z & 0xFFFF); addr += 2;
  addr += 2; // padding to keep alignment
  return addr; // next vertex address
}

// VRAM starts at 0x04000000
const VRAM_BASE = 0x04000000;
// Use a RAM address for the command list
const LIST_ADDR = 0x08800000;
// Use a RAM address for vertex data
const VERT_ADDR = 0x08900000;

describe("GEProcessor", () => {
  let bus: MemoryBus;
  let ge: GEProcessor;

  beforeEach(() => {
    bus = new MemoryBus();
    ge = new GEProcessor(bus);
  });

  describe("basic command list execution", () => {
    it("should process NOP + FINISH + END without crashing", () => {
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.NOP),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);
      // Should not throw
      ge.executeList(LIST_ADDR, 0);
    });

    it("should stop at stall address", () => {
      // Write NOP, NOP, CLEAR(enable+flag), FINISH, END
      // If stall is at cmd[1], only NOP at [0] executes
      const stallAddr = LIST_ADDR + 4; // stall after first command
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.NOP),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);
      // Should return without processing FINISH/END since stall is at offset 4
      ge.executeList(LIST_ADDR, stallAddr);
    });
  });

  describe("framebuffer clear", () => {
    it("should clear VRAM with doClear when CLEAR command has enable+flag bits", () => {
      // Set framebuffer to VRAM base, format ABGR8888
      // CLEAR with param bit0=enable, bit8=color flag → param = 0x101
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),        // low 24 bits
        geCmd(GE_CMD.FRAMEBUFWIDTH, (512 & 0x7FF) | ((VRAM_BASE >>> 8) & 0xFF0000)), // width + high bits
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),                                          // pixel format = ABGR8888
        geCmd(GE_CMD.CLEARCOLOR, 0x00FF00),                   // clear color = green (RGB)
        geCmd(GE_CMD.CLEARDEPTH, 0xFF),                       // clear alpha = 255
        geCmd(GE_CMD.CLEAR, 0x101),                              // enable clear + color flag
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      // Check a few pixels in VRAM — should be green (R=0, G=0xFF, B=0, A=0xFF)
      const vram = bus.vramBuffer;
      // Pixel at (0,0): offset 0 in VRAM
      expect(vram[0]).toBe(0x00); // R
      expect(vram[1]).toBe(0xFF); // G
      expect(vram[2]).toBe(0x00); // B
      expect(vram[3]).toBe(0xFF); // A

      // Pixel at (100, 50): offset = (50*512 + 100)*4
      const off = (50 * 512 + 100) * 4;
      expect(vram[off]).toBe(0x00);
      expect(vram[off + 1]).toBe(0xFF);
      expect(vram[off + 2]).toBe(0x00);
      expect(vram[off + 3]).toBe(0xFF);
    });

    it("should clear to red using CLEARCOLOR", () => {
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CLEARCOLOR, 0x0000FF), // clear color RGB = R=0xFF, G=0, B=0
        geCmd(GE_CMD.CLEARDEPTH, 0xFF),
        geCmd(GE_CMD.CLEAR, 0x101),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      const vram = bus.vramBuffer;
      expect(vram[0]).toBe(0xFF); // R
      expect(vram[1]).toBe(0x00); // G
      expect(vram[2]).toBe(0x00); // B
      expect(vram[3]).toBe(0xFF); // A
    });
  });

  describe("PRIM sprite rendering", () => {
    // vtype: through(1<<23) | color_8888(7<<2) | pos_s16(2<<7) = 0x80011C
    const VTYPE_THROUGH_COLOR8888_POS16 = (1 << 23) | (7 << 2) | (2 << 7);

    it("should draw a solid color sprite to VRAM", () => {
      // Write two vertices for a 10x10 sprite at (5,5)-(15,15) with white color
      const WHITE = 0xFFFFFFFF;
      let vaddr = VERT_ADDR;
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 5, 5, 0, WHITE);
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 15, 15, 0, WHITE);

      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),                                // format ABGR8888
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, VTYPE_THROUGH_COLOR8888_POS16),
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),             // type=SPRITES, count=2
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      const vram = bus.vramBuffer;

      // Pixel at (10, 10) should be white — inside the sprite
      const inside = (10 * 512 + 10) * 4;
      expect(vram[inside]).toBe(0xFF);     // R
      expect(vram[inside + 1]).toBe(0xFF); // G
      expect(vram[inside + 2]).toBe(0xFF); // B
      expect(vram[inside + 3]).toBe(0xFF); // A

      // Pixel at (0, 0) should still be zero — outside the sprite
      expect(vram[0]).toBe(0);
      expect(vram[1]).toBe(0);
    });

    it("should draw sprite with specific color", () => {
      // Red sprite: ABGR = 0xFF0000FF → R=0xFF, G=0, B=0, A=0xFF
      const RED_ABGR = 0xFF0000FF;
      let vaddr = VERT_ADDR;
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 0, 0, 0, RED_ABGR);
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 2, 2, 0, RED_ABGR);

      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, (1 << 23) | (7 << 2) | (2 << 7)),
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      const vram = bus.vramBuffer;
      // Pixel (0,0): sprite uses v1 color
      expect(vram[0]).toBe(0xFF); // R (low byte of ABGR)
      expect(vram[1]).toBe(0x00); // G
      expect(vram[2]).toBe(0x00); // B
      expect(vram[3]).toBe(0xFF); // A
    });

    it("should clear via PRIM in clear mode", () => {
      // Clear mode: set clear color, enable clear, then PRIM sprite fills rect
      const VTYPE = (1 << 23) | (2 << 7); // through + pos_s16, no color
      // Write vertices with pos_s16 only (no color): x(s16) y(s16) z(s16) = 6 bytes each
      let vaddr = VERT_ADDR;
      // Align to 2 (already aligned). v0 = (0,0,0)
      bus.writeU16(vaddr, 0); bus.writeU16(vaddr+2, 0); bus.writeU16(vaddr+4, 0);
      vaddr += 6;
      // v1 = (480,272,0)
      bus.writeU16(vaddr, 480); bus.writeU16(vaddr+2, 272); bus.writeU16(vaddr+4, 0);
      vaddr += 6;

      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CLEARCOLOR, 0x00FFFF),  // cyan
        geCmd(GE_CMD.CLEARDEPTH, 0xFF),
        geCmd(GE_CMD.CLEAR, 0x01),               // enable clear mode (no flag → PRIM does it)
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, VTYPE),
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),       // SPRITES, 2 verts
        geCmd(GE_CMD.CLEAR, 0x00),                // disable clear mode
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      const vram = bus.vramBuffer;
      // Check middle of screen
      const mid = (136 * 512 + 240) * 4;
      expect(vram[mid]).toBe(0xFF);     // R (cyan low byte)
      expect(vram[mid + 1]).toBe(0xFF); // G
      expect(vram[mid + 2]).toBe(0x00); // B
      expect(vram[mid + 3]).toBe(0xFF); // A
    });
  });

  describe("JUMP / CALL / RET", () => {
    it("should follow JUMP to a different address", () => {
      const JUMP_TARGET = LIST_ADDR + 0x1000;

      // Main list: set BASE, clear color green, then JUMP to target
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.BASE, (LIST_ADDR >>> 8) & 0xFFFFFF), // BASE = high bits
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CLEARCOLOR, 0x00FF00),
        geCmd(GE_CMD.CLEARDEPTH, 0xFF),
        geCmd(GE_CMD.JUMP, JUMP_TARGET & 0xFFFFFF), // jump
      ]);

      // At jump target: do CLEAR + FINISH + END
      writeCommandList(bus, JUMP_TARGET, [
        geCmd(GE_CMD.CLEAR, 0x101),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      // If JUMP worked, VRAM should be green
      const vram = bus.vramBuffer;
      expect(vram[1]).toBe(0xFF); // G
    });

    it("should handle CALL and RET", () => {
      const CALL_TARGET = LIST_ADDR + 0x2000;

      // Main list: setup fb, CALL subroutine, then FINISH+END
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.BASE, (LIST_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CALL, CALL_TARGET & 0xFFFFFF),
        // After RET, execution continues here:
        geCmd(GE_CMD.CLEAR, 0x101),   // clear with color set by subroutine
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      // Subroutine: set clear color blue, then RET
      writeCommandList(bus, CALL_TARGET, [
        geCmd(GE_CMD.CLEARCOLOR, 0xFF0000),  // blue (B=0xFF in bits 16-23)
        geCmd(GE_CMD.CLEARDEPTH, 0xFF),
        geCmd(GE_CMD.RET),
      ]);

      ge.executeList(LIST_ADDR, 0);

      // VRAM should be blue (R=0, G=0, B=0xFF, A=0xFF)
      const vram = bus.vramBuffer;
      expect(vram[0]).toBe(0x00); // R
      expect(vram[1]).toBe(0x00); // G
      expect(vram[2]).toBe(0xFF); // B
      expect(vram[3]).toBe(0xFF); // A
    });
  });

  describe("block transfer", () => {
    it("should copy pixels between VRAM regions", () => {
      // First, write some data at VRAM base manually
      const vram = bus.vramBuffer;
      for (let x = 0; x < 4; x++) {
        const i = x * 4;
        vram[i] = 0xAA;
        vram[i + 1] = 0xBB;
        vram[i + 2] = 0xCC;
        vram[i + 3] = 0xDD;
      }

      // Block transfer: copy 4x1 pixels from (0,0) to (100,0) within VRAM
      const srcAddr = VRAM_BASE;
      const dstAddr = VRAM_BASE;
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.TRANSFERSRC, srcAddr & 0xFFFFFF),
        geCmd(GE_CMD.TRANSFERSRCW, (512 & 0x7FF) | ((srcAddr >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.TRANSFERDST, dstAddr & 0xFFFFFF),
        geCmd(GE_CMD.TRANSFERDSTW, (512 & 0x7FF) | ((dstAddr >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.TRANSFERSRCPOS, 0 | (0 << 10)),      // srcX=0, srcY=0
        geCmd(GE_CMD.TRANSFERDSTPOS, 100 | (0 << 10)),     // dstX=100, dstY=0
        geCmd(GE_CMD.TRANSFERSIZE, (4 - 1) | ((1 - 1) << 10)), // width=4, height=1
        geCmd(GE_CMD.TRANSFERSTART),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      // Check destination at pixel (100,0)
      const dstOff = 100 * 4;
      expect(vram[dstOff]).toBe(0xAA);
      expect(vram[dstOff + 1]).toBe(0xBB);
      expect(vram[dstOff + 2]).toBe(0xCC);
      expect(vram[dstOff + 3]).toBe(0xDD);
    });
  });

  describe("framebuffer address calculation", () => {
    it("should handle fbPtr=0 as VRAM offset 0 for clear", () => {
      // When fbPtr is set to 0x04000000 (VRAM base), offset should be 0
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, 0x000000),  // low 24 bits of 0x04000000
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | (0x04 << 16)), // high byte = 0x04
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CLEARCOLOR, 0x123456),
        geCmd(GE_CMD.CLEARDEPTH, 0xFF),
        geCmd(GE_CMD.CLEAR, 0x101),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      const vram = bus.vramBuffer;
      expect(vram[0]).toBe(0x56); // R
      expect(vram[1]).toBe(0x34); // G
      expect(vram[2]).toBe(0x12); // B
      expect(vram[3]).toBe(0xFF); // A
    });
  });
});
