/**
 * Save-state round-trip tests against the known-good puzzle-bobble fixture.
 *
 * These boot a real ISO so they are integration tests (run with the full
 * `npx vitest run`, not the `src/` unit subset).
 */

import { describe, it, expect } from "vitest";
import { loadGame } from "./helpers/boot-game.js";
import { unpackContainer, fnv1a } from "../src/state/state-container.js";
import { SECTION } from "../src/state/save-state.js";

const ISO = "test/fixtures/puzzle-bobble.iso";
const WARMUP_FRAMES = 120;

type Emu = Awaited<ReturnType<typeof loadGame>>;

function runFrames(emu: Emu, n: number): void {
  for (let i = 0; i < n; i++) {
    emu.runFrame();
    if (emu.halted || emu.cpu.stepFaulted) break;
  }
}

/** A signature of the visible machine state, for comparing two runs. */
function signature(emu: Emu): Record<string, number> {
  return {
    pc: emu.cpu.regs.pc,
    vblank: emu.hle.vblankCount,
    ram: fnv1a(emu.bus.ramBuffer),
    vram: fnv1a(emu.bus.vramBuffer),
    gpr: fnv1a(new Uint8Array(emu.cpu.regs.gpr.buffer)),
  };
}

describe("save state round-trip", () => {
  it("restores an identical machine (snapshot, restore, snapshot again)", async () => {
    const emuA = await loadGame(ISO);
    runFrames(emuA, WARMUP_FRAMES);
    const blob1 = await emuA.saveState();

    // Fresh boot of the same game, overlay the state, snapshot again.
    const emuB = await loadGame(ISO);
    await emuB.loadState(blob1);
    const blob2 = await emuB.saveState();

    const c1 = await unpackContainer(blob1);
    const c2 = await unpackContainer(blob2);

    expect(c2.gameId).toBe(c1.gameId);
    expect(c2.contentHash).toBe(c1.contentHash);

    // Bulk binary sections must be byte-identical.
    for (const name of [SECTION.RAM, SECTION.VRAM, SECTION.SCRATCHPAD, SECTION.CPUREGS]) {
      const a = c1.sections.get(name)!;
      const b = c2.sections.get(name)!;
      expect(b.byteLength, `${name} length`).toBe(a.byteLength);
      // Compare via hash-ish quick check first, then full equality.
      expect(Buffer.from(b).equals(Buffer.from(a)), `${name} bytes`).toBe(true);
    }

    // The structured JSON state must be deep-equal after a restore->resave.
    const s1 = JSON.parse(new TextDecoder().decode(c1.sections.get(SECTION.STATE)!));
    const s2 = JSON.parse(new TextDecoder().decode(c2.sections.get(SECTION.STATE)!));
    expect(s2).toEqual(s1);
  });

  it("resumes a live machine that keeps running without faulting", async () => {
    const emuA = await loadGame(ISO);
    runFrames(emuA, WARMUP_FRAMES);
    const vblankAtSave = emuA.hle.vblankCount;
    const blob = await emuA.saveState();

    const emuB = await loadGame(ISO);
    await emuB.loadState(blob);

    expect(emuB.cpu.regs.pc).toBe(emuA.cpu.regs.pc);
    expect(emuB.hle.vblankCount).toBe(vblankAtSave);
    expect(emuB.cpu.stepFaulted).toBe(false);

    // The restored machine must keep advancing frames.
    runFrames(emuB, 30);
    expect(emuB.cpu.stepFaulted).toBe(false);
    expect(emuB.hle.vblankCount).toBeGreaterThan(vblankAtSave);
  });

  it("runs bit-identically after restore vs continuing the original", async () => {
    const emuA = await loadGame(ISO);
    runFrames(emuA, WARMUP_FRAMES);
    const blob = await emuA.saveState();

    // Continue the original past the snapshot point.
    runFrames(emuA, 30);
    const sigOriginal = signature(emuA);

    // Restore into a fresh boot and run the same number of frames.
    const emuB = await loadGame(ISO);
    await emuB.loadState(blob);
    runFrames(emuB, 30);

    // RAM, VRAM, registers, PC, and vblank count must all match exactly.
    expect(signature(emuB)).toEqual(sigOriginal);
  });

  it("refuses a state from a different game build", async () => {
    const emu = await loadGame(ISO);
    runFrames(emu, 10);
    const blob = await emu.saveState();

    // Corrupt the stored EBOOT hash in the container header JSON and rebuild the
    // blob (the header length may change, so re-emit the prefix too).
    const headerLen = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(blob.subarray(12, 12 + headerLen)));
    header.contentHash = (header.contentHash ^ 0xffff) >>> 0;
    const newHeader = new TextEncoder().encode(JSON.stringify(header));
    const rest = blob.subarray(12 + headerLen);
    const prefix = blob.slice(0, 12);
    new DataView(prefix.buffer).setUint32(8, newHeader.byteLength, true);
    const tampered = new Uint8Array(12 + newHeader.byteLength + rest.byteLength);
    tampered.set(prefix, 0);
    tampered.set(newHeader, 12);
    tampered.set(rest, 12 + newHeader.byteLength);

    const emu2 = await loadGame(ISO);
    // Blocked by default (the checks run before any overlay, so emu2 is untouched).
    await expect(emu2.loadState(tampered)).rejects.toThrow(/different build|EBOOT/i);
    // ...but forcing past the build check loads it (only the hash header was changed).
    await expect(emu2.loadState(tampered, { allowBuildMismatch: true })).resolves.toBeUndefined();
  });

  it("refuses a save state with an unsupported format version", async () => {
    const emu = await loadGame(ISO);
    runFrames(emu, 10);
    const blob = await emu.saveState();

    // Bump the header's formatVersion to something this build doesn't support.
    const headerLen = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(blob.subarray(12, 12 + headerLen)));
    header.formatVersion = 99;
    const newHeader = new TextEncoder().encode(JSON.stringify(header));
    const rest = blob.subarray(12 + headerLen);
    const prefix = blob.slice(0, 12);
    new DataView(prefix.buffer).setUint32(8, newHeader.byteLength, true);
    const tampered = new Uint8Array(12 + newHeader.byteLength + rest.byteLength);
    tampered.set(prefix, 0);
    tampered.set(newHeader, 12);
    tampered.set(rest, 12 + newHeader.byteLength);

    const emu2 = await loadGame(ISO);
    await expect(emu2.loadState(tampered)).rejects.toThrow(/not supported|format/i);
  });
});
