import { chromium } from "playwright";
const BASE = "http://localhost:5199";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(BASE, { waitUntil: "load" });
await page.evaluate(() => localStorage.setItem("psp-js:boot-options",
  JSON.stringify({ "renderer-select": "webgl", "resolution-select": "2", "disable-audio-chk": true, "profiler-chk": false })));
await page.goto(`${BASE}/?iso=gran-turismo.iso`, { waitUntil: "load" });
await page.waitForSelector("#boot-btn", { timeout: 30000 });
// confirm dropdown value BEFORE boot
const selValue = await page.$eval("#renderer-select", el => el.value).catch(() => "n/a");
await page.evaluate(() => document.getElementById("boot-btn")?.click());
await page.waitForFunction(() => !!window._dbgEmu && window._dbgEmu.gameId === "UCES01245", { timeout: 60000 });
await page.waitForTimeout(1500);

const status = await page.evaluate(async () => {
  const e = window._dbgEmu, ge = window._dbgGeRenderer;
  const resp = await fetch("/gt-menu.pspstate");
  await e.loadState(new Uint8Array(await resp.arrayBuffer()), { allowBuildMismatch: true });
  window._dbgStep(8, 1, 0);
  const gp = e.hle.geProcessor || e.hle.ensureGeProcessor?.();
  let glRenderer = "n/a";
  try { const gl = ge.gl; const ext = gl.getExtension("WEBGL_debug_renderer_info"); glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e2) {}
  return {
    dropdown_isSoftware: document.getElementById("renderer-select")?.value === "software",
    dbgGeRendererExists: !!ge,                       // WebGLGERenderer instance
    geProcessor_webglRenderer_set: !!(gp && gp.webglRenderer),  // GE routes to WebGL?
    canvasW: document.getElementById("psp-canvas")?.width,
    glRenderer,
  };
});
console.log(JSON.stringify(status, null, 2));
await page.locator("#psp-canvas").screenshot({ path: "/tmp/wgl_canvas_shot.png" });
console.log("screenshot -> /tmp/wgl_canvas_shot.png");
await browser.close();
