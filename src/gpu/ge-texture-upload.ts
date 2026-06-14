/**
 * Bulk texture decoding for WebGL upload.
 *
 * Converts PSP texture data (various formats, swizzled/unswizzled, CLUT-indexed)
 * into RGBA8888 Uint8Array suitable for gl.texImage2D.
 *
 * Reuses format knowledge from ge-texture.ts but decodes the entire texture at once
 * instead of per-pixel sampling.
 */

import type { MemoryBus } from "../memory/memory-bus.js";
import type { GETextureState } from "./ge-texture.js";
import { color5650to8888, color5551to8888, color4444to8888 } from "./ge-types.js";

/**
 * Decode a PSP texture into an RGBA8888 Uint8Array for WebGL upload.
 * The output byte order is [R, G, B, A] per pixel (WebGL standard).
 */
export function decodeTexture(
  bus: MemoryBus,
  state: GETextureState,
): { data: Uint8Array; width: number; height: number } {
  const tw = state.texWidth0 || 1;
  const th = state.texHeight0 || 1;
  const bw = state.texBufWidth0 || tw;
  const addr = state.texAddr0;
  const fmt = state.texFormat;

  // Decode texWidth columns using texBufWidth as the memory stride.
  // PPSSPP normalizes UVs by texWidth, so the WebGL texture should be texWidth wide.
  const out = new Uint8Array(tw * th * 4);

  if (fmt <= 3) {
    decodeDirectColor(bus, addr, bw, tw, th, fmt, state.texSwizzle, out);
  } else if (fmt >= 4 && fmt <= 7) {
    const clut = decodeCLUT(bus, state);
    decodeCLUTIndexed(bus, addr, bw, tw, th, fmt, state.texSwizzle, clut, state, out);
  } else if (fmt >= 8 && fmt <= 10) {
    decodeDXT(bus, addr, bw, tw, th, fmt, out);
  }

  return { data: out, width: tw, height: th };
}

/** Decode a CLUT into an array of RGBA8888 values. */
function decodeCLUT(bus: MemoryBus, state: GETextureState): Uint32Array {
  const maxEntries = state.clutFormat === 3 ? 256 : 512;
  const clut = new Uint32Array(maxEntries);
  const base = state.clutAddr;

  for (let i = 0; i < maxEntries; i++) {
    let abgr: number;
    switch (state.clutFormat) {
      case 0: abgr = color5650to8888(bus.readU16(base + i * 2)); break;
      case 1: abgr = color5551to8888(bus.readU16(base + i * 2)); break;
      case 2: abgr = color4444to8888(bus.readU16(base + i * 2)); break;
      case 3: abgr = bus.readU32(base + i * 4); break;
      default: abgr = 0xFFFFFFFF;
    }
    clut[i] = abgr;
  }
  return clut;
}

/** Write an ABGR8888 pixel to RGBA output at a given index. */
function writeRGBA(out: Uint8Array, idx: number, abgr: number): void {
  const di = idx * 4;
  out[di]     = abgr & 0xFF;              // R
  out[di + 1] = (abgr >>> 8) & 0xFF;      // G
  out[di + 2] = (abgr >>> 16) & 0xFF;     // B
  out[di + 3] = (abgr >>> 24) & 0xFF;     // A
}

/** Decode direct-color texture (formats 0-3). */
function decodeDirectColor(
  bus: MemoryBus, addr: number, bw: number, tw: number, th: number,
  fmt: number, swizzle: boolean, out: Uint8Array,
): void {
  for (let v = 0; v < th; v++) {
    for (let u = 0; u < tw; u++) {
      let abgr: number;
      if (swizzle) {
        abgr = sampleSwizzled(bus, u, v, bw, fmt, addr);
      } else {
        const bpp = fmt === 3 ? 4 : 2;
        const off = (v * bw + u) * bpp;
        if (fmt === 3) {
          abgr = bus.readU32(addr + off);
        } else {
          const px = bus.readU16(addr + off);
          switch (fmt) {
            case 0: abgr = color5650to8888(px); break;
            case 1: abgr = color5551to8888(px); break;
            case 2: abgr = color4444to8888(px); break;
            default: abgr = 0xFFFFFFFF;
          }
        }
      }
      writeRGBA(out, v * tw + u, abgr);
    }
  }
}

/** Sample from a swizzled texture (copied from ge-texture.ts for standalone use). */
function sampleSwizzled(bus: MemoryBus, u: number, v: number, bw: number, fmt: number, addr: number): number {
  const bpp = fmt === 3 ? 4 : 2;
  const rowBytes = bw * bpp;
  const blockX = (u * bpp) >> 4;
  const blockY = v >> 3;
  const blocksPerRow = rowBytes >> 4;
  const blockIdx = blockY * blocksPerRow + blockX;
  const inBlockX = (u * bpp) & 0xF;
  const inBlockY = v & 7;
  const byteOff = blockIdx * 128 + inBlockY * 16 + inBlockX;

  if (fmt === 3) return bus.readU32(addr + byteOff);
  const px = bus.readU16(addr + byteOff);
  switch (fmt) {
    case 0: return color5650to8888(px);
    case 1: return color5551to8888(px);
    case 2: return color4444to8888(px);
    default: return 0xFFFFFFFF;
  }
}

/** Decode CLUT-indexed texture (formats 4-7). */
function decodeCLUTIndexed(
  bus: MemoryBus, addr: number, bw: number, tw: number, th: number,
  fmt: number, swizzle: boolean, clut: Uint32Array, state: GETextureState,
  out: Uint8Array,
): void {
  const wrapMask = state.clutFormat === 3 ? 0xFF : 0x1FF;

  for (let v = 0; v < th; v++) {
    for (let u = 0; u < tw; u++) {
      let rawIdx: number;

      if (fmt === 4) {
        // T4: 4-bit indexed
        if (swizzle) {
          const byteCol = u >> 1;
          const rowBytes = bw >> 1;
          const blockX = byteCol >> 4;
          const blockY = v >> 3;
          const blocksPerRow = rowBytes >> 4;
          const byteOff = (blockY * blocksPerRow + blockX) * 128 + (v & 7) * 16 + (byteCol & 0xF);
          const b = bus.readU8(addr + byteOff);
          rawIdx = (u & 1) ? (b >> 4) : (b & 0xF);
        } else {
          const byteOff = v * (bw >> 1) + (u >> 1);
          const b = bus.readU8(addr + byteOff);
          rawIdx = (u & 1) ? (b >> 4) : (b & 0xF);
        }
      } else if (fmt === 5) {
        // T8: 8-bit indexed
        if (swizzle) {
          const blockX = u >> 4;
          const blockY = v >> 3;
          const blocksPerRow = bw >> 4;
          const byteOff = (blockY * blocksPerRow + blockX) * 128 + (v & 7) * 16 + (u & 0xF);
          rawIdx = bus.readU8(addr + byteOff);
        } else {
          rawIdx = bus.readU8(addr + v * bw + u);
        }
      } else if (fmt === 6) {
        // T16
        rawIdx = bus.readU16(addr + (v * bw + u) * 2);
      } else {
        // T32
        rawIdx = bus.readU32(addr + (v * bw + u) * 4) & 0xFF;
      }

      // CLUT index transform (PPSSPP GPUState.h transformClutIndex)
      const idx = (((rawIdx >> state.clutShift) & state.clutMask) | (state.clutStart & wrapMask)) & wrapMask;
      writeRGBA(out, v * tw + u, clut[idx]!);
    }
  }
}

/** Decode DXT1/3/5 compressed textures. */
function decodeDXT(
  bus: MemoryBus, addr: number, bw: number, tw: number, th: number,
  fmt: number, out: Uint8Array,
): void {
  // Import the DXT samplers from ge-texture.ts would create a circular dependency,
  // so we re-implement block decoding inline.
  const blocksW = (tw + 3) >> 2;
  const blocksH = (th + 3) >> 2;
  const blocksPerRow = (bw + 3) >> 2;
  const blockSize = fmt === 8 ? 8 : 16;

  for (let by = 0; by < blocksH; by++) {
    for (let bx = 0; bx < blocksW; bx++) {
      const blockAddr = addr + (by * blocksPerRow + bx) * blockSize;

      // Decode a 4x4 block
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= tw || y >= th) continue;

          let abgr: number;
          if (fmt === 8) {
            abgr = decodeDXT1Pixel(bus, blockAddr, px, py);
          } else if (fmt === 9) {
            abgr = decodeDXT3Pixel(bus, blockAddr, px, py);
          } else {
            abgr = decodeDXT5Pixel(bus, blockAddr, px, py);
          }
          writeRGBA(out, y * tw + x, abgr);
        }
      }
    }
  }
}

function decodeDXT1Pixel(bus: MemoryBus, blockAddr: number, px: number, py: number): number {
  const c0raw = bus.readU16(blockAddr);
  const c1raw = bus.readU16(blockAddr + 2);
  const bits = bus.readU32(blockAddr + 4);

  const c0 = color5650to8888(c0raw);
  const c1 = color5650to8888(c1raw);
  const code = (bits >> ((py * 4 + px) * 2)) & 3;

  const r0 = c0 & 0xFF, g0 = (c0 >> 8) & 0xFF, b0 = (c0 >> 16) & 0xFF;
  const r1 = c1 & 0xFF, g1 = (c1 >> 8) & 0xFF, b1 = (c1 >> 16) & 0xFF;

  let r: number, g: number, b: number, a = 255;
  if (code === 0) { r = r0; g = g0; b = b0; }
  else if (code === 1) { r = r1; g = g1; b = b1; }
  else if (c0raw > c1raw) {
    if (code === 2) { r = (2*r0+r1)/3|0; g = (2*g0+g1)/3|0; b = (2*b0+b1)/3|0; }
    else { r = (r0+2*r1)/3|0; g = (g0+2*g1)/3|0; b = (b0+2*b1)/3|0; }
  } else {
    if (code === 2) { r = (r0+r1)/2|0; g = (g0+g1)/2|0; b = (b0+b1)/2|0; }
    else { r = 0; g = 0; b = 0; a = 0; }
  }

  return (a << 24) | (b << 16) | (g << 8) | r;
}

function decodeDXT3Pixel(bus: MemoryBus, blockAddr: number, px: number, py: number): number {
  const alphaWord = bus.readU16(blockAddr + py * 2);
  const alpha = ((alphaWord >> (px * 4)) & 0xF) << 4; // PPSSPP WriteColorsDXT3: nibble<<4
  const color = decodeDXT1Pixel(bus, blockAddr + 8, px, py);
  return (color & 0x00FFFFFF) | (alpha << 24);
}

function decodeDXT5Pixel(bus: MemoryBus, blockAddr: number, px: number, py: number): number {
  const a0 = bus.readU8(blockAddr);
  const a1 = bus.readU8(blockAddr + 1);
  const bitIdx = (py * 4 + px) * 3;
  const byteOff = blockAddr + 2 + (bitIdx >> 3);
  const bitShift = bitIdx & 7;
  const rawBits = bus.readU8(byteOff) | (bus.readU8(byteOff + 1) << 8);
  const code = (rawBits >> bitShift) & 7;

  let alpha: number;
  if (code === 0) alpha = a0;
  else if (code === 1) alpha = a1;
  else if (a0 > a1) alpha = ((8 - code) * a0 + (code - 1) * a1) / 7 | 0;
  else if (code <= 5) alpha = ((6 - code) * a0 + (code - 1) * a1) / 5 | 0;
  else alpha = code === 6 ? 0 : 255;

  // Color block at +8, always 4-color mode
  const c0raw = bus.readU16(blockAddr + 8);
  const c1raw = bus.readU16(blockAddr + 10);
  const bits = bus.readU32(blockAddr + 12);
  const c0 = color5650to8888(c0raw);
  const c1 = color5650to8888(c1raw);
  const colorCode = (bits >> ((py * 4 + px) * 2)) & 3;

  const r0 = c0 & 0xFF, g0 = (c0>>8)&0xFF, b0 = (c0>>16)&0xFF;
  const r1 = c1 & 0xFF, g1 = (c1>>8)&0xFF, b1 = (c1>>16)&0xFF;

  let r: number, g: number, b: number;
  if (colorCode === 0) { r = r0; g = g0; b = b0; }
  else if (colorCode === 1) { r = r1; g = g1; b = b1; }
  else if (colorCode === 2) { r = (2*r0+r1)/3|0; g = (2*g0+g1)/3|0; b = (2*b0+b1)/3|0; }
  else { r = (r0+2*r1)/3|0; g = (g0+2*g1)/3|0; b = (b0+2*b1)/3|0; }

  return (alpha << 24) | (b << 16) | (g << 8) | r;
}
