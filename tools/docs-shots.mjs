/**
 * Capture screenshots for the docs with Playwright (driving installed Chrome).
 *
 * Prereq: the app dev server must be running. Point BASE_URL at it.
 *   npm run dev                                   # app on :5173
 *   BASE_URL=http://localhost:5173 npm run docs:shots
 *
 * With no ISO it captures the emulator's own screens: the landing prompt and the
 * boot-options form. Pass ISO_URL to also boot a game and capture the running
 * emulator: a gameplay frame (cropped to the canvas) plus the debug panel and one
 * image per section. Game footage in these images is fine (it shows the emulator
 * actually working, like any emulator's docs). Shots crop to the relevant element
 * rather than the whole window so they look clean. The one thing that must never
 * be committed is the game itself, so stage the ISO somewhere gitignored
 * (public/*.iso is) and delete it after.
 *
 *   cp game.iso public/_shot.iso
 *   ISO_URL=/_shot.iso BASE_URL=http://localhost:5173 npm run docs:shots
 *   rm public/_shot.iso
 *
 * Output: docs/public/screenshots/*.png (served by VitePress at /screenshots/).
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5173";
const ISO_URL = process.env.ISO_URL || "";
// How long to let the game run before the in-game shots. Commercial games show
// publisher/middleware splashes for the first several seconds, so bump this
// (e.g. READY_MS=22000) to let a game reach its menu before the gameplay frame.
const READY_MS = Number(process.env.READY_MS) || 8000;
const OUT = path.resolve("docs/public/screenshots");
mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome", headless: true });
// deviceScaleFactor 1 captures at CSS size; bumping it to 2 would double every
// image's pixel dimensions (retina). Keep it at 1 so the docs images stay small.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [page error]", m.text()); });

async function shotPage(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("captured", name);
}
async function shotEl(name, selector) {
  await page.locator(selector).screenshot({ path: `${OUT}/${name}.png` });
  console.log("captured", name, `(${selector})`);
}

try {
  console.log("opening", BASE);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("game-library", { timeout: 15000 });
  await wait(1000); // let fonts + wave background settle

  // 1. Landing: the "select a games folder" prompt, before any folder is loaded.
  await shotPage("landing");

  // Load a games folder to reach the boot-options screen (renderer / resolution /
  // audio). The folder load routes straight to options.
  const GAMES_DIR = process.env.GAMES_DIR || "test/fixtures";
  try {
    await page.setInputFiles("#file-input-dir", path.resolve(GAMES_DIR));
    await page.waitForSelector("#boot-btn", { timeout: 20000 });
    await wait(1200);
    // 2. The boot-options form: renderer, resolution, audio.
    await shotPage("options");
  } catch (e) {
    console.log("  options shot skipped:", e.message);
  }

  // 3. Optional in-game shots: boot a game (set ISO_URL to a path the dev server
  // serves, e.g. ISO_URL=/_shot.iso; the ?iso= autoloader boots it without UI
  // clicks) and capture the running emulator. We take a gameplay frame plus the
  // debug panel and its sections. Every shot crops to its element (the canvas, the
  // panel) rather than the whole window, so they look clean, not because we are
  // hiding the game.
  if (ISO_URL) {
    try {
      await page.goto(`${BASE}/?iso=${ISO_URL}`, { waitUntil: "load" });
      // The autoloader lands on the boot-options screen; start the game the same
      // way the app's own ?homebrew autoloader does (click the boot button by id).
      await page.waitForSelector("#boot-btn", { timeout: 30000 });
      await wait(500);
      // Enable the profiler before booting so the Performance and GE-draw-stats
      // sections have live data to show.
      await page.evaluate(() => { const c = document.getElementById("profiler-chk"); if (c) c.checked = true; });
      await page.evaluate(() => document.getElementById("boot-btn")?.click());
      // Wait for gameplay: the canvas gets a real size once the game is running.
      await page.waitForFunction(() => {
        const c = document.getElementById("psp-canvas");
        return !!c && c.getBoundingClientRect().width > 0;
      }, { timeout: 30000 });
      await wait(READY_MS); // let the game reach a menu / gameplay (see READY_MS)
      // Gameplay frame: crop to the canvas, so it is a clean rendered game frame
      // (no surrounding window chrome). Taken before the debug sidebar opens.
      await shotEl("gameplay", "#psp-canvas");
      // Open the debug sidebar directly via its open class. The Debug button is in
      // the gameplay HUD (hidden until revealed); the sub-panels populate on the
      // next tick once the class is set.
      await page.evaluate(() => document.getElementById("debug-panel")?.classList.add("debug-sidebar--open"));
      await wait(3000);
      await shotEl("debug-panel", "#debug-panel");

      // Per-section shots: each sub-panel's inner <section>, since these pages
      // document the panel sections. The sub-panel host tags are display:contents
      // (no box of their own), so target the section inside. Playwright CSS pierces
      // the shadow.
      const sections = [
        ["panel-performance",   "perf-panel section"],
        ["panel-ge-draw-stats", "gldraw-panel section"],
        ["panel-threads",       "threads-panel section"],
        ["panel-memory",        "memory-panel section"],
        ["panel-ge",            "ge-panel section"],
        ["panel-save-data",     "savedata-panel section"],
        ["panel-save-state",    "savestate-panel section"],
        ["panel-stubs",         "stubs-panel section"],
        ["panel-logs",          "log-panel section"],
      ];
      for (const [name, sel] of sections) {
        try {
          const loc = page.locator(sel);
          await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
          await wait(300);
          await loc.screenshot({ path: `${OUT}/${name}.png` });
          console.log("captured", name, `(${sel})`);
        } catch (e) {
          console.log("  skipped", name, ":", e.message);
        }
      }
    } catch (e) {
      console.log("  debug-panel shots skipped:", e.message);
    }
  }

} finally {
  await browser.close();
}
console.log("done →", OUT);
