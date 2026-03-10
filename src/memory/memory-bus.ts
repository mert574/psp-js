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
  private readonly ram:        Uint8Array;
  private readonly vram:       Uint8Array;
  private readonly scratchpad: Uint8Array;

  // Pre-allocated DataViews for fast multi-byte access
  private readonly ramView:        DataView;
  private readonly vramView:       DataView;
  private readonly scratchpadView: DataView;

  constructor() {
    this.ram        = new Uint8Array(MemoryRegion.RAM_SIZE);
    this.vram       = new Uint8Array(MemoryRegion.VRAM_SIZE);
    this.scratchpad = new Uint8Array(MemoryRegion.SCRATCHPAD_SIZE);

    this.ramView        = new DataView(this.ram.buffer);
    this.vramView       = new DataView(this.vram.buffer);
    this.scratchpadView = new DataView(this.scratchpad.buffer);
  }

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
        addr <  MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      return this.ramView.getUint16(addr - MemoryRegion.RAM_START, true);
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr <  MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      return this.vramView.getUint16(addr - MemoryRegion.VRAM_START, true);
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr <  MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
      return this.scratchpadView.getUint16(addr - MemoryRegion.SCRATCHPAD_START, true);
    }
    if (MemoryBus.isHwio(addr)) return 0;
    if (MemoryBus.isKernelRom(addr)) return 0;

    return 0; // unmapped — return 0 like real hardware
  }

  readU32(vaddr: number): number {
    const addr = toPhysical(vaddr);

    if (addr >= MemoryRegion.RAM_START &&
        addr <  MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      return this.ramView.getUint32(addr - MemoryRegion.RAM_START, true) >>> 0;
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr <  MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      return this.vramView.getUint32(addr - MemoryRegion.VRAM_START, true) >>> 0;
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr <  MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
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
        addr <  MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      this.ramView.setUint16(addr - MemoryRegion.RAM_START, value, true);
      return;
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr <  MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      this.vramView.setUint16(addr - MemoryRegion.VRAM_START, value, true);
      return;
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr <  MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
      this.scratchpadView.setUint16(addr - MemoryRegion.SCRATCHPAD_START, value, true);
      return;
    }
    if (MemoryBus.isHwio(addr)) return;
    if (MemoryBus.isKernelRom(addr)) return;

    return; // unmapped — silently drop
  }

  writeU32(vaddr: number, value: number): void {
    const addr = toPhysical(vaddr);

    if (addr >= MemoryRegion.RAM_START &&
        addr <  MemoryRegion.RAM_START + MemoryRegion.RAM_SIZE) {
      this.ramView.setUint32(addr - MemoryRegion.RAM_START, value, true);
      return;
    }
    if (addr >= MemoryRegion.VRAM_START &&
        addr <  MemoryRegion.VRAM_START + MemoryRegion.VRAM_SIZE) {
      this.vramView.setUint32(addr - MemoryRegion.VRAM_START, value, true);
      return;
    }
    if (addr >= MemoryRegion.SCRATCHPAD_START &&
        addr <  MemoryRegion.SCRATCHPAD_START + MemoryRegion.SCRATCHPAD_SIZE) {
      this.scratchpadView.setUint32(addr - MemoryRegion.SCRATCHPAD_START, value, true);
      return;
    }
    if (MemoryBus.isHwio(addr)) return;
    if (MemoryBus.isKernelRom(addr)) return;

    return; // unmapped — silently drop
  }
}
