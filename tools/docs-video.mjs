/**
 * Record a short gameplay clip for the docs with Playwright, then transcode to
 * mp4 with ffmpeg. Video only (no audio).
 *
 * It boots a game, loads a save state (so it drops straight into the action with
 * no waiting), records the <canvas> via MediaRecorder, streams the webm chunks
 * out to disk, and runs ffmpeg to produce an H.264 mp4.
 *
 * The dev server must be running (point BASE_URL at it). The ISO and the state
 * file are local inputs, like the screenshots tool: never commit either.
 *
 *   npm run dev
 *   ISO_URL=/ridge-racer.iso \
 *   STATE=~/Downloads/ULUS10001-v1-webgl-2026-06-18_204257-replay.pspstate \
 *   SECONDS=60 OUT=docs/public/videos/ridge-racer.mp4 \
 *   node tools/docs-video.mjs
 */
import { chromium } from "playwright";
import { readFileSync, createWriteStream, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const BASE = process.env.BASE_URL || "http://localhost:5173";
const ISO_URL = process.env.ISO_URL || "/ridge-racer.iso";
const STATE = (process.env.STATE || "").replace(/^~/, os.homedir());
const SECONDS = Number(process.env.SECONDS) || 60;
const OUT = path.resolve(process.env.OUT || "docs/public/videos/ridge-racer.mp4");
const FPS = Number(process.env.FPS) || 60;
const RES = Number(process.env.RES) || 3; // WebGL render scale (3x = 1440x816 backing store)
const RENDERER = process.env.RENDERER || "webgl"; // "webgl" or "software"
const CRF = Number(process.env.CRF) || 25; // x264 quality (higher = smaller file)
const HOLD_KEY = process.env.HOLD_KEY || ""; // key code held down while recording, e.g. ArrowLeft
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!STATE) { console.error("set STATE=<path to .pspstate>"); process.exit(1); }
mkdirSync(path.dirname(OUT), { recursive: true });
const webmPath = path.join(os.tmpdir(), "docs-video.webm");
const webm = createWriteStream(webmPath);

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [err]", m.text().slice(0, 140)); });

// chunks stream from the page to here as they are produced
await page.exposeFunction("__videoSink", (b64) => webm.write(Buffer.from(b64, "base64")));

try {
  console.log("booting", ISO_URL, RENDERER === "software" ? "(software)" : `(WebGL ${RES}x)`);
  await page.goto(`${BASE}/?iso=${ISO_URL}`, { waitUntil: "load" });
  await page.waitForSelector("#boot-btn", { timeout: 30000 });
  // Set the renderer and (for WebGL) the render scale on the boot-options form
  // before booting. Software always renders at native 480x272, so scale is ignored.
  await page.evaluate(({ renderer, res }) => {
    const r = document.getElementById("renderer-select");
    if (r) { r.value = renderer; r.dispatchEvent(new Event("change", { bubbles: true })); }
    const s = document.getElementById("resolution-select");
    if (s) { s.value = String(res); s.dispatchEvent(new Event("change", { bubbles: true })); }
  }, { renderer: RENDERER, res: RES });
  await page.evaluate(() => document.getElementById("boot-btn")?.click());
  await page.waitForFunction(() => {
    const c = document.getElementById("psp-canvas");
    return !!c && c.getBoundingClientRect().width > 0;
  }, { timeout: 30000 });
  // Frame skip defaults to Auto, which drops rendered frames; force it Off so the
  // recording gets every frame.
  await page.evaluate(() => document.querySelector('[data-frameskip="off"]')?.click());
  await wait(2500);

  console.log("loading state", path.basename(STATE));
  const b64 = readFileSync(STATE).toString("base64");
  await page.evaluate(async (b64) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await window._dbgEmu.loadState(bytes);
  }, b64);
  await wait(1000); // let the replay settle into motion

  console.log(`recording ${SECONDS}s ...`);
  await page.evaluate((fps) => {
    const canvas = document.getElementById("psp-canvas");
    const stream = canvas.captureStream(fps);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9" : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    rec.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      const buf = new Uint8Array(await e.data.arrayBuffer());
      let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      window.__videoSink(btoa(s));
    };
    rec.start(1000); // flush a chunk every second
    window.__rec = rec;
  }, FPS);

  // Hold an input down for the whole recording (e.g. ArrowLeft to walk the
  // character). The emulator listens for keydown/keyup on window.
  if (HOLD_KEY) { await page.locator("#psp-canvas").focus().catch(() => {}); await page.keyboard.down(HOLD_KEY); }
  await wait(SECONDS * 1000);
  if (HOLD_KEY) await page.keyboard.up(HOLD_KEY);

  await page.evaluate(() => new Promise((res) => {
    const rec = window.__rec; rec.onstop = res; rec.stop();
  }));
  await wait(500);
} finally {
  await browser.close();
}
await new Promise((res) => webm.end(res));
console.log("webm:", webmPath, (statSync(webmPath).size / 1e6).toFixed(1), "MB");

console.log("transcoding to", OUT);
execFileSync("ffmpeg", [
  "-y", "-i", webmPath,
  "-an",                       // no audio
  "-c:v", "libx264", "-preset", "slow", "-crf", String(CRF),
  "-pix_fmt", "yuv420p",       // broad browser compatibility
  "-movflags", "+faststart",   // web streaming
  OUT,
], { stdio: ["ignore", "ignore", "inherit"] });
console.log("done:", OUT, (statSync(OUT).size / 1e6).toFixed(1), "MB");
