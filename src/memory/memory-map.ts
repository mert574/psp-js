/**
 * PSP Memory Map
 *
 * The PSP uses a MIPS-based virtual address space. Key regions:
 *
 *   0x00000000 - 0x001FFFFF  Scratchpad RAM (not really — scratchpad is at 0x00010000)
 *   0x00010000 - 0x00013FFF  Scratchpad RAM (16 KB, fast SRAM on-chip)
 *   0x04000000 - 0x041FFFFF  VRAM (2 MB)
 *   0x08000000 - 0x0BFFFFFF  Main RAM (64 MB, PSP-2000/3000 Slim)
 *   0x1C000000 - 0x1FBFFFFF  Hardware I/O registers
 *   0x1FC00000 - 0x1FFFFFFF  Kernel ROM (BIOS)
 *   0x88000000 - 0x89FFFFFF  Kernel RAM mirror (cached)
 *
 * Addresses can have top bits set for cache/uncached access:
 *   kseg0: 0x80000000 - cached kernel
 *   kseg1: 0xA0000000 - uncached kernel
 * We mask these off when doing physical lookups.
 */

export const MemoryRegion = {
  SCRATCHPAD_START: 0x00010000,
  SCRATCHPAD_SIZE:  0x00004000, // 16 KB

  VRAM_START:       0x04000000,
  VRAM_SIZE:        0x00200000, // 2 MB

  RAM_START:        0x08000000,
  RAM_SIZE:         0x04000000, // 64 MB (PSP-2000+ / Slim)

  HWIO_START:       0x1C000000,
  HWIO_END:         0x1FC00000, // HW I/O registers end (0x1C000000–0x1FBFFFFF)

  KERNEL_ROM_START: 0x1FC00000,
  KERNEL_ROM_END:   0x20000000, // Kernel ROM / BIOS (0x1FC00000–0x1FFFFFFF)
} as const;

/** Strip kseg0/kseg1 top bits to get the physical address. */
export function toPhysical(addr: number): number {
  return addr & 0x1fffffff;
}
