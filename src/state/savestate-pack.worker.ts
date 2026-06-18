/**
 * Save-state packing worker.
 *
 * The main thread captures the snapshot (it has to, the emulator lives there)
 * and hands the raw, uncompressed sections here. This worker runs the gzip and
 * builds the final container, so a big export (tens of MB compressed) doesn't
 * freeze the UI. The section buffers and the result are transferred, not copied.
 */

import { packContainer, type StateSection, type SectionCodec } from "./state-container.js";

interface PackRequest {
  gameId: string;
  contentHash: number;
  formatVersion: number;
  meta: Record<string, unknown>;
  sections: { name: string; codec: SectionCodec; bytes: ArrayBuffer }[];
}

self.onmessage = async (e: MessageEvent<PackRequest>) => {
  const { gameId, contentHash, formatVersion, meta, sections } = e.data;
  try {
    const secs: StateSection[] = sections.map(s => ({
      name: s.name,
      codec: s.codec,
      bytes: new Uint8Array(s.bytes),
    }));
    const blob = await packContainer({ gameId, contentHash, formatVersion, meta }, secs);
    // Transfer the result buffer back so it isn't copied across the boundary.
    (self as unknown as Worker).postMessage({ ok: true, blob: blob.buffer }, [blob.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
