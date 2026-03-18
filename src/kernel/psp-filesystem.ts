/**
 * PSP Virtual Filesystem — wraps the flat fileData map with path resolution,
 * CWD tracking, and directory enumeration matching PPSSPP's MetaFileSystem.
 */

export interface PspFileInfo {
  exists: boolean;
  isDirectory: boolean;
  name: string;       // basename only
  size: number;
}

export class PspFileSystem {
  /** Per-thread CWD: threadId → absolute path like "disc0:/PSP_GAME/USRDIR" */
  private currentDir = new Map<number, string>();
  private startingDirectory = "disc0:/";

  constructor(private readonly fileData: Map<string, Uint8Array>) {}

  /**
   * Resolve a PSP path to an absolute normalized path.
   * Mirrors PPSSPP MetaFileSystem::RealPath.
   *
   * - If path contains ':', it's absolute (disc0:/foo/bar)
   * - Otherwise it's relative to the thread's CWD
   * - Handles '.', '..', duplicate slashes, trailing slashes
   * - Normalizes umd0: → disc0:
   */
  resolvePath(rawPath: string, threadId: number): string {
    let path = rawPath;

    // Normalize device aliases (PPSSPP MetaFileSystem.cpp:89)
    path = path.replace(/^umd0:/i, "disc0:");
    path = path.replace(/^umd1:/i, "disc0:");

    let device: string;
    let rest: string;
    const colonIdx = path.indexOf(":");
    if (colonIdx >= 0) {
      // Absolute path: extract device prefix
      device = path.substring(0, colonIdx + 1).toLowerCase();
      rest = path.substring(colonIdx + 1);
    } else {
      // Relative path: prepend CWD
      const cwd = this.currentDir.get(threadId) ?? this.startingDirectory;
      const cwdColon = cwd.indexOf(":");
      device = cwdColon >= 0 ? cwd.substring(0, cwdColon + 1).toLowerCase() : "disc0:";
      const cwdRest = cwdColon >= 0 ? cwd.substring(cwdColon + 1) : cwd;
      rest = cwdRest + "/" + path;
    }

    // Normalize path components: split on /, handle . and .., remove empty
    const parts = rest.split("/").filter(p => p.length > 0 && p !== ".");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return device + "/" + resolved.join("/");
  }

  /**
   * Change directory for a thread. PPSSPP MetaFileSystem::ChDir.
   * Returns 0 on success.
   */
  chDir(dir: string, threadId: number): number {
    const resolved = this.resolvePath(dir, threadId);
    this.currentDir.set(threadId, resolved);
    return 0;
  }

  /**
   * Get file info. Checks files first, then infers directories from
   * the fileData keys. Case-insensitive matching.
   */
  getFileInfo(path: string, threadId: number): PspFileInfo {
    const resolved = this.resolvePath(path, threadId);
    const resolvedLower = resolved.toLowerCase();

    // Check exact file match (case-insensitive)
    for (const [key, data] of this.fileData) {
      if (key.toLowerCase() === resolvedLower) {
        const parts = key.split("/");
        return { exists: true, isDirectory: false, name: parts[parts.length - 1]!, size: data.byteLength };
      }
    }

    // Check if it's a directory: any file starts with resolved + "/"
    const dirPrefix = resolvedLower.endsWith("/") ? resolvedLower : resolvedLower + "/";
    for (const key of this.fileData.keys()) {
      if (key.toLowerCase().startsWith(dirPrefix)) {
        const parts = resolved.split("/");
        return { exists: true, isDirectory: true, name: parts[parts.length - 1]! || "", size: 0 };
      }
    }

    return { exists: false, isDirectory: false, name: "", size: 0 };
  }

  /**
   * Get file data by path with case-insensitive matching.
   * Returns undefined if not found.
   */
  getFileData(path: string, threadId: number): Uint8Array | undefined {
    const resolved = this.resolvePath(path, threadId);
    const resolvedLower = resolved.toLowerCase();
    for (const [key, data] of this.fileData) {
      if (key.toLowerCase() === resolvedLower) return data;
    }
    return undefined;
  }

  /**
   * Get directory listing (direct children only).
   * Returns files and subdirectories. PPSSPP ISOFileSystem::GetDirListing.
   */
  getDirListing(path: string, threadId: number): PspFileInfo[] {
    const resolved = this.resolvePath(path, threadId);
    const dirPrefix = (resolved.endsWith("/") ? resolved : resolved + "/").toLowerCase();
    const results: PspFileInfo[] = [];
    const seenDirs = new Set<string>();

    for (const [key, data] of this.fileData) {
      const keyLower = key.toLowerCase();
      if (!keyLower.startsWith(dirPrefix)) continue;

      const relative = key.substring(dirPrefix.length); // preserves original case
      const slashIdx = relative.indexOf("/");

      if (slashIdx === -1) {
        // Direct child file
        results.push({ exists: true, isDirectory: false, name: relative, size: data.byteLength });
      } else {
        // Subdirectory — extract first component
        const dirName = relative.substring(0, slashIdx);
        const dirNameLower = dirName.toLowerCase();
        if (!seenDirs.has(dirNameLower)) {
          seenDirs.add(dirNameLower);
          results.push({ exists: true, isDirectory: true, name: dirName, size: 0 });
        }
      }
    }

    return results;
  }

  /** Clean up per-thread CWD when thread exits */
  threadEnded(threadId: number): void {
    this.currentDir.delete(threadId);
  }
}
