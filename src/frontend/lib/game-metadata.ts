/** Game metadata: the shape the library renders, a localStorage cache keyed by
 *  file name + size, and extraction from an ISO/PBP file. */
import { extractFromFile } from "../../iso/iso-metadata.js";

export interface GameMeta {
  title: string;
  discId: string;
  iconDataUrl: string | null;
  fileName: string;
  fileSize: number;
}

function cacheKey(name: string, size: number): string {
  return `pspjs:lib:${name}:${size}`;
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
    iconDataUrl: partial.iconDataUrl,
    fileName: file.name,
    fileSize: file.size,
  };
}
