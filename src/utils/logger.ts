/**
 * Lightweight structured logger with namespaces, colors, and severity levels.
 *
 * Usage:
 *   import { Logger } from "../utils/logger.js";
 *   const log = Logger.get("ELF");
 *   log.info("loaded binary");
 *   log.warn("missing section");
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Distinct colors for browser console (CSS color values)
const COLORS = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
  "#dcbeff", "#9A6324", "#800000", "#aaffc3", "#808000",
  "#000075", "#a9a9a9",
];

const isBrowser = typeof (globalThis as unknown as Window).window !== "undefined";

const instances = new Map<string, Logger>();
let colorIdx = 0;

/** Optional hook called for every `error`-level message. Useful in tests. */
type ErrorHook = (namespace: string, message: string) => void;
let errorHook: ErrorHook | null = null;

/** Optional hook called for every `warn`- or `error`-level message. Used by the debug panel. */
type WarnHook = (level: LogLevel, namespace: string, message: string) => void;
let warnHook: WarnHook | null = null;

export class Logger {
  static minLevel: LogLevel = "info";

  /** Cheap check for hot paths: lets callers skip building expensive
   *  debug message strings when debug logging is off. */
  static get debugEnabled(): boolean {
    return LEVEL_ORDER.debug >= LEVEL_ORDER[Logger.minLevel];
  }

  private readonly color: string;

  private constructor(readonly namespace: string) {
    this.color = COLORS[colorIdx % COLORS.length]!;
    colorIdx++;
  }

  static get(namespace: string): Logger {
    let inst = instances.get(namespace);
    if (!inst) {
      inst = new Logger(namespace);
      instances.set(namespace, inst);
    }
    return inst;
  }

  /** Reset all instances (useful for tests). */
  static reset(): void {
    instances.clear();
    colorIdx = 0;
  }

  /** Install a hook that is called on every error-level log message. */
  static setErrorHook(hook: ErrorHook | null): void {
    errorHook = hook;
  }

  /** Install a hook called for every warn- or error-level message (for live debug panels). */
  static setWarnHook(hook: WarnHook | null): void {
    warnHook = hook;
  }

  debug(...args: unknown[]): void {
    this.log("debug", args);
  }

  info(...args: unknown[]): void {
    this.log("info", args);
  }

  warn(...args: unknown[]): void {
    this.log("warn", args);
  }

  error(...args: unknown[]): void {
    this.log("error", args);
  }

  private log(level: LogLevel, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[Logger.minLevel]) return;

    const tag = `[${this.namespace}]`;

    if (isBrowser) {
      // Always use console.log in the browser to suppress the automatic
      // call-stack annotation that console.error/warn append (which would
      // show logger.ts and the requestAnimationFrame chain on every message).
      const levelBg =
        level === "error" ? "background:#c0392b;color:#fff" :
        level === "warn"  ? "background:#e67e22;color:#fff" :
        level === "debug" ? "background:#555;color:#fff"    : "";
      const nsStyle = `color:${this.color};font-weight:bold`;
      if (levelBg) {
        console.log(`%c${level.toUpperCase()}%c %c${tag}%c`, levelBg, "", nsStyle, "color:inherit", ...args);
      } else {
        console.log(`%c${tag}%c`, nsStyle, "color:inherit", ...args);
      }
    } else {
      const method = level === "debug" ? "debug"
        : level === "info" ? "info"
        : level === "warn" ? "warn" : "error";
      console[method](tag, ...args);
    }

    if (level === "error" && errorHook) {
      errorHook(this.namespace, args.map(String).join(" "));
    }
    if ((level === "warn" || level === "error") && warnHook) {
      warnHook(level, this.namespace, args.map(String).join(" "));
    }
  }
}
