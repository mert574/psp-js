import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { GEProcessor } from "../src/gpu/ge-processor.js";
import { GE_CMD } from "../src/gpu/ge-commands.js";
import { computeVertexLighting, type LightingState } from "../src/gpu/ge-lighting.js";
import { tessellateBezier, tessellateSpline } from "../src/gpu/ge-patches.js";

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
    bus = MemoryBus.create();
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
    it("should clear VRAM via PRIM sprite in clear mode (green)", () => {
      // PSP clear mode: CLEARMODE + PRIM type=6 sprite with vertex color.
      // Vertex color ABGR8888: green = R=0, G=0xFF, B=0, A=0xFF → 0xFF00FF00
      const GREEN_ABGR = 0xFF00FF00;
      let vaddr = VERT_ADDR;
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 0, 0, 0, GREEN_ABGR);
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 480, 272, 0, GREEN_ABGR);

      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, (512 & 0x7FF) | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CLEAR, 0x101),  // enable clear mode + color write
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, (1 << 23) | (7 << 2) | (2 << 7)), // through+color8888+pos16
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),
        geCmd(GE_CMD.CLEAR, 0x000),  // exit clear mode
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      // Pixel (0,0): green vertex → stored as [B=0, G=0xFF, R=0, A=0xFF]
      const vram = bus.vramBuffer;
      expect(vram[0]).toBe(0x00); // B of vertex (byte0)
      expect(vram[1]).toBe(0xFF); // G
      expect(vram[2]).toBe(0x00); // R of vertex (byte2)
      expect(vram[3]).toBe(0xFF); // A

      // Pixel at (100, 50) same
      const off = (50 * 512 + 100) * 4;
      expect(vram[off]).toBe(0x00);
      expect(vram[off + 1]).toBe(0xFF);
      expect(vram[off + 2]).toBe(0x00);
      expect(vram[off + 3]).toBe(0xFF);
    });

    it("should clear to red via PRIM sprite in clear mode", () => {
      // Red vertex: ABGR8888: R=0xFF, G=0, B=0, A=0xFF → 0xFF0000FF
      const RED_ABGR = 0xFF0000FF;
      let vaddr = VERT_ADDR;
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 0, 0, 0, RED_ABGR);
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 480, 272, 0, RED_ABGR);

      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CLEAR, 0x101),
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, (1 << 23) | (7 << 2) | (2 << 7)),
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),
        geCmd(GE_CMD.CLEAR, 0x000),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      // Hardware R/B order (977ac7f): byte0=R, byte2=B. Red → [R=0xFF, G=0, B=0, A=0xFF]
      const vram = bus.vramBuffer;
      expect(vram[0]).toBe(0xFF); // R of vertex
      expect(vram[1]).toBe(0x00); // G
      expect(vram[2]).toBe(0x00); // B of vertex
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

    it("should write no pixels when skipDraw is set (frame skip)", () => {
      const WHITE = 0xFFFFFFFF;
      let vaddr = VERT_ADDR;
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 5, 5, 0, WHITE);
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 15, 15, 0, WHITE);

      const cmds = [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, VTYPE_THROUGH_COLOR8888_POS16),
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ];
      writeCommandList(bus, LIST_ADDR, cmds);

      const inside = (10 * 512 + 10) * 4;

      // skipDraw on: the draw is suppressed, VRAM stays untouched.
      ge.skipDraw = true;
      ge.executeList(LIST_ADDR, 0);
      expect(bus.vramBuffer[inside]).toBe(0);
      expect(bus.vramBuffer[inside + 3]).toBe(0);

      // skipDraw off: the same list now writes the sprite.
      ge.skipDraw = false;
      ge.executeList(LIST_ADDR, 0);
      expect(bus.vramBuffer[inside]).toBe(0xFF);
      expect(bus.vramBuffer[inside + 3]).toBe(0xFF);
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
      // Pixel (0,0): sprite uses v1 color (RED_ABGR = R=0xFF, G=0, B=0, A=0xFF).
      // writePixel stores hardware R/B order (977ac7f): [R, G, B, A], no present swizzle.
      expect(vram[0]).toBe(0xFF); // R of vertex → byte0
      expect(vram[1]).toBe(0x00); // G
      expect(vram[2]).toBe(0x00); // B of vertex → byte2
      expect(vram[3]).toBe(0xFF); // A
    });

    it("should clear via PRIM in clear mode using vertex color", () => {
      // Per PPSSPP, clear mode uses vertex color (not a separate CLEARCOLOR command).
      // Cyan: ABGR8888: R=0xFF, G=0xFF, B=0, A=0xFF → 0xFF00FFFF
      const CYAN_ABGR = 0xFF00FFFF;
      let vaddr = VERT_ADDR;
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 0, 0, 0, CYAN_ABGR);
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 480, 272, 0, CYAN_ABGR);

      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CLEAR, 0x101),              // enable clear mode + color write
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, (1 << 23) | (7 << 2) | (2 << 7)), // through+color8888+pos16
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),       // SPRITES, 2 verts
        geCmd(GE_CMD.CLEAR, 0x00),                // disable clear mode
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      const vram = bus.vramBuffer;
      // Check middle of screen — cyan: R=0xFF, G=0xFF, B=0, A=0xFF
      // Hardware R/B order (977ac7f): stored as [R=0xFF, G=0xFF, B=0, A=0xFF]
      const mid = (136 * 512 + 240) * 4;
      expect(vram[mid]).toBe(0xFF);     // R of vertex → byte0
      expect(vram[mid + 1]).toBe(0xFF); // G
      expect(vram[mid + 2]).toBe(0x00); // B of vertex → byte2
      expect(vram[mid + 3]).toBe(0xFF); // A
    });
  });

  describe("JUMP / CALL / RET", () => {
    it("should follow JUMP to a different address", () => {
      const JUMP_TARGET = LIST_ADDR + 0x1000;

      // Green vertex: ABGR8888: R=0, G=0xFF, B=0, A=0xFF → 0xFF00FF00
      const GREEN_ABGR = 0xFF00FF00;
      let vaddr = VERT_ADDR;
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 0, 0, 0, GREEN_ABGR);
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 480, 272, 0, GREEN_ABGR);

      // Main list: set BASE and fb, then JUMP to target
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.BASE, (LIST_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.JUMP, JUMP_TARGET & 0xFFFFFF),
      ]);

      // At jump target: draw green sprite in clear mode + END
      writeCommandList(bus, JUMP_TARGET, [
        geCmd(GE_CMD.CLEAR, 0x101),
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, (1 << 23) | (7 << 2) | (2 << 7)),
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),
        geCmd(GE_CMD.CLEAR, 0x000),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      // Green: stored as [B=0, G=0xFF, R=0, A=0xFF]
      const vram = bus.vramBuffer;
      expect(vram[1]).toBe(0xFF); // G
    });

    it("should handle CALL and RET", () => {
      const CALL_TARGET = LIST_ADDR + 0x2000;

      // Blue vertex: ABGR8888: R=0, G=0, B=0xFF, A=0xFF → 0xFFFF0000
      const BLUE_ABGR = 0xFFFF0000;
      let vaddr = VERT_ADDR;
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 0, 0, 0, BLUE_ABGR);
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 480, 272, 0, BLUE_ABGR);

      // Main list: setup fb, CALL subroutine, draw blue after return
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.BASE, (LIST_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CALL, CALL_TARGET & 0xFFFFFF),
        // After RET: draw blue sprite
        geCmd(GE_CMD.CLEAR, 0x101),
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, (1 << 23) | (7 << 2) | (2 << 7)),
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),
        geCmd(GE_CMD.CLEAR, 0x000),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      // Subroutine: NOP and RET (drawing happens after return)
      writeCommandList(bus, CALL_TARGET, [
        geCmd(GE_CMD.NOP),
        geCmd(GE_CMD.RET),
      ]);

      ge.executeList(LIST_ADDR, 0);

      // Blue: hardware R/B order (977ac7f) stores [R=0, G=0, B=0xFF, A=0xFF]
      const vram = bus.vramBuffer;
      expect(vram[0]).toBe(0x00); // R of vertex → byte0
      expect(vram[1]).toBe(0x00); // G
      expect(vram[2]).toBe(0xFF); // B of vertex → byte2
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
        geCmd(GE_CMD.TRANSFERSTART, 1), // param bit 0 = 1 → 32-bit pixels
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

  describe("immediate mode vertices", () => {
    it("should draw a point via VSCX/VSCY/VCV/VAP commands", () => {
      // Set up framebuffer
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, VRAM_BASE & 0xFFFFFF),
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | ((VRAM_BASE >>> 8) & 0xFF0000)),
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.VTYPE, (1 << 23)), // through mode
        // Set immediate vertex: screen position (50, 50) with white color
        // Through mode: x = ((vscx & 0xFFFF) - 0x8000) / 16.0
        // So for x=50: vscx = 50*16 + 0x8000 = 800 + 32768 = 33568 = 0x8320
        geCmd(GE_CMD.VSCX, 50 * 16 + 0x8000),
        geCmd(GE_CMD.VSCY, 50 * 16 + 0x8000),
        geCmd(GE_CMD.VSCZ, 0),
        geCmd(GE_CMD.VCV, 0xFFFFFF),   // white RGB
        // VAP: prim=POINTS(0) in bits[10:8], alpha=0xFF in bits[7:0]
        geCmd(GE_CMD.VAP, (0 << 8) | 0xFF),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      const vram = bus.vramBuffer;
      const off = (50 * 512 + 50) * 4;
      expect(vram[off]).toBe(0xFF);     // R
      expect(vram[off + 1]).toBe(0xFF); // G
      expect(vram[off + 2]).toBe(0xFF); // B
      expect(vram[off + 3]).toBe(0xFF); // A
    });
  });

  describe("TEXLODSLOPE (0xD0) replaces old CLEARCOLOR", () => {
    it("should not crash when opcode 0xD0 is sent (TEXLODSLOPE, not CLEARCOLOR)", () => {
      writeCommandList(bus, LIST_ADDR, [
        geCmd(0xD0, 0x3F0000), // TEXLODSLOPE with float24 value
        geCmd(0xD1, 0),        // UNKNOWN_D1 — NOP
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);
      // Should not throw
      ge.executeList(LIST_ADDR, 0);
    });
  });

  describe("BJUMP (0x09)", () => {
    it("should be a NOP since bboxResult is always true", () => {
      // BJUMP jumps when bbox fails — since we always pass, it should be ignored
      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.BJUMP, 0xFFFFFF), // would jump to invalid addr if executed
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);
      // Should complete normally without jumping
      ge.executeList(LIST_ADDR, 0);
    });
  });

  describe("framebuffer address calculation", () => {
    it("should handle fbPtr=0x04000000 as VRAM offset 0 for PRIM drawing", () => {
      // When fbPtr is set to 0x04000000 (VRAM base), offset should be 0.
      // Use a blue vertex to verify the framebuffer address calculation.
      // Blue ABGR8888: R=0, G=0, B=0xFF, A=0xFF → 0xFFFF0000
      const BLUE_ABGR = 0xFFFF0000;
      let vaddr = VERT_ADDR;
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 0, 0, 0, BLUE_ABGR);
      vaddr = writeVertex_color8888_pos16(bus, vaddr, 2, 2, 0, BLUE_ABGR);

      writeCommandList(bus, LIST_ADDR, [
        geCmd(GE_CMD.FRAMEBUFPTR, 0x000000),          // low 24 bits of 0x04000000
        geCmd(GE_CMD.FRAMEBUFWIDTH, 512 | (0x04 << 16)), // high byte = 0x04
        geCmd(GE_CMD.FRAMEBUFPIXFMT, 3),
        geCmd(GE_CMD.CLEAR, 0x101),
        geCmd(GE_CMD.BASE, (VERT_ADDR >>> 8) & 0xFFFFFF),
        geCmd(GE_CMD.VTYPE, (1 << 23) | (7 << 2) | (2 << 7)),
        geCmd(GE_CMD.VADDR, VERT_ADDR & 0xFFFFFF),
        geCmd(GE_CMD.PRIM, (6 << 16) | 2),
        geCmd(GE_CMD.CLEAR, 0x000),
        geCmd(GE_CMD.FINISH),
        geCmd(GE_CMD.END),
      ]);

      ge.executeList(LIST_ADDR, 0);

      // Blue: hardware R/B order (977ac7f) stores [R=0, G=0, B=0xFF, A=0xFF] at VRAM offset 0
      const vram = bus.vramBuffer;
      expect(vram[0]).toBe(0x00); // R of vertex → byte0
      expect(vram[1]).toBe(0x00); // G
      expect(vram[2]).toBe(0xFF); // B of vertex → byte2
      expect(vram[3]).toBe(0xFF); // A
    });
  });
});

// ---------------------------------------------------------------------------
// Lighting unit tests (standalone, no GE processor needed)
// ---------------------------------------------------------------------------

function makeLightingState(overrides: Partial<LightingState> = {}): LightingState {
  return {
    lightingEnable: true,
    lightEnable: [false, false, false, false],
    lightType: [0, 0, 0, 0],
    lightPos: new Float32Array(12),
    lightDir: new Float32Array(12),
    lightAtt: new Float32Array(12),
    lightSpotExp: new Float32Array(4),
    lightSpotCutoff: new Float32Array(4),
    lightAmbientColor: new Uint32Array(4),
    lightDiffuseColor: new Uint32Array(4),
    lightSpecularColor: new Uint32Array(4),
    ambientColor: 0,
    ambientAlpha: 0,
    materialEmissive: 0,
    materialAmbient: 0xFFFFFF,
    materialAlpha: 0xFF,
    materialDiffuse: 0xFFFFFF,
    materialSpecular: 0xFFFFFF,
    materialSpecCoef: 1.0,
    lightMode: 0,
    materialUpdate: 0,
    reverseNormals: false,
    ...overrides,
  };
}

describe("computeVertexLighting", () => {
  it("should return emissive color when no lights are enabled", () => {
    const state = makeLightingState({
      materialEmissive: 0x804020, // R=0x20, G=0x40, B=0x80
    });
    const result = computeVertexLighting(state, [0, 0, 0], [0, 0, 1], 0xFFFFFFFF, false);
    const r = result & 0xFF;
    const g = (result >>> 8) & 0xFF;
    const b = (result >>> 16) & 0xFF;
    expect(r).toBe(0x20);
    expect(g).toBe(0x40);
    expect(b).toBe(0x80);
  });

  it("should include global ambient contribution", () => {
    const state = makeLightingState({
      ambientColor: 0xFFFFFF, // white global ambient
      ambientAlpha: 0xFF,
      materialAmbient: 0xFFFFFF,
      materialAlpha: 0xFF,
      materialEmissive: 0,
    });
    const result = computeVertexLighting(state, [0, 0, 0], [0, 0, 1], 0xFFFFFFFF, false);
    const r = result & 0xFF;
    const g = (result >>> 8) & 0xFF;
    const b = (result >>> 16) & 0xFF;
    const a = (result >>> 24) & 0xFF;
    // (mac * base) >> 10: mac = 0xFF*2+1=511, base = 0xFF*2+1=511
    // 511 * 511 >> 10 = 261121 >> 10 = 255 (clamped)
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBe(255);
    expect(a).toBe(255);
  });

  it("should compute directional light diffuse contribution", () => {
    // Light 0: directional, pointing in +Z direction, white diffuse
    // lightType: bits[1:0]=1 (GE_LIGHTCOMP_BOTH), bits[9:8]=0 (directional)
    const state = makeLightingState({
      lightEnable: [true, false, false, false],
      lightType: [1, 0, 0, 0], // comp=BOTH(1), type=directional(0<<8)
      ambientColor: 0,
      ambientAlpha: 0,
      materialEmissive: 0,
    });
    // Light 0 position = (0, 0, 1) — directional light from +Z
    state.lightPos[2] = 1.0;
    // Light 0 diffuse = white
    state.lightDiffuseColor[0] = 0xFFFFFF;

    // Normal facing +Z → dot(L, N) = 1.0 → full diffuse
    const result = computeVertexLighting(state, [0, 0, 0], [0, 0, 1], 0xFFFFFFFF, false);
    const r = result & 0xFF;
    const g = (result >>> 8) & 0xFF;
    const b = (result >>> 16) & 0xFF;
    // Should be bright (close to 255)
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
  });

  it("should produce zero diffuse when normal faces away from light", () => {
    const state = makeLightingState({
      lightEnable: [true, false, false, false],
      lightType: [1, 0, 0, 0],
      ambientColor: 0,
      ambientAlpha: 0,
      materialEmissive: 0,
    });
    state.lightPos[2] = 1.0;
    state.lightDiffuseColor[0] = 0xFFFFFF;

    // Normal facing -Z → dot(L, N) = -1.0 → no diffuse
    const result = computeVertexLighting(state, [0, 0, 0], [0, 0, -1], 0xFFFFFFFF, false);
    const r = result & 0xFF;
    const g = (result >>> 8) & 0xFF;
    const b = (result >>> 16) & 0xFF;
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it("should not compute specular when lightComp != BOTH", () => {
    const state = makeLightingState({
      lightEnable: [true, false, false, false],
      lightType: [0, 0, 0, 0], // comp=ONLYDIFFUSE(0), type=directional
      ambientColor: 0,
      ambientAlpha: 0,
      materialEmissive: 0,
      materialSpecCoef: 10.0,
    });
    state.lightPos[2] = 1.0;
    state.lightDiffuseColor[0] = 0x808080;
    state.lightSpecularColor[0] = 0xFFFFFF;

    // Normal = +Z, same as light → max specular IF it were enabled
    const result = computeVertexLighting(state, [0, 0, 0], [0, 0, 1], 0xFFFFFFFF, false);
    const r = result & 0xFF;
    // With only diffuse (no specular), result should be moderate, not boosted by specular
    // Diffuse: 0x80 light * 0xFF material * attspot → ~127
    expect(r).toBeLessThan(180); // no specular boost
  });

  it("should use correct light type bits (geom type in bits 9:8)", () => {
    // lightType = 0x101: comp=BOTH(1), geomType=point(1<<8)
    const state = makeLightingState({
      lightEnable: [true, false, false, false],
      lightType: [0x101, 0, 0, 0],
      ambientColor: 0,
      ambientAlpha: 0,
      materialEmissive: 0,
    });
    // Point light at (0, 0, 5) — vertex at origin
    state.lightPos[0] = 0;
    state.lightPos[1] = 0;
    state.lightPos[2] = 5;
    // Attenuation: kA=1, kB=0, kC=0 → att = 1/(1+0+0) = 1
    state.lightAtt[0] = 1.0;
    state.lightAtt[1] = 0;
    state.lightAtt[2] = 0;
    state.lightDiffuseColor[0] = 0xFFFFFF;

    // Normal facing +Z → dot(L, N) = 1.0
    const result = computeVertexLighting(state, [0, 0, 0], [0, 0, 1], 0xFFFFFFFF, false);
    const r = result & 0xFF;
    expect(r).toBeGreaterThan(200); // point light illuminates
  });
});

// ---------------------------------------------------------------------------
// Patch tessellation unit tests
// ---------------------------------------------------------------------------

describe("tessellateBezier", () => {
  function makeControlPoint(x: number, y: number, z: number): import("../src/gpu/ge-types.js").Vertex {
    return { x, y, z, u: x / 3, v: y / 3, color: 0xFFFFFFFF, nx: 0, ny: 0, nz: 1, clipw: 1.0, fogCoef: 1.0 };
  }

  it("should return empty for uCount < 4", () => {
    const cp = Array.from({ length: 12 }, (_, i) => makeControlPoint(i % 3, Math.floor(i / 3), 0));
    expect(tessellateBezier(cp, 3, 4, 2, 2, false)).toHaveLength(0);
  });

  it("should tessellate a flat 4x4 patch into triangles", () => {
    // Create a flat 4x4 grid of control points on the XY plane
    const cp: import("../src/gpu/ge-types.js").Vertex[] = [];
    for (let v = 0; v < 4; v++) {
      for (let u = 0; u < 4; u++) {
        cp.push(makeControlPoint(u, v, 0));
      }
    }

    const tris = tessellateBezier(cp, 4, 4, 2, 2, false);
    // divU=2, divV=2 → 3x3 grid → 2x2 quads → 8 triangles → 24 vertices
    expect(tris.length).toBe(24);

    // All Z values should be 0 (flat patch)
    for (const v of tris) {
      expect(v.z).toBeCloseTo(0, 5);
    }

    // Corner vertices should match control point corners
    // The first vertex in the first triangle should be at (0, 0, 0)
    expect(tris[0]!.x).toBeCloseTo(0, 3);
    expect(tris[0]!.y).toBeCloseTo(0, 3);
  });

  it("should compute normals for a flat patch as (0, 0, ±1)", () => {
    const cp: import("../src/gpu/ge-types.js").Vertex[] = [];
    for (let v = 0; v < 4; v++) {
      for (let u = 0; u < 4; u++) {
        cp.push(makeControlPoint(u, v, 0));
      }
    }

    const tris = tessellateBezier(cp, 4, 4, 2, 2, false);
    for (const v of tris) {
      // Normal should be close to (0, 0, 1) or (0, 0, -1) for a flat XY-plane patch
      expect(Math.abs(v.nz)).toBeCloseTo(1, 2);
      expect(Math.abs(v.nx)).toBeCloseTo(0, 2);
      expect(Math.abs(v.ny)).toBeCloseTo(0, 2);
    }
  });

  it("should flip normals when patchFacing is true", () => {
    const cp: import("../src/gpu/ge-types.js").Vertex[] = [];
    for (let v = 0; v < 4; v++) {
      for (let u = 0; u < 4; u++) {
        cp.push(makeControlPoint(u, v, 0));
      }
    }

    const trisNormal = tessellateBezier(cp, 4, 4, 2, 2, false);
    const trisFlipped = tessellateBezier(cp, 4, 4, 2, 2, true);

    // Normals should be opposite
    expect(trisNormal[0]!.nz).toBeCloseTo(-trisFlipped[0]!.nz, 3);
  });
});

describe("tessellateSpline", () => {
  function makeControlPoint(x: number, y: number, z: number): import("../src/gpu/ge-types.js").Vertex {
    return { x, y, z, u: x / 3, v: y / 3, color: 0xFFFFFFFF, nx: 0, ny: 0, nz: 1, clipw: 1.0, fogCoef: 1.0 };
  }

  it("should return empty for uCount < 4", () => {
    const cp = Array.from({ length: 12 }, (_, i) => makeControlPoint(i % 3, Math.floor(i / 3), 0));
    expect(tessellateSpline(cp, 3, 4, 0, 0, 2, 2, false)).toHaveLength(0);
  });

  it("should tessellate a flat 4x4 spline into triangles", () => {
    const cp: import("../src/gpu/ge-types.js").Vertex[] = [];
    for (let v = 0; v < 4; v++) {
      for (let u = 0; u < 4; u++) {
        cp.push(makeControlPoint(u, v, 0));
      }
    }

    // 4 control points → 1 patch, divU=2, divV=2 → 3x3 grid → 2x2 quads → 8 tris
    const tris = tessellateSpline(cp, 4, 4, 3, 3, 2, 2, false);
    expect(tris.length).toBe(24);

    // All Z values should be approximately 0
    for (const v of tris) {
      expect(v.z).toBeCloseTo(0, 3);
    }
  });

  it("should handle larger control point grids (5x5)", () => {
    const cp: import("../src/gpu/ge-types.js").Vertex[] = [];
    for (let v = 0; v < 5; v++) {
      for (let u = 0; u < 5; u++) {
        cp.push(makeControlPoint(u, v, 0));
      }
    }

    // 5 control points → 2 patches per axis, divU=2, divV=2
    // totalU = 2*2+1=5, totalV = 2*2+1=5 → 4x4 quads → 32 tris → 96 verts
    const tris = tessellateSpline(cp, 5, 5, 3, 3, 2, 2, false);
    expect(tris.length).toBe(96);
  });
});
