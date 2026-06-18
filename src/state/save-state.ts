/**
 * Shared constants and types for the save-state orchestration.
 *
 * The actual snapshot/restore logic lives on PSPEmulator (saveState/loadState)
 * because it needs every subsystem. This file only holds the section names and
 * the shape of the structured JSON section so both sides agree.
 *
 * What a save state captures: CPU registers, all RAM/VRAM/scratchpad, the
 * CoreTiming queue, the whole HLE kernel (threads, sync primitives, GE lists,
 * callbacks, allocator, open files, ATRAC decode buffers, vtimers, fonts), and
 * GE render state. A state is bound to a game by disc id + EBOOT hash and does
 * NOT contain the game itself, so restoring needs the same game booted first.
 *
 * Known best-effort gaps (everything else restores exactly):
 *  - In-progress MPEG/PSMF video. WebCodecs decoders keep internal frame state
 *    that JS can't read or rebuild, so a snapshot taken mid-cutscene resumes by
 *    re-seeking the logical cursor and may glitch one frame. Fine for the main
 *    use (debugging gameplay), not for frame-exact video capture.
 *  - The Web Audio AudioContext is not serialized; audio resumes from the
 *    restored channel/decode state, so a tiny blip on restore is possible.
 *  - Fonts: the standard flash0 PGF set is reloaded on restore, but a font
 *    opened from a game-specific path via sceFontOpenUserFile is not recovered.
 *  - hle-ctrl latch accumulation, hle-net sockets, and hle-power callback slots
 *    have no state port yet (add one with registerStateModule if a game needs it).
 */

import type { CpuScalars } from "../cpu/cpu.js";
import type { RegisterScalars } from "../cpu/registers.js";
import type { CoreTimingState } from "../timing/core-timing.js";
import type { KernelStateV1 } from "../kernel/hle-kernel.js";
import type { GeProcessorState } from "../gpu/ge-processor.js";

/** Binary container section names (raw or gzipped bytes). */
export const SECTION = {
  RAM: "ram",
  VRAM: "vram",
  SCRATCHPAD: "scratchpad",
  CPUREGS: "cpuregs",
  STATE: "state", // utf-8 JSON of SnapshotJson, gzipped
} as const;

/** The structured (non-bulk) machine state, stored as gzipped JSON. */
export interface SnapshotJson {
  /** Format version (SAVESTATE_FORMAT_VERSION) the state was written with. The
   *  same value is in the container header for cheap reads. */
  schema: number;
  cpu: CpuScalars;
  regs: RegisterScalars;
  coreTiming: CoreTimingState;
  kernel: KernelStateV1;
  /** Null when no GE processor existed yet (game never drew). */
  ge: GeProcessorState | null;
  emu: EmulatorScalars;
}

/** Small bits of PSPEmulator's own run state. */
export interface EmulatorScalars {
  halted: boolean;
}

/**
 * Save-state format version (the "exporter version").
 *
 * This is the number a future migrator reads to know how a given file was
 * written. It is stamped into the container header (so it can be read without
 * decompressing anything) and into the state JSON. Bump it by one whenever the
 * serialized SHAPE changes in a way that an old file would need migrating for:
 * a new / renamed / removed field in any subsystem's state, a change to how a
 * section is encoded, a change to which fields are captured vs reloaded, etc.
 * Pure additive changes that old loaders ignore still get a bump so a migrator
 * can reason about them.
 *
 * This is separate from STATE_VERSION in state-container.ts, which versions the
 * raw container byte framing (magic / header / section layout) and only changes
 * if that envelope changes.
 *
 * Changelog:
 *   1 - initial format: CPU + memory + CoreTiming + full HLE kernel (threads,
 *       sync, GE lists, callbacks, allocator, open files with read-only files
 *       reloaded from the fs, ATRAC decode, vtimers, fonts) + GE render state.
 */
export const SAVESTATE_FORMAT_VERSION = 1;

/**
 * Format versions this build can load. New exports always use the latest
 * (SAVESTATE_FORMAT_VERSION); importing checks membership here and refuses
 * anything else. When a migrator is added it should accept the older version
 * here and upgrade it on load.
 */
export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [1];
