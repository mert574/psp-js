/** Address-range allocator using an ordered array of intervals. */
interface Segment { start: number; size: number; taken: boolean; tag: string }
export interface BlockAllocatorState { rangeSize: number; blocks: Segment[] }
const up = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;
const down = (value: number, alignment: number): number => Math.floor(value / alignment) * alignment;
export class BlockAllocator {
  private segments: Segment[] = [];
  private rangeSize = 0;
  constructor(private readonly grain = 16) {}
  isInitialized(): boolean { return this.segments.length > 0; }
  init(rangeStart: number, rangeSize: number): void {
    this.rangeSize = rangeSize;
    this.segments = [{ start: rangeStart, size: rangeSize, taken: false, tag: "" }];
  }
  shutdown(): void { this.segments = []; this.rangeSize = 0; }
  alloc(size: number, fromTop = false, tag = ""): number {
    return this.allocAligned(size, this.grain, this.grain, fromTop, tag);
  }
  allocAligned(size: number, sizeGrain: number, grain: number, fromTop = false, tag = ""): number {
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.rangeSize) return -1;
    const rounded = up(size, Math.max(sizeGrain, this.grain));
    const alignment = Math.max(grain, this.grain);
    const order = this.segments.map((_, i) => i);
    if (fromTop) order.reverse();
    for (const index of order) {
      const segment = this.segments[index]!;
      if (segment.taken) continue;
      const address = fromTop ? down(segment.start + segment.size - rounded, alignment) : up(segment.start, alignment);
      if (address < segment.start || address + rounded > segment.start + segment.size) continue;
      this.reserve(index, address, rounded, tag);
      return address;
    }
    return -1;
  }
  allocAt(position: number, size: number, tag = ""): number {
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.rangeSize) return -1;
    const start = down(position, this.grain);
    const count = up(size + position - start, this.grain);
    const index = this.indexAt(start);
    const segment = this.segments[index];
    if (!segment || segment.taken || start + count > segment.start + segment.size) return -1;
    this.reserve(index, start, count, tag);
    return position;
  }
  private reserve(index: number, address: number, size: number, tag: string): void {
    const previous = this.segments[index]!;
    const end = previous.start + previous.size;
    const replacement: Segment[] = [];
    if (address > previous.start) replacement.push({ start: previous.start, size: address - previous.start, taken: false, tag: "" });
    replacement.push({ start: address, size, taken: true, tag });
    if (address + size < end) replacement.push({ start: address + size, size: end - address - size, taken: false, tag: "" });
    this.segments.splice(index, 1, ...replacement);
  }
  private indexAt(address: number): number {
    return this.segments.findIndex(s => s.start <= address && address < s.start + s.size);
  }
  free(position: number): boolean { return this.release(position, false); }
  freeExact(position: number): boolean { return this.release(position, true); }
  private release(position: number, exact: boolean): boolean {
    const segment = this.segments[this.indexAt(position)];
    if (!segment?.taken || (exact && segment.start !== position)) return false;
    segment.taken = false;
    segment.tag = "";
    this.segments = this.segments.reduce<Segment[]>((result, current) => {
      const last = result[result.length - 1];
      if (last && !last.taken && !current.taken && last.start + last.size === current.start) last.size += current.size;
      else result.push({ ...current });
      return result;
    }, []);
    return true;
  }
  listBlocks(): Segment[] { return this.segments.map(s => ({ ...s })); }
  getTotalFreeBytes(): number { return this.segments.reduce((sum, s) => sum + (s.taken ? 0 : s.size), 0); }
  getLargestFreeBlockSize(): number { return this.segments.reduce((largest, s) => s.taken ? largest : Math.max(largest, s.size), 0); }
  getBlockStartFromAddress(address: number): number { return this.segments[this.indexAt(address)]?.start ?? -1; }
  isBlockFree(address: number): boolean { return this.segments[this.indexAt(address)]?.taken === false; }
  serialize(): BlockAllocatorState { return { rangeSize: this.rangeSize, blocks: this.listBlocks() }; }
  deserialize(state: BlockAllocatorState): void { this.rangeSize = state.rangeSize; this.segments = state.blocks.map(s => ({ ...s })); }
}
