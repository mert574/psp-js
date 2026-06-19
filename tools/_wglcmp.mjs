import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
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
const fboUrl = await page.evaluate(async () => {
  const e = window._dbgEmu, r = window._dbgGeRenderer, gl = r.gl;
  await e.loadState(new Uint8Array(await (await fetch("/gt-menu.pspstate")).arrayBuffer()), { allowBuildMismatch: true });
  window._dbgStep(1,1,0);
  // grab the GE's FBO (the one it renders into) right after the frame, before any present clobber
  const normFb = r.normFb ? r.normFb.bind(r) : (a)=>a;
  const vfb = r.vfbs.get(normFb(0x04000000>>>0));
  const fbW=r.fbW||512, fbH=r.fbH||272;
  gl.bindFramebuffer(gl.FRAMEBUFFER, vfb?vfb.fbo:null);
  const px=new Uint8Array(fbW*fbH*4); gl.readPixels(0,0,fbW,fbH,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const cv=document.createElement("canvas"); cv.width=fbW; cv.height=fbH; const ctx=cv.getContext("2d");
  const img=ctx.createImageData(fbW,fbH);
  for(let y=0;y<fbH;y++)for(let x=0;x<fbW;x++){const s=((fbH-1-y)*fbW+x)*4,d=(y*fbW+x)*4;img.data[d]=px[s];img.data[d+1]=px[s+1];img.data[d+2]=px[s+2];img.data[d+3]=255;}
  ctx.putImageData(img,0,0); return cv.toDataURL("image/png");
});
writeFileSync("/tmp/cmp_GEFBO.png", Buffer.from(fboUrl.split(",")[1],"base64"));
await page.locator("#psp-canvas").screenshot({ path: "/tmp/cmp_CANVAS.png" });
console.log("wrote /tmp/cmp_GEFBO.png and /tmp/cmp_CANVAS.png (same frame 1)");
await browser.close();
