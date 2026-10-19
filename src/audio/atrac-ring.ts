/** Byte-ring accounting for the emulator's incremental audio loader. */
export interface RingWindow { position: number; writable: number; fileOffset: number }
export function frameCapacity(bytes: number, frameBytes: number): number {
  return Math.floor(bytes / Math.max(1, frameBytes)) * Math.max(1, frameBytes);
}
export function refillWindow(position: number, valid: number, capacity: number, fileOffset: number, fileSize: number, linear: boolean): RingWindow {
  const remaining = Math.max(0, fileSize - fileOffset);
  if (linear) return { position: fileOffset, writable: remaining, fileOffset };
  if (!remaining || capacity <= 0) return { position: 0, writable: 0, fileOffset: 0 };
  const write = (position + valid) % capacity;
  const unused = Math.max(0, capacity - valid);
  return { position: write, writable: Math.min(remaining, unused, capacity - write), fileOffset };
}
export function consumeFrame(position: number, valid: number, capacity: number, frameBytes: number): { position: number; valid: number } {
  return { position: capacity > 0 ? (position + frameBytes) % capacity : position + frameBytes, valid: Math.max(0, valid - frameBytes) };
}
