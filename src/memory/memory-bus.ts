import { MemoryRegion, toPhysical } from "./memory-map.js";

/**
 * MemoryBus
 *
 * Owns all physical memory arrays and routes reads/writes to the correct
 * region. All public methods take a *virtual* address and perform the
 * physical translation internally.
 *
 * Byte order: PSP is little-endian.
 *
 * Performance notes:
 * - Multi-byte reads/writes use DataView for correct little-endian handling
 *   without manual byte shuffling.
 * - HW I/O region (0x1C000000–0x1FBFFFFF) is stubbed: reads return 0,
 *   writes are silently dropped. No buffer is allocated for this ~60 MB range.
 */
export class MemoryBus {
  private ram:        Uint8Array;
  private vram:       Uint8Array;
  private scratchpad: Uint8Array;

  // Pre-allocated DataViews for fast multi-byte access
  private ramView:        DataView;
  private vramView:       DataView;
  private scratchpadView: DataView;

  /** Debug: set to a physical address to log all writes to that address */
  watchWriteAddr: number = 0;
  /** Debug: callback invoked when watchWriteAddr is hit — receives (vaddr, value) */
  onWatchWrite: ((vaddr: number, value: number) => void) | null = null;

  private constructor(
    ramBuf: ArrayBufferLike = new ArrayBuffer(MemoryRegion.RAM_SIZE),
    vramBuf: ArrayBufferLike = new ArrayBuffer(MemoryRegion.VRAM_SIZE),
    scratchpadBuf: ArrayBufferLike = new ArrayBuffer(MemoryRegion.SCRATCHPAD_SIZE),
  ) {
    this.ram        = new Uint8Array(ramBuf);
    this.vram       = new Uint8Array(vramBuf);
    this.scratchpad = new Uint8Array(scratchpadBuf);

    this.ramView        = new DataView(ramBuf);
    this.vramView       = new DataView(vramBuf);
    this.scratchpadView = new DataView(scratchpadBuf);
  }

  static create(): MemoryBus {
    return new MemoryBus();
  }

  static fromShared(ramSab: SharedArrayBuffer, vramSab: SharedArrayBuffer, scratchpadSab: SharedArrayBuffer): MemoryBus {
    return new MemoryBus(ramSab, vramSab, scratchpadSab);
  }

  switchToShared(): { ramSab: SharedArrayBuffer; vramSab: SharedArrayBuffer; scratchpadSab: SharedArrayBuffer } {
    const ramSab        = new SharedArrayBuffer(MemoryRegion.RAM_SIZE);
    const vramSab       = new SharedArrayBuffer(MemoryRegion.VRAM_SIZE);
    const scratchpadSab = new SharedArrayBuffer(MemoryRegion.SCRATCHPAD_SIZE);
    new Uint8Array(ramSab).set(this.ram);
    new Uint8Array(vramSab).set(this.vram);
    new Uint8Array(scratchpadSab).set(this.scratchpad);
    this.ram        = new Uint8Array(ramSab);
    this.vram       = new Uint8Array(vramSab);
    this.scratchpad = new Uint8Array(scratchpadSab);
    this.ramView        = new DataView(ramSab);
    this.vramView       = new DataView(vramSab);
    this.scratchpadView = new DataView(scratchpadSab);
    return { ramSab, vramSab, scratchpadSab };
  }

  get ramSab(): SharedArrayBuffer { return this.ram.buffer as SharedArrayBuffer; }
  get vramSab(): SharedArrayBuffer { return this.vram.buffer as SharedArrayBuffer; }
  get scratchpadSab(): SharedArrayBuffer { return this.scratchpad.buffer as SharedArrayBuffer; }

  // ── raw buffer access (for bulk loads) ──────────────────────────────────

  get ramBuffer(): Uint8Array { return this.ram; }
  get vramBuffer(): Uint8Array { return this.vram; }

  // ── address classification ─────────────────────────────────────────────

  private static isHwio(addr: number): boolean {
    return addr >= MemoryRegion.HWIO_START && addr < MemoryRegion.HWIO_END;
  }

  private static isKernelRom(addr: number): boolean {
    return addr >= MemoryRegion.KERNEL_ROM_START && addr < MemoryRegion.KERNEL_ROM_END;
  }

  /**
   * Returns true if `vaddr` is inside a mapped region that could hold valid
   * executable code or data — mirrors PPSSPP's Memory::IsValidAddress().
   *
   * Accepted regions (physical address after stripping mirror bits):
   *   • RAM          [RAM_START, RAM_START + RAM_SIZE)
   *   • Scratchpad   [SCRATCHPAD_START, SCRATCHPAD_START + SCRATCHPAD_SIZE)
   *   • VRAM         [VRAM_START, VRAM_START + VRAM_SIZE)
   */
  isValidAddress(vaddr: number): boolean {
    const phys = toPhysical(vaddr);
    return (
      (phys >= MemoryRegion.RAM_START &&
       phys <  MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) ||
      (phys >= MemoryRegion.SCRATCHPAD_START &&
       phys <  MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) ||
      (phys >= MemoryRegion.VRAM_START &&
       phys <  MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE)
    );
  }

  /** True if `vaddr` is inside RAM (not VRAM or scratchpad). */
  isRamAddress(vaddr: number): boolean {
    const phys = toPhysical(vaddr);
    return phys >= MemoryRegion.RAM_START &&
           phys <  MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE;
  }

  // ── bulk read / write (for DMA-like transfers) ──────────────────────────

  /**
   * Copy `byteCount` bytes starting at `vaddr` into a new `Uint8Array`.
   * When the range falls entirely within a single region the underlying
   * typed-array `subarray` + `slice` path is used; otherwise a byte loop
   * falls back gracefully.
   */
  readBytes(vaddr: number, byteCount: number): Uint8Array {
    const addr  = toPhysical(vaddr);
    const end   = addr + byteCount;

    if (
      addr >= MemoryRegion.RAM_START &&
      end  <= MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE
    ) {
      const off = addr - MemoryRegion.RAM_START;
      return this.ram.slice(off, off + byteCount);
    }
    if (
      addr >= MemoryRegion.VRAM_START &&
      end  <= MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE
    ) {
      const off = addr - MemoryRegion.VRAM_START;
      return this.vram.slice(off, off + byteCount);
    }
    if (
      addr >= MemoryRegion.SCRATCHPAD_START &&
      end  <= MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE
    ) {
      const off = addr - MemoryRegion.SCRATCHPAD_START;
      return this.scratchpad.slice(off, off + byteCount);
    }

    // Cross-region or unmapped — slow path
    const out = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i++) {
      out[i] = this.readU8(vaddr + i);
    }
    return out;
  }

  /**
   * Write all bytes of `data` to `vaddr`.
   * Uses `set()` for a single typed-array copy when the range fits in one region.
   */
  writeBytes(vaddr: number, data: Uint8Array): void {
    const addr  = toPhysical(vaddr);
    const end   = addr + data.length;

    if (
      addr >= MemoryRegion.RAM_START &&
      end  <= MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE
    ) {
      this.ram.set(data, addr - MemoryRegion.RAM_START);
      return;
    }
    if (
      addr >= MemoryRegion.VRAM_START &&
      end  <= MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE
    ) {
      this.vram.set(data, addr - MemoryRegion.VRAM_START);
      return;
    }
    if (
      addr >= MemoryRegion.SCRATCHPAD_START &&
      end  <= MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE
    ) {
      this.scratchpad.set(data, addr - MemoryRegion.SCRATCHPAD_START);
      return;
    }

    // Cross-region or unmapped — slow path
    for (let i = 0; i < data.length; i++) {
      this.writeU8(vaddr + i, data[i]!);
    }
  }

  // ── public read API ──────────────────────────────────────────────────────

  readU8(vaddr: number): number {
    const addr = toPhysical(vaddr);

    if (addr >= MemoryRegion.RAM_START &&
        addr <  MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      return this.ram[addr - MemoryRegion.RAM_START]!;
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr <  MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      return this.vram[addr - MemoryRegion.VRAM_START]!;
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr <  MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
      return this.scratchpad[addr - MemoryRegion.SCRATCHPAD_START]!;
    }
    if (MemoryBus.isHwio(addr)) return 0;
    if (MemoryBus.isKernelRom(addr)) return 0;

    return 0; // unmapped — return 0 like real hardware
  }

  readU16(vaddr: number): number {
    const addr = toPhysical(vaddr);

    if (addr >= MemoryRegion.RAM_START &&
        addr + 1 < MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      return this.ramView.getUint16(addr - MemoryRegion.RAM_START, true);
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr + 1 < MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      return this.vramView.getUint16(addr - MemoryRegion.VRAM_START, true);
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr + 1 < MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
      return this.scratchpadView.getUint16(addr - MemoryRegion.SCRATCHPAD_START, true);
    }
    if (MemoryBus.isHwio(addr)) return 0;
    if (MemoryBus.isKernelRom(addr)) return 0;

    return 0; // unmapped — return 0 like real hardware
  }

  readU32(vaddr: number): number {
    const addr = toPhysical(vaddr);

    if (addr >= MemoryRegion.RAM_START &&
        addr + 3 < MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      return this.ramView.getUint32(addr - MemoryRegion.RAM_START, true) >>> 0;
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr + 3 < MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      return this.vramView.getUint32(addr - MemoryRegion.VRAM_START, true) >>> 0;
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr + 3 < MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
      return this.scratchpadView.getUint32(addr - MemoryRegion.SCRATCHPAD_START, true) >>> 0;
    }
    if (MemoryBus.isHwio(addr)) return 0;
    if (MemoryBus.isKernelRom(addr)) return 0;

    return 0; // unmapped — return 0 like real hardware
  }

  // ── public write API ─────────────────────────────────────────────────────

  writeU8(vaddr: number, value: number): void {
    const addr = toPhysical(vaddr);

    if (addr >= MemoryRegion.RAM_START &&
        addr <  MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      this.ram[addr - MemoryRegion.RAM_START] = value & 0xff;
      return;
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr <  MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      this.vram[addr - MemoryRegion.VRAM_START] = value & 0xff;
      return;
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr <  MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
      this.scratchpad[addr - MemoryRegion.SCRATCHPAD_START] = value & 0xff;
      return;
    }
    if (MemoryBus.isHwio(addr)) return; // silently drop
    if (MemoryBus.isKernelRom(addr)) return; // silently drop

    return; // unmapped — silently drop like real hardware
  }

  writeU16(vaddr: number, value: number): void {
    const addr = toPhysical(vaddr);

    if (addr >= MemoryRegion.RAM_START &&
        addr + 1 < MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      this.ramView.setUint16(addr - MemoryRegion.RAM_START, value, true);
      return;
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr + 1 < MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      this.vramView.setUint16(addr - MemoryRegion.VRAM_START, value, true);
      return;
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr + 1 < MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
      this.scratchpadView.setUint16(addr - MemoryRegion.SCRATCHPAD_START, value, true);
      return;
    }
    if (MemoryBus.isHwio(addr)) return;
    if (MemoryBus.isKernelRom(addr)) return;

    return; // unmapped — silently drop
  }

  writeU32(vaddr: number, value: number): void {
    const addr = toPhysical(vaddr);

    if (this.watchWriteAddr && addr === this.watchWriteAddr) {
      this.onWatchWrite?.(vaddr, value);
    }

    if (addr >= MemoryRegion.RAM_START &&
        addr + 3 < MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      this.ramView.setUint32(addr - MemoryRegion.RAM_START, value, true);
      return;
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr + 3 < MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      this.vramView.setUint32(addr - MemoryRegion.VRAM_START, value, true);
      return;
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr + 3 < MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
      this.scratchpadView.setUint32(addr - MemoryRegion.SCRATCHPAD_START, value, true);
      return;
    }
    if (MemoryBus.isHwio(addr)) return;
    if (MemoryBus.isKernelRom(addr)) return;

    return; // unmapped — silently drop
  }
}
