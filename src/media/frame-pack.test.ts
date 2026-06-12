import { describe, it, expect } from "vitest";
import { MemoryBus } from "../memory/memory-bus.js";
import { packRgbaToFrame } from "./frame-pack.js";

const VRAM = 0x04000000;

// Build a tiny RGBA source: 2x2 with known colors.
function src2x2(): Uint8Array {
  return new Uint8Array([
    255, 0, 0, 255,    0, 255, 0, 255,   // red, green
    0, 0, 255, 255,    255, 255, 255, 255, // blue, white
  ]);
}

describe("packRgbaToFrame", () => {
  it("packs ABGR8888 with opaque alpha (mode 3)", () => {
    const bus = MemoryBus.create();
    packRgbaToFrame(bus, VRAM, 2, 2, 3, src2x2(), 2, 2);
    // red -> A=ff B=00 G=00 R=ff = 0xff0000ff
    expect(bus.readU32(VRAM) >>> 0).toBe(0xff0000ff);
    // green -> 0xff00ff00
    expect(bus.readU32(VRAM + 4) >>> 0).toBe(0xff00ff00);
    // blue -> 0xffff0000
    expect(bus.readU32(VRAM + 8) >>> 0).toBe(0xffff0000);
    // white -> 0xffffffff
    expect(bus.readU32(VRAM + 12) >>> 0).toBe(0xffffffff);
  });

  it("packs BGR5650 (mode 0)", () => {
    const bus = MemoryBus.create();
    packRgbaToFrame(bus, VRAM, 2, 2, 0, src2x2(), 2, 2);
    // red (r=255) -> r>>3=0x1f in low 5 bits
    expect(bus.readU16(VRAM)).toBe(0x1f);
    // green (g=255) -> g>>2=0x3f at bits 5..10
    expect(bus.readU16(VRAM + 2)).toBe(0x3f << 5);
    // blue (b=255) -> b>>3=0x1f at bits 11..15
    expect(bus.readU16(VRAM + 4)).toBe(0x1f << 11);
  });

  it("forces the alpha bit in ABGR5551 (mode 1)", () => {
    const bus = MemoryBus.create();
    packRgbaToFrame(bus, VRAM, 2, 2, 1, src2x2(), 2, 2);
    expect(bus.readU16(VRAM) & 0x8000).toBe(0x8000); // alpha bit set
    expect(bus.readU16(VRAM) & 0x1f).toBe(0x1f);     // red
  });

  it("clips when source is larger than the frame", () => {
    const bus = MemoryBus.create();
    // 1x1 frame, 2x2 source: only the top-left pixel is written.
    packRgbaToFrame(bus, VRAM, 1, 1, 3, src2x2(), 2, 2);
    expect(bus.readU32(VRAM) >>> 0).toBe(0xff0000ff); // red
    expect(bus.readU32(VRAM + 4) >>> 0).toBe(0);       // untouched
  });

  it("respects the destination stride (frameWidth > source width)", () => {
    const bus = MemoryBus.create();
    // 4-wide frame, 2-wide source: row 1 of source lands at dest + 4*4 bytes.
    packRgbaToFrame(bus, VRAM, 4, 2, 3, src2x2(), 2, 2);
    expect(bus.readU32(VRAM + 16) >>> 0).toBe(0xffff0000); // blue, start of row 1
  });
});
