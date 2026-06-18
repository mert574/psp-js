/**
 * PBP (PlayStation Portable Binary Package) container parser.
 *
 * PBP is the package format used by PSP homebrews. It bundles several
 * sub-files at fixed offsets described in an 8-entry offset table.
 *
 * Header layout:
 *   0x00  magic     (4)  — 0x00504250 ("\x00PBP")
 *   0x04  version   (4)  — little-endian
 *   0x08  offset[0] (4)  — PARAM.SFO
 *   0x0C  offset[1] (4)  — ICON0.PNG
 *   0x10  offset[2] (4)  — ICON1.PMF
 *   0x14  offset[3] (4)  — PIC0.PNG
 *   0x18  offset[4] (4)  — PIC1.PNG
 *   0x1C  offset[5] (4)  — SND0.AT3
 *   0x20  offset[6] (4)  — data.psp  ← the ELF/PRX executable
 *   0x24  offset[7] (4)  — data.psar ← encrypted resource archive
 *
 * The size of each sub-file is (offset[i+1] - offset[i]).
 * The last entry's size is (totalFileSize - offset[7]).
 */

const PBP_MAGIC   = 0x50425000; // bytes [00 50 42 50] as little-endian uint32
const PARAM_SFO_IDX = 0;        // index of PARAM.SFO in the offset table
const DATA_PSP_IDX = 6;         // index of data.psp in the offset table

export interface PbpContents {
  /** The raw data.psp bytes (ELF or PRX executable). */
  dataPsp: Uint8Array;
  /** The PARAM.SFO bytes, or null if the PBP has none. Homebrew keeps its disc
   *  id / title here rather than at disc0:/PSP_GAME/PARAM.SFO. */
  paramSfo: Uint8Array | null;
  /** ICON0.PNG — the static game icon, or null. */
  icon0: Uint8Array | null;
  /** ICON1.PMF — the animated icon video, or null. */
  icon1Pmf: Uint8Array | null;
  /** PIC0.PNG — the logo overlay, or null. */
  pic0: Uint8Array | null;
  /** PIC1.PNG — the background art, or null. */
  pic1: Uint8Array | null;
  /** SND0.AT3 — the menu audio, or null. */
  snd0: Uint8Array | null;
}

/**
 * Returns true if `data` begins with the PBP magic bytes.
 */
export function isPbp(data: Uint8Array): boolean {
  if (data.byteLength < 4) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint32(0, true) === PBP_MAGIC;
}

/**
 * Parses a PBP file and returns its contents.
 * Throws if the magic is wrong or the header is truncated.
 */
export function parsePbp(data: Uint8Array): PbpContents {
  if (data.byteLength < 0x28) {
    throw new Error("PBP file too short to contain a valid header.");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const magic = view.getUint32(0x00, true);
  if (magic !== PBP_MAGIC) {
    throw new Error(`Not a PBP file (magic=0x${magic.toString(16).padStart(8, "0")})`);
  }

  const offsets: number[] = [];
  for (let i = 0; i < 8; i++) {
    offsets.push(view.getUint32(0x08 + i * 4, true));
  }

  const dataPspOffset = offsets[DATA_PSP_IDX]!;
  const dataPspEnd    = offsets[DATA_PSP_IDX + 1] ?? data.byteLength;
  const dataPspSize   = dataPspEnd - dataPspOffset;

  if (dataPspSize <= 0 || dataPspOffset + dataPspSize > data.byteLength) {
    throw new Error("PBP data.psp region is empty or out of bounds.");
  }

  // Extract an optional section by index (start = offset[i], end = offset[i+1]).
  const section = (i: number): Uint8Array | null => {
    const start = offsets[i]!;
    const end   = offsets[i + 1] ?? data.byteLength;
    const size  = end - start;
    return size > 0 && start + size <= data.byteLength ? data.slice(start, start + size) : null;
  };

  return {
    dataPsp: data.slice(dataPspOffset, dataPspOffset + dataPspSize),
    paramSfo: section(PARAM_SFO_IDX),
    icon0:    section(1),
    icon1Pmf: section(2),
    pic0:     section(3),
    pic1:     section(4),
    snd0:     section(5),
  };
}
