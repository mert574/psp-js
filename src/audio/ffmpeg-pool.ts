/**
 * FFmpegPool — Reusable pool of FFmpeg WASM instances for parallel decoding.
 *
 * Each FFmpeg WASM instance is single-threaded and not re-entrant.
 * This pool manages up to `maxSize` instances, lazily creating them on demand
 * and queuing callers when all are busy.
 *
 * Usage:
 *   const pool = new FFmpegPool(6);
 *   const result = await pool.exec(async (ff) => {
 *     await ff.writeFile("in.at3", data);
 *     await ff.exec(["-i", "in.at3", "-f", "s16le", "out.raw"]);
 *     return await ff.readFile("out.raw");
 *   });
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

const DEFAULT_CORE_VERSION = "0.12.10";

export interface FFmpegPoolOptions {
  /** Max concurrent instances (default: 6) */
  maxSize?: number;
  /** FFmpeg core version on jsdelivr CDN (default: "0.12.10") */
  coreVersion?: string;
  /** Custom core URL (overrides coreVersion) */
  coreURL?: string;
  /** Custom WASM URL (overrides coreVersion) */
  wasmURL?: string;
}

interface PoolEntry {
  ff: FFmpeg;
  ready: Promise<void>;
  busy: boolean;
}

export class FFmpegPool {
  private readonly maxSize: number;
  private readonly entries: PoolEntry[] = [];
  private readonly waitQueue: Array<(entry: PoolEntry) => void> = [];
  private coreURLPromise: Promise<string> | null = null;
  private wasmURLPromise: Promise<string> | null = null;

  constructor(opts: FFmpegPoolOptions = {}) {
    this.maxSize = opts.maxSize ?? 6;
    const version = opts.coreVersion ?? DEFAULT_CORE_VERSION;
    const base = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${version}/dist/esm`;

    if (opts.coreURL) {
      this.coreURLPromise = Promise.resolve(opts.coreURL);
    } else {
      this.coreURLPromise = toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript");
    }
    if (opts.wasmURL) {
      this.wasmURLPromise = Promise.resolve(opts.wasmURL);
    } else {
      this.wasmURLPromise = toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm");
    }
  }

  /** Current pool size (created instances, may include busy ones). */
  get size(): number { return this.entries.length; }

  /** Number of instances currently in use. */
  get busy(): number { return this.entries.filter(e => e.busy).length; }

  /** Number of callers waiting for a free instance. */
  get waiting(): number { return this.waitQueue.length; }

  /**
   * Execute a callback with an exclusive FFmpeg instance.
   * Acquires from pool, runs the callback, then releases back.
   * If all instances are busy and pool is at max, waits for one to free up.
   */
  async exec<T>(fn: (ff: FFmpeg) => Promise<T>): Promise<T> {
    const entry = await this._acquire();
    try {
      return await fn(entry.ff);
    } finally {
      this._release(entry);
    }
  }

  /**
   * Get a raw FFmpeg instance for callers that need direct access.
   * Prefer `exec()` for automatic release.
   */
  async getInstance(): Promise<FFmpeg> {
    if (this.entries.length === 0) {
      const entry = await this._createEntry();
      return entry.ff;
    }
    await this.entries[0]!.ready;
    return this.entries[0]!.ff;
  }

  /** Terminate all pool instances. */
  terminate(): void {
    for (const entry of this.entries) {
      try { entry.ff.terminate(); } catch { /* ignore */ }
    }
    this.entries.length = 0;
    this.waitQueue.length = 0;
  }

  private async _createEntry(): Promise<PoolEntry> {
    const ff = new FFmpeg();
    const ready = Promise.all([this.coreURLPromise!, this.wasmURLPromise!])
      .then(([coreURL, wasmURL]) => ff.load({ coreURL, wasmURL }))
      .then(() => {});
    const entry: PoolEntry = { ff, ready, busy: false };
    this.entries.push(entry);
    await ready;
    return entry;
  }

  private async _acquire(): Promise<PoolEntry> {
    // Try to reuse a free entry
    for (const entry of this.entries) {
      if (!entry.busy) {
        entry.busy = true;
        await entry.ready;
        return entry;
      }
    }
    // Create new if under limit
    if (this.entries.length < this.maxSize) {
      const entry = await this._createEntry();
      entry.busy = true;
      return entry;
    }
    // Wait for one to free up
    return new Promise(resolve => this.waitQueue.push(resolve));
  }

  private _release(entry: PoolEntry): void {
    entry.busy = false;
    const next = this.waitQueue.shift();
    if (next) {
      entry.busy = true;
      next(entry);
    }
  }
}
