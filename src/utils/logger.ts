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

const isBrowser = typeof window !== "undefined";

const instances = new Map<string, Logger>();
let colorIdx = 0;

export class Logger {
  static minLevel: LogLevel = "info";

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

    const method = level === "debug" ? "debug"
      : level === "info" ? "info"
      : level === "warn" ? "warn" : "error";

    const tag = `[${this.namespace}]`;

    if (isBrowser) {
      const css = `color:${this.color};font-weight:bold`;
      console[method](`%c${tag}%c`, css, "color:inherit", ...args);
    } else {
      console[method](tag, ...args);
    }
  }
}
