/**
 * Save-state container format.
 *
 * A save state is a single self-describing blob made of named sections. Some
 * sections are raw bytes (RAM, VRAM, CPU register buffers), one is the big JSON
 * blob with all the structured kernel/GE/timing state. Sections can be gzipped
 * (RAM is mostly zero so it shrinks to a few hundred KB).
 *
 * The format is environment-neutral: a state exported from the browser loads in
 * node and the other way around. gzip uses the Web Streams CompressionStream,
 * which both the browser and node (18+) expose as a global (the same API the
 * PRX loader already relies on for DecompressionStream).
 *
 * Layout (all little-endian):
 *   magic        4 bytes  "PSPS"
 *   version      u32      container version
 *   headerLen    u32      length of the header JSON that follows
 *   headerJSON   headerLen bytes  utf-8 JSON, see ContainerHeader
 *   sectionBytes ...      each section's bytes back to back, in header order
 *
 * The header lists each section name, its codec, and its stored byte length, so
 * the reader can walk the section bytes without any per-section framing.
 */

export const STATE_MAGIC = 0x50535053; // "PSPS" big-endian
export const STATE_VERSION = 1;

export type SectionCodec = "raw" | "gzip";

interface SectionHeader {
  name: string;
  codec: SectionCodec;
  len: number; // stored (possibly compressed) length in bytes
}

interface ContainerHeader {
  /** Container byte-framing version (STATE_VERSION). Versions how to parse the
   *  magic / header / section layout itself. */
  version: number;
  /** Content/exporter version supplied by the caller (SAVESTATE_FORMAT_VERSION).
   *  Lives in the header so a migrator can read it without decompressing any
   *  section. 0 on a file written before this field existed. */
  formatVersion: number;
  /** PSP disc id (e.g. "UCUS98632"), or "" for homebrew with no SFO. */
  gameId: string;
  /** FNV-1a hash of the EBOOT this state was captured from. */
  contentHash: number;
  /** Free-form metadata shown to the user (frame count, timestamp, label). */
  meta: Record<string, unknown>;
  sections: SectionHeader[];
}

/** A section to write. `bytes` are the logical (uncompressed) bytes. */
export interface StateSection {
  name: string;
  codec: SectionCodec;
  bytes: Uint8Array;
}

/** Parsed container. `sections` maps name to decompressed bytes. */
export interface ParsedContainer {
  /** Container byte-framing version. */
  version: number;
  /** Content/exporter version (SAVESTATE_FORMAT_VERSION at write time), for
   *  migrators. 0 if the file predates this field. */
  formatVersion: number;
  gameId: string;
  contentHash: number;
  meta: Record<string, unknown>;
  sections: Map<string, Uint8Array>;
}

// ── gzip helpers (Web Streams, available in browser and node 18+) ───────────

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return streamThrough(new CompressionStream("gzip"), data);
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return streamThrough(new DecompressionStream("gzip"), data);
}

async function streamThrough(stream: GenericTransformStream, data: Uint8Array): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Drive the write side and remember the promise so a compression error (e.g.
  // OOM on a big input) surfaces instead of becoming an unhandled rejection.
  const writeDone = writer.write(data).then(() => writer.close());
  const reader = (stream.readable as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await writeDone;
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// ── pack / unpack ──────────────────────────────────────────────────────────

export interface PackOptions {
  gameId: string;
  contentHash: number;
  /** Content/exporter version to stamp in the header (SAVESTATE_FORMAT_VERSION). */
  formatVersion: number;
  meta?: Record<string, unknown>;
}

/** Build a container blob from sections. Compresses any gzip-codec sections. */
export async function packContainer(opts: PackOptions, sections: StateSection[]): Promise<Uint8Array> {
  const stored: Uint8Array[] = [];
  const headers: SectionHeader[] = [];
  for (const s of sections) {
    const bytes = s.codec === "gzip" ? await gzip(s.bytes) : s.bytes;
    stored.push(bytes);
    headers.push({ name: s.name, codec: s.codec, len: bytes.byteLength });
  }

  const header: ContainerHeader = {
    version: STATE_VERSION,
    formatVersion: opts.formatVersion,
    gameId: opts.gameId,
    contentHash: opts.contentHash >>> 0,
    meta: opts.meta ?? {},
    sections: headers,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  const prefix = new Uint8Array(12);
  const dv = new DataView(prefix.buffer);
  dv.setUint32(0, STATE_MAGIC, false);
  dv.setUint32(4, STATE_VERSION, true);
  dv.setUint32(8, headerBytes.byteLength, true);

  return concat([prefix, headerBytes, ...stored]);
}

/** Parse a container blob. Decompresses gzip sections back to logical bytes. */
export async function unpackContainer(blob: Uint8Array): Promise<ParsedContainer> {
  if (blob.byteLength < 12) throw new Error("save state too small to be valid");
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (dv.getUint32(0, false) !== STATE_MAGIC) throw new Error("not a PSP save state (bad magic)");
  const version = dv.getUint32(4, true);
  const headerLen = dv.getUint32(8, true);

  const headerStart = 12;
  const headerEnd = headerStart + headerLen;
  if (headerEnd > blob.byteLength) throw new Error("save state header is truncated");
  const header = JSON.parse(
    new TextDecoder().decode(blob.subarray(headerStart, headerEnd)),
  ) as ContainerHeader;

  const sections = new Map<string, Uint8Array>();
  let off = headerEnd;
  for (const sh of header.sections) {
    const end = off + sh.len;
    if (end > blob.byteLength) throw new Error(`save state section "${sh.name}" is truncated`);
    const raw = blob.subarray(off, end);
    sections.set(sh.name, sh.codec === "gzip" ? await gunzip(raw) : raw.slice());
    off = end;
  }

  return {
    version,
    formatVersion: header.formatVersion ?? 0,
    gameId: header.gameId,
    contentHash: header.contentHash >>> 0,
    meta: header.meta ?? {},
    sections,
  };
}

/** FNV-1a 32-bit hash, used to bind a state to the exact EBOOT it came from. */
export function fnv1a(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
