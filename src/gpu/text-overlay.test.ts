import { describe, it, expect } from "vitest";
import { MemoryBus } from "../memory/memory-bus.js";
import { drawText, textWidth, GLYPH_H } from "./text-overlay.js";

// Draw into VRAM (0x04000000) so we exercise the same region MPEG frames use.
const VRAM = 0x04000000;

describe("text-overlay", () => {
  it("writes lit pixels for glyphs and leaves the background untouched (8888)", () => {
    const bus = MemoryBus.create();
    const frameWidth = 64;
    const height = 32;
    // "I" at (0,0): top row of the glyph is "01110", so column 0 stays black,
    // columns 1..3 are lit.
    drawText(bus, VRAM, frameWidth, height, 3, 0, 0, "I", 1);

    const px = (x: number, y: number): number => bus.readU32(VRAM + (y * frameWidth + x) * 4);
    expect(px(0, 0)).toBe(0);              // unlit column of the glyph
    expect(px(1, 0) >>> 0).toBe(0xffffffff); // lit, opaque white
    expect(px(3, 0) >>> 0).toBe(0xffffffff);
    expect(px(20, 20)).toBe(0);            // far from any glyph
  });

  it("respects scale and color in a 16-bit format (5551)", () => {
    const bus = MemoryBus.create();
    const frameWidth = 128;
    const height = 64;
    // Red, scale 2. "I" top row lit columns (1..3) become 2px-wide blocks.
    drawText(bus, VRAM, frameWidth, height, 1, 0, 0, "I", 2, [255, 0, 0, 255]);
    // 5551 red = alpha<<15 | r>>3 = 0x8000 | 0x1f = 0x801f
    const px = (x: number, y: number): number => bus.readU16(VRAM + (y * frameWidth + x) * 2);
    expect(px(2, 0)).toBe(0x801f); // inside lit column 1 (x=2..3 at scale 2)
    expect(px(2, 1)).toBe(0x801f); // scaled vertically too
    expect(px(0, 0)).toBe(0);      // unlit column 0
  });

  it("clips text drawn past the frame bounds without throwing", () => {
    const bus = MemoryBus.create();
    expect(() => drawText(bus, VRAM, 16, 16, 3, 14, 14, "WIDE", 2)).not.toThrow();
  });

  it("textWidth grows with length and scale", () => {
    expect(textWidth("AB", 1)).toBe(2 * 6);
    expect(textWidth("AB", 2)).toBe(2 * 6 * 2);
    expect(GLYPH_H).toBe(7);
  });
});
