import type { MemoryBus } from "../memory/memory-bus.js";

export interface GeExecuteResult {
  stoppedPc: number;          // -1 if END reached, else current PC
  commandsProcessed: number;  // how many commands were processed
}

export interface Vertex {
  x: number; y: number; z: number;
  u: number; v: number;
  color: number; // ABGR8888
  /** Model-space normal (read from vertex data when normFmt != 0). */
  nx: number; ny: number; nz: number;
  weights?: number[]; // bone weights for skinned transform-mode vertices
  /** Clip-space W (from projection). Used for perspective-correct texture interpolation.
   *  PPSSPP: VertexData::clipw, set during TransformUnit::WorldToScreen (TransformUnit.cpp:417).
   *  Only set for transform-mode vertices; through-mode leaves this as 1.0. */
  clipw: number;
}

// Shared reinterpret buffer for float bit-casting (avoids per-call allocations)
const _reinterpret = new DataView(new ArrayBuffer(4));

/** Decode a PSP GE 24-bit float: upper 24 bits of an IEEE float32, lower 8 zeroed. */
export function getFloat24(param: number): number {
  _reinterpret.setUint32(0, (param & 0xFFFFFF) << 8, false);
  return _reinterpret.getFloat32(0, false);
}

export function readFloat(bus: MemoryBus, addr: number): number {
  _reinterpret.setUint32(0, bus.readU32(addr), false);
  return _reinterpret.getFloat32(0, false);
}

export function color5650to8888(c: number): number {
  const r = ((c) & 0x1F) << 3;
  const g = ((c >>> 5) & 0x3F) << 2;
  const b = ((c >>> 11) & 0x1F) << 3;
  return (0xFF << 24) | (b << 16) | (g << 8) | r;
}

export function color5551to8888(c: number): number {
  const r = ((c) & 0x1F) << 3;
  const g = ((c >>> 5) & 0x1F) << 3;
  const b = ((c >>> 10) & 0x1F) << 3;
  const a = (c >>> 15) ? 0xFF : 0;
  return (a << 24) | (b << 16) | (g << 8) | r;
}

export function color4444to8888(c: number): number {
  const r = ((c) & 0xF) << 4;
  const g = ((c >>> 4) & 0xF) << 4;
  const b = ((c >>> 8) & 0xF) << 4;
  const a = ((c >>> 12) & 0xF) << 4;
  return (a << 24) | (b << 16) | (g << 8) | r;
}
