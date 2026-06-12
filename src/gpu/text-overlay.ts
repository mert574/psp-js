/**
 * Tiny 5x7 bitmap font for drawing debug text straight into a PSP-format
 * framebuffer in RAM/VRAM. Used by the fake MPEG decoder to label the video
 * frame it would otherwise leave blank, but the writer is format-agnostic so
 * any overlay can reuse it.
 *
 * pixelMode matches sceMpegAvcDecodeMode: 0=5650, 1=5551, 2=4444, 3=8888.
 */

import type { MemoryBus } from "../memory/memory-bus.js";

// Each glyph is 7 rows of 5 columns. '#' = lit pixel. Text is upper-cased
// before lookup, so only these glyphs are needed.
const GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "11110", "10001", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "11110", "10000", "10000", "10000", "11111"],
  F: ["11111", "10000", "11110", "10000", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "11111", "10001", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "11100", "10100", "11100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
};

const GLYPH_W = 5;
export const GLYPH_H = 7;

/** Pack an 8-bit RGBA color into the given PSP pixel format. */
function packColor(pixelMode: number, r: number, g: number, b: number, a: number): number {
  switch (pixelMode) {
    case 0: // 5650 (no alpha)
      return ((b >> 3) << 11) | ((g >> 2) << 5) | (r >> 3);
    case 1: // 5551
      return ((a ? 1 : 0) << 15) | ((b >> 3) << 10) | ((g >> 3) << 5) | (r >> 3);
    case 2: // 4444
      return ((a >> 4) << 12) | ((b >> 4) << 8) | ((g >> 4) << 4) | (r >> 4);
    default: // 8888
      return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
}

/**
 * Draw `text` at (x, y) into a framebuffer at `dest`. `frameWidth` is the row
 * stride in pixels, `frameHeight` clips vertically. `scale` enlarges each font
 * pixel into a scale×scale block. Pixels outside the frame are skipped.
 */
export function drawText(
  bus: MemoryBus,
  dest: number,
  frameWidth: number,
  frameHeight: number,
  pixelMode: number,
  x: number,
  y: number,
  text: string,
  scale = 1,
  rgba: [number, number, number, number] = [255, 255, 255, 255],
): void {
  const bpp = pixelMode === 3 ? 4 : 2;
  const color = packColor(pixelMode, rgba[0], rgba[1], rgba[2], rgba[3]);
  const putPixel = (px: number, py: number): void => {
    if (px < 0 || py < 0 || px >= frameWidth || py >= frameHeight) return;
    const addr = dest + (py * frameWidth + px) * bpp;
    if (bpp === 4) bus.writeU32(addr, color);
    else bus.writeU16(addr, color);
  };

  let cursorX = x;
  for (const rawCh of text.toUpperCase()) {
    const glyph = GLYPHS[rawCh] ?? GLYPHS[" "]!;
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row]!;
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits[col] !== "#" && bits[col] !== "1") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            putPixel(cursorX + col * scale + sx, y + row * scale + sy);
          }
        }
      }
    }
    cursorX += (GLYPH_W + 1) * scale;
  }
}

/** Width in pixels a string would occupy at the given scale. */
export function textWidth(text: string, scale = 1): number {
  return text.length * (GLYPH_W + 1) * scale;
}
