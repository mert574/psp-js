/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PGF, FontPixelFormat } from "./hle-font.js";
import { MemoryBus } from "../memory/memory-bus.js";

describe("distributed OFL font replacements", () => {
  it("decodes all slots and renders nonblank text through the guest-memory API", () => {
    const bus = MemoryBus.create();
    const info = 0x08001000, pixels = 0x08002000;
    bus.writeU32(info, FontPixelFormat.PSP_FONT_PIXELFORMAT_8);
    bus.writeU32(info + 4, 0); bus.writeU32(info + 8, 0);
    bus.writeU16(info + 12, 64); bus.writeU16(info + 14, 64);
    bus.writeU16(info + 16, 64); bus.writeU32(info + 20, pixels);
    for (let slot = 0; slot < 16; slot++) {
      const file = readFileSync(new URL(`../../public/flash0/font/ltn${slot}.pgf`, import.meta.url));
      const pgf = new PGF(Uint8Array.from(file).buffer);
      expect(pgf.header.fontName).toMatch(/^PSP\.js (Sans|Mono)$/);
      expect(pgf.header.charPointerLength).toBeGreaterThan(300);
      const shapes = new Set<string>();
      for (const character of "Ag09é") {
        const glyph = pgf.getGlyph(character.codePointAt(0)!);
        expect(glyph).not.toBeNull();
        expect(glyph!.w).toBeLessThanOrEqual(pgf.header.maxGlyphWidth);
        expect(glyph!.h).toBeLessThanOrEqual(pgf.header.maxGlyphHeight);
        for (let i = -1; i <= 4096; i++) bus.writeU8(pixels + i, 0);
        bus.writeU8(pixels - 1, 0xab); bus.writeU8(pixels + 4096, 0xcd);
        pgf.drawCharacter(bus, info, character.codePointAt(0)!, 0x20);
        const rendered = Array.from({ length: 4096 }, (_, i) => bus.readU8(pixels + i));
        expect(rendered.some(value => value > 0)).toBe(true);
        shapes.add(rendered.join(","));
        expect(bus.readU8(pixels - 1)).toBe(0xab);
        expect(bus.readU8(pixels + 4096)).toBe(0xcd);
      }
      expect(shapes.size).toBe(5);
      expect(pgf.getGlyph(0x20)?.w).toBe(0);
      expect(pgf.getGlyph(0x7f)).toBeNull();
    }
  });
});
