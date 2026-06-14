/**
 * Port of PPSSPP's BlockAllocator (Core/Util/BlockAllocator.cpp).
 * Doubly-linked list of address-sorted blocks with merge-on-free.
 * Used for userMemory (partition memory + thread stacks).
 */

interface Block {
  start: number;
  size: number;
  taken: boolean;
  tag: string;
  prev: Block | null;
  next: Block | null;
}

export class BlockAllocator {
  private bottom: Block | null = null;
  private top: Block | null = null;
  private rangeSize = 0;
  private readonly grain: number;

  constructor(grain = 16) {
    this.grain = grain;
  }

  isInitialized(): boolean { return this.bottom !== null; }

  init(rangeStart: number, rangeSize: number): void {
    this.shutdown();
    this.rangeSize = rangeSize;
    const block: Block = { start: rangeStart, size: rangeSize, taken: false, tag: "", prev: null, next: null };
    this.bottom = block;
    this.top = block;
  }

  shutdown(): void {
    this.bottom = null;
    this.top = null;
  }

  /** Allocate `size` bytes. Returns address or -1 on failure. Size is rounded up to grain. */
  alloc(size: number, fromTop = false, tag = ""): number {
    return this.allocAligned(size, this.grain, this.grain, fromTop, tag);
  }

  /**
   * Allocate with explicit alignment. Matches PPSSPP AllocAligned exactly.
   * Returns address or -1 on failure.
   */
  allocAligned(size: number, sizeGrain: number, grain: number, fromTop = false, tag = ""): number {
    if (size === 0 || size > this.rangeSize) return -1;
    // Enforce minimum grain
    if (grain < this.grain) grain = this.grain;
    if (sizeGrain < this.grain) sizeGrain = this.grain;
    // Round size up to sizeGrain
    size = (size + sizeGrain - 1) & ~(sizeGrain - 1);

    if (!fromTop) {
      // Scan from bottom (low addresses)
      for (let bp = this.bottom; bp !== null; bp = bp.next) {
        if (bp.taken || bp.size < size) continue;
        // Compute alignment offset
        let offset = bp.start % grain;
        if (offset !== 0) offset = grain - offset;
        const needed = offset + size;
        if (bp.size < needed) continue;

        if (bp.size === needed) {
          if (offset >= this.grain) this.insertFreeBefore(bp, offset);
          bp.taken = true;
          bp.tag = tag;
          return bp.start;
        }
        // Split: free after, then free before (if offset)
        this.insertFreeAfter(bp, bp.size - needed);
        if (offset >= this.grain) this.insertFreeBefore(bp, offset);
        bp.taken = true;
        bp.tag = tag;
        return bp.start;
      }
    } else {
      // Scan from top (high addresses)
      for (let bp = this.top; bp !== null; bp = bp.prev) {
        if (bp.taken || bp.size < size) continue;
        const offset = (bp.start + bp.size - size) % grain;
        const needed = offset + size;
        if (bp.size < needed) continue;

        if (bp.size === needed) {
          if (offset >= this.grain) this.insertFreeAfter(bp, offset);
          bp.taken = true;
          bp.tag = tag;
          return bp.start;
        }
        // Split: free before, then free after (if offset)
        this.insertFreeBefore(bp, bp.size - needed);
        if (offset >= this.grain) this.insertFreeAfter(bp, offset);
        bp.taken = true;
        bp.tag = tag;
        return bp.start;
      }
    }
    return -1;
  }

  /** Allocate at a specific position. Used by AllocAt for ELF loading. */
  allocAt(position: number, size: number, tag = ""): number {
    if (size === 0 || size > this.rangeSize) return -1;
    // Down-align position, up-align size
    const alignedPosition = position & ~(this.grain - 1);
    let alignedSize = size + (position - alignedPosition);
    alignedSize = (alignedSize + this.grain - 1) & ~(this.grain - 1);

    // Find the block containing alignedPosition
    const bp = this.getBlockFromAddress(alignedPosition);
    if (!bp || bp.taken) return -1;
    if (bp.start > alignedPosition || bp.start + bp.size < alignedPosition + alignedSize) return -1;

    // Split as needed
    const beforeSize = alignedPosition - bp.start;
    const afterSize = (bp.start + bp.size) - (alignedPosition + alignedSize);
    if (afterSize > 0) this.insertFreeAfter(bp, afterSize);
    if (beforeSize > 0) this.insertFreeBefore(bp, beforeSize);
    bp.taken = true;
    bp.tag = tag;
    return position;
  }

  /** Free a block containing the given address. */
  free(position: number): boolean {
    const bp = this.getBlockFromAddress(position);
    if (!bp || !bp.taken) return false;
    bp.taken = false;
    bp.tag = "";
    this.mergeFreeBlocks(bp);
    return true;
  }

  /** Free a block only if it starts at exactly the given address. */
  freeExact(position: number): boolean {
    const bp = this.getBlockFromAddress(position);
    if (!bp || !bp.taken || bp.start !== position) return false;
    bp.taken = false;
    bp.tag = "";
    this.mergeFreeBlocks(bp);
    return true;
  }

  /** Snapshot of every block (free and taken), low address first, for inspection. */
  listBlocks(): Array<{ start: number; size: number; taken: boolean; tag: string }> {
    const out: Array<{ start: number; size: number; taken: boolean; tag: string }> = [];
    for (let bp = this.bottom; bp !== null; bp = bp.next) {
      out.push({ start: bp.start, size: bp.size, taken: bp.taken, tag: bp.tag });
    }
    return out;
  }

  getTotalFreeBytes(): number {
    let total = 0;
    for (let bp = this.bottom; bp !== null; bp = bp.next) {
      if (!bp.taken) total += bp.size;
    }
    return total;
  }

  getLargestFreeBlockSize(): number {
    let largest = 0;
    for (let bp = this.bottom; bp !== null; bp = bp.next) {
      if (!bp.taken && bp.size > largest) largest = bp.size;
    }
    return largest;
  }

  getBlockStartFromAddress(addr: number): number {
    const bp = this.getBlockFromAddress(addr);
    return bp ? bp.start : -1;
  }

  isBlockFree(position: number): boolean {
    const bp = this.getBlockFromAddress(position);
    return bp ? !bp.taken : false;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private getBlockFromAddress(addr: number): Block | null {
    for (let bp = this.bottom; bp !== null; bp = bp.next) {
      if (bp.start <= addr && bp.start + bp.size > addr) return bp;
    }
    return null;
  }

  /** Insert a new free block before `b`, taking `size` bytes from b's start. */
  private insertFreeBefore(b: Block, size: number): void {
    const newBlock: Block = {
      start: b.start,
      size,
      taken: false,
      tag: "",
      prev: b.prev,
      next: b,
    };
    if (b.prev) b.prev.next = newBlock;
    else this.bottom = newBlock;
    b.prev = newBlock;
    b.start += size;
    b.size -= size;
  }

  /** Insert a new free block after `b`, taking `size` bytes from b's end. */
  private insertFreeAfter(b: Block, size: number): void {
    const newBlock: Block = {
      start: b.start + b.size - size,
      size,
      taken: false,
      tag: "",
      prev: b,
      next: b.next,
    };
    if (b.next) b.next.prev = newBlock;
    else this.top = newBlock;
    b.next = newBlock;
    b.size -= size;
  }

  /** Merge adjacent free blocks around `fromBlock`. */
  private mergeFreeBlocks(fromBlock: Block): void {
    // Merge backward
    let bp: Block = fromBlock;
    while (bp.prev && !bp.prev.taken) {
      const prev: Block = bp.prev;
      prev.size += bp.size;
      prev.next = bp.next;
      if (bp.next) bp.next.prev = prev;
      else this.top = prev;
      bp = prev;
    }
    // Merge forward
    while (bp.next && !bp.next.taken) {
      const next: Block = bp.next;
      bp.size += next.size;
      bp.next = next.next;
      if (next.next) next.next.prev = bp;
      else this.top = bp;
    }
  }
}
