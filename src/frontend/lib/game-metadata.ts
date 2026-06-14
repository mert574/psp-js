/** Game metadata: the shape the library renders, a localStorage cache keyed by
 *  file name + size, and extraction from an ISO/PBP file. */
import { extractFromFile } from "../../iso/iso-metadata.js";

export interface GameMeta {
  title: string;
  discId: string;
  region: string;
  version: string;
  parentalLevel: number;
  saveTitle: string;
  saveDetail: string;
  iconDataUrl: string | null;
  fileName: string;
  fileSize: number;
}

// v3: added save title/detail (v2 added region/version/rating); bumping the
// key re-extracts older cached entries that miss the newer fields.
function cacheKey(name: string, size: number): string {
  return `pspjs:lib3:${name}:${size}`;
}

export function getCachedMeta(name: string, size: number): GameMeta | null {
  try {
    const raw = localStorage.getItem(cacheKey(name, size));
    if (!raw) return null;
    const meta = JSON.parse(raw) as GameMeta;
    // Invalidate cache entries from an old version that lack icons/titles.
    if (!meta.iconDataUrl && meta.title === name.replace(/\.[^.]+$/, "")) return null;
    return meta;
  } catch {
    return null;
  }
}

export function setCachedMeta(meta: GameMeta): void {
  try {
    localStorage.setItem(cacheKey(meta.fileName, meta.fileSize), JSON.stringify(meta));
  } catch { /* quota exceeded — non-fatal */ }
}

/** Read title / disc id / icon from an ISO or PBP file. */
export async function extractIsoMetadata(file: File): Promise<GameMeta> {
  const partial = await extractFromFile(file);
  return {
    title: partial.title,
    discId: partial.discId,
    region: partial.region,
    version: partial.version,
    parentalLevel: partial.parentalLevel,
    saveTitle: partial.saveTitle,
    saveDetail: partial.saveDetail,
    iconDataUrl: partial.iconDataUrl,
    fileName: file.name,
    fileSize: file.size,
  };
}
