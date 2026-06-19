import { chromium } from "playwright";
const BASE = "http://localhost:5199";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(BASE, { waitUntil: "load" });
await page.evaluate(() => localStorage.setItem("psp-js:boot-options",
  JSON.stringify({ "renderer-select": "webgl", "resolution-select": "2", "disable-audio-chk": true, "profiler-chk": false })));
await page.goto(`${BASE}/?iso=gran-turismo.iso`, { waitUntil: "load" });
await page.waitForSelector("#boot-btn", { timeout: 30000 });
await page.evaluate(() => document.getElementById("boot-btn")?.click());
await page.waitForFunction(() => !!window._dbgEmu && window._dbgEmu.gameId === "UCES01245", { timeout: 60000 });
await page.waitForTimeout(1500);
// Load the state the SAME way the savedata panel does: clear the WebGL caches
// after restoring, so we don't reproduce a stale-cache artifact the real UI never has.
await page.evaluate(async () => {
  const e = window._dbgEmu, r = window._dbgGeRenderer;
  const r2 = await fetch("/gt-menu.pspstate");
  await e.loadState(new Uint8Array(await r2.arrayBuffer()), { allowBuildMismatch: true });
  r?.invalidateTextures?.();
  r?.clearVFBs?.();
});
for (const [label, steps] of [["f1",1],["f2",1],["f4",2],["f8",4]]) {
  await page.evaluate((n) => window._dbgStep(n,1,0), steps);
  await page.locator("#psp-canvas").screenshot({ path: `/tmp/shot_${label}.png` });
  console.log("shot", label);
}
await browser.close();
