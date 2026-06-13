/**
 * PSP Virtual Filesystem — wraps the flat fileData map with path resolution,
 * CWD tracking, and directory enumeration matching PPSSPP's MetaFileSystem.
 */

export interface PspFileInfo {
  exists: boolean;
  isDirectory: boolean;
  name: string;       // basename only
  size: number;
  /** ISO start sector (LBN). Games read it from SceIoStat st_private[0]
   *  (PPSSPP __IoGetStat: stat->st_private[0] = info.startSector) and open
   *  raw "disc0:/sce_lbnN_sizeM" paths computed from it. */
  startSector?: number | undefined;
}

export class PspFileSystem {
  /** Per-thread CWD: threadId → absolute path like "disc0:/PSP_GAME/USRDIR" */
  private currentDir = new Map<number, string>();
  private startingDirectory = "disc0:/";
  /** Directories created via sceIoMkdir or registered as existing */
  private readonly knownDirs = new Set<string>();
  /** Device aliases (lowercase, with trailing ':') set via sceIoAssign, e.g. "fatms0:" → "ms0:" */
  private readonly deviceAliases = new Map<string, string>([["fatms0:", "ms0:"]]);

  constructor(private readonly fileData: Map<string, Uint8Array>) {}

  /** Start sectors by lowercase path, recorded when an ISO is mounted. */
  private readonly sectors = new Map<string, number>();
  /** Directory extent {sector,size} by lowercase path (for catalog walkers). */
  private readonly dirExtents = new Map<string, { sector: number; size: number }>();
  /** Raw disc reader for sce_lbn opens (lbn, byte size) → bytes, when the
   *  mount has the full image available (node harness or in-memory ISO). */
  private discReader: ((lbn: number, size: number) => Uint8Array | null) | null = null;

  setFileSector(path: string, lbn: number): void {
    this.sectors.set(path.toLowerCase(), lbn);
  }

  setDirExtent(path: string, sector: number, size: number): void {
    this.dirExtents.set(path.toLowerCase(), { sector, size });
  }

  setDiscReader(reader: (lbn: number, size: number) => Uint8Array | null): void {
    this.discReader = reader;
  }

  /** Read raw disc bytes for a sce_lbn open, or undefined if no reader. */
  readDiscSectors(lbn: number, size: number): Uint8Array | undefined {
    return this.discReader?.(lbn, size) ?? undefined;
  }

  /**
   * Set the starting (default) working directory.
   * Also registers the directory and all its parents as known directories.
   */
  setStartingDirectory(dir: string): void {
    this.startingDirectory = dir;
    // Register this directory and all parent directories as known
    this._registerDirAndParents(dir);
  }

  /** Register an additional directory as known/existing. */
  registerDirectory(dir: string): void {
    this._registerDirAndParents(dir);
  }

  /**
   * Create a directory. Tracks it so getFileInfo/getDirListing recognise it.
   * Returns 0 on success.
   */
  mkDir(path: string, threadId: number): number {
    const resolved = this.resolvePath(path, threadId);
    this._registerDirAndParents(resolved);
    return 0;
  }

  /** Register a directory path and all its ancestor directories as known (case-insensitive). */
  private _registerDirAndParents(dir: string): void {
    const colonIdx = dir.indexOf(":");
    if (colonIdx < 0) return;
    const lower = dir.toLowerCase();
    const device = lower.substring(0, colonIdx + 1);
    const rest = lower.substring(colonIdx + 1).replace(/^\/+/, "").replace(/\/+$/, "");

    // Register device root
    this.knownDirs.add(device);

    // Register each ancestor
    const parts = rest.split("/").filter(p => p.length > 0);
    for (let i = 1; i <= parts.length; i++) {
      this.knownDirs.add(device + "/" + parts.slice(0, i).join("/"));
    }
  }

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
    // Apply assigned device aliases (e.g. fatms0: → ms0:)
    const aliasColon = path.indexOf(":");
    if (aliasColon >= 0) {
      const dev = path.substring(0, aliasColon + 1).toLowerCase();
      const target = this.deviceAliases.get(dev);
      if (target) path = target + path.substring(aliasColon + 1);
    }

    let device: string;
    let rest: string;
    const colonIdx = path.indexOf(":");
    if (colonIdx >= 0) {
      // Absolute path: extract device prefix
      device = path.substring(0, colonIdx + 1).toLowerCase();
      rest = path.substring(colonIdx + 1);
    } else {
      // No device prefix — use current device from CWD
      const cwd = this.currentDir.get(threadId) ?? this.startingDirectory;
      const cwdColon = cwd.indexOf(":");
      device = cwdColon >= 0 ? cwd.substring(0, cwdColon + 1).toLowerCase() : "disc0:";
      if (path.startsWith("/")) {
        // Absolute from device root (e.g. "/PSP/GAME")
        rest = path;
      } else {
        // Relative path: prepend CWD
        const cwdRest = cwdColon >= 0 ? cwd.substring(cwdColon + 1) : cwd;
        rest = cwdRest + "/" + path;
      }
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

    // PSP represents device root as "ms0:" not "ms0:/"
    if (resolved.length === 0) return device;
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

  /** Current working directory for a thread (falls back to the starting directory). */
  getCwd(threadId: number): string {
    return this.currentDir.get(threadId) ?? this.startingDirectory;
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
        return { exists: true, isDirectory: false, name: parts[parts.length - 1]!, size: data.byteLength, startSector: this.sectors.get(resolvedLower) };
      }
    }

    // Check if it's a directory: any file starts with resolved + "/"
    const dirPrefix = resolvedLower.endsWith("/") ? resolvedLower : resolvedLower + "/";
    for (const key of this.fileData.keys()) {
      if (key.toLowerCase().startsWith(dirPrefix)) {
        const parts = resolved.split("/");
        const ext = this.dirExtents.get(resolvedLower.replace(/\/$/, ""));
        return { exists: true, isDirectory: true, name: parts[parts.length - 1]! || "", size: ext?.size ?? 0, startSector: ext?.sector };
      }
    }

    // Check known directories (created via sceIoMkdir or registered)
    if (this.knownDirs.has(resolvedLower)) {
      const parts = resolved.split("/");
      return { exists: true, isDirectory: true, name: parts[parts.length - 1]! || "", size: 0 };
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
   * Write file data by path, replacing any existing file (case-insensitive).
   * Registers the parent directories as known. Returns the resolved key used.
   */
  writeFile(path: string, data: Uint8Array, threadId: number): string {
    const resolved = this.resolvePath(path, threadId);
    const resolvedLower = resolved.toLowerCase();
    // Replace an existing key regardless of its stored case, else add a new one.
    for (const key of this.fileData.keys()) {
      if (key.toLowerCase() === resolvedLower) {
        this.fileData.set(key, data);
        return key;
      }
    }
    this.fileData.set(resolved, data);
    const slash = resolved.lastIndexOf("/");
    if (slash > 0) this._registerDirAndParents(resolved.substring(0, slash));
    return resolved;
  }

  /** Remove a file by path (case-insensitive). Returns true if it existed. */
  removeFile(path: string, threadId: number): boolean {
    const resolvedLower = this.resolvePath(path, threadId).toLowerCase();
    for (const key of this.fileData.keys()) {
      if (key.toLowerCase() === resolvedLower) {
        this.fileData.delete(key);
        return true;
      }
    }
    return false;
  }

  /**
   * Rename a file or directory. For a directory, moves every file underneath it.
   * Returns the list of {from, to} resolved keys actually moved (empty if the
   * source didn't exist) so the caller can update persistent storage.
   */
  rename(oldPath: string, newPath: string, threadId: number): Array<{ from: string; to: string }> {
    const oldResolved = this.resolvePath(oldPath, threadId);
    const oldLower = oldResolved.toLowerCase();
    const moves: Array<{ from: string; to: string }> = [];

    // PSP rename takes a bare new name when old and new share a directory,
    // but also accepts a full path. resolvePath handles the full-path case;
    // for a bare name, keep the source's parent directory.
    let newResolved = this.resolvePath(newPath, threadId);
    if (!newPath.includes("/") && !newPath.includes(":")) {
      const slash = oldResolved.lastIndexOf("/");
      newResolved = slash >= 0 ? oldResolved.substring(0, slash + 1) + newPath : newResolved;
    }

    // Exact file match
    for (const [key, data] of this.fileData) {
      if (key.toLowerCase() === oldLower) {
        this.fileData.delete(key);
        this.fileData.set(newResolved, data);
        const slash = newResolved.lastIndexOf("/");
        if (slash > 0) this._registerDirAndParents(newResolved.substring(0, slash));
        moves.push({ from: key, to: newResolved });
        return moves;
      }
    }

    // Directory move: relocate every file under oldResolved + "/"
    const dirPrefix = oldLower.endsWith("/") ? oldLower : oldLower + "/";
    const toMove: Array<[string, Uint8Array]> = [];
    for (const [key, data] of this.fileData) {
      if (key.toLowerCase().startsWith(dirPrefix)) toMove.push([key, data]);
    }
    for (const [key, data] of toMove) {
      const suffix = key.substring(dirPrefix.length);
      const newKey = (newResolved.endsWith("/") ? newResolved : newResolved + "/") + suffix;
      this.fileData.delete(key);
      this.fileData.set(newKey, data);
      moves.push({ from: key, to: newKey });
    }
    if (moves.length > 0) this._registerDirAndParents(newResolved);
    return moves;
  }

  /** Remove a directory. Fails (returns false) if it still contains files. */
  rmDir(path: string, threadId: number): boolean {
    const resolved = this.resolvePath(path, threadId);
    const resolvedLower = resolved.toLowerCase();
    const dirPrefix = resolvedLower.endsWith("/") ? resolvedLower : resolvedLower + "/";
    for (const key of this.fileData.keys()) {
      if (key.toLowerCase().startsWith(dirPrefix)) return false; // not empty
    }
    return this.knownDirs.delete(resolvedLower);
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
        // Direct child file. startSector must be set: games (God of War) read
        // the directory to build a catalog, then open each file raw via
        // sce_lbn<startSector>. PPSSPP fills st_private[0] per Dread entry; a 0
        // here makes the game fall back to named opens and shifts its whole heap.
        results.push({ exists: true, isDirectory: false, name: relative, size: data.byteLength, startSector: this.sectors.get(keyLower) });
      } else {
        // Subdirectory — extract first component
        const dirName = relative.substring(0, slashIdx);
        const dirNameLower = dirName.toLowerCase();
        if (!seenDirs.has(dirNameLower)) {
          seenDirs.add(dirNameLower);
          const ext = this.dirExtents.get(dirPrefix + dirNameLower);
          results.push({ exists: true, isDirectory: true, name: dirName, size: ext?.size ?? 0, startSector: ext?.sector });
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
