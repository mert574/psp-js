/**
 * Pack a decoded RGBA frame into a PSP-format framebuffer in guest memory.
 *
 * The MPEG decoder produces RGBA pixels (via libav's format=rgba filter); the
 * game's sceMpegAvcDecode hands us a destination buffer plus a pixel mode and
 * row stride. This writes the RGBA pixels in the right PSP packing, clipping to
 * the frame size. Pure memory math so it runs (and is tested) under Node.
 *
 * pixelMode matches sceMpegAvcDecodeMode: 0=BGR5650, 1=ABGR5551, 2=ABGR4444,
 * 3=ABGR8888. Source rows are top-down, 4 bytes/pixel (R,G,B,A).
 */

import type { MemoryBus } from "../memory/memory-bus.js";

export function packRgbaToFrame(
  bus: MemoryBus,
  dest: number,
  frameWidth: number,
  frameHeight: number,
  pixelMode: number,
  rgba: Uint8Array | Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
): void {
  const w = Math.min(srcWidth, frameWidth);
  const h = Math.min(srcHeight, frameHeight);
  if (w <= 0 || h <= 0) return;

  if (pixelMode === 3) {
    // ABGR8888: 4 bytes/pixel, alpha forced opaque (matches PPSSPP writeVideoLineRGBA).
    for (let y = 0; y < h; y++) {
      let s = y * srcWidth * 4;
      let d = dest + y * frameWidth * 4;
      for (let x = 0; x < w; x++) {
        const r = rgba[s]!, g = rgba[s + 1]!, b = rgba[s + 2]!;
        bus.writeU32(d, ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0);
        s += 4; d += 4;
      }
    }
    return;
  }

  // 16-bit formats: 2 bytes/pixel.
  for (let y = 0; y < h; y++) {
    let s = y * srcWidth * 4;
    let d = dest + y * frameWidth * 2;
    for (let x = 0; x < w; x++) {
      const r = rgba[s]!, g = rgba[s + 1]!, b = rgba[s + 2]!;
      let v: number;
      if (pixelMode === 0) v = ((b >> 3) << 11) | ((g >> 2) << 5) | (r >> 3);       // BGR5650
      else if (pixelMode === 1) v = 0x8000 | ((b >> 3) << 10) | ((g >> 3) << 5) | (r >> 3); // ABGR5551
      else v = 0xf000 | ((b >> 4) << 8) | ((g >> 4) << 4) | (r >> 4);               // ABGR4444
      bus.writeU16(d, v);
      s += 4; d += 2;
    }
  }
}
