/** Formatting helpers shared across the frontend debug/UI components. */

/** Compact byte size with single-letter units (e.g. "20.8M", "1.5K", "42B"). */
export function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

/** Like fmtSize but with full B/KB/MB suffixes, for places where the bytes sit
 *  next to a count so the unit needs to be unambiguous. */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** A 32-bit value as a zero-padded `0x????????` hex string. */
export function hex8(v: number): string {
  return `0x${(v >>> 0).toString(16).padStart(8, "0")}`;
}

/** Escape text for safe insertion into an innerHTML string (the few panels that
 *  build HTML imperatively rather than via Lit, which auto-escapes). */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
