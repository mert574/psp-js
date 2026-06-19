import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const BASE="http://localhost:5199";
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1100,height:800}});
await page.goto(BASE,{waitUntil:"load"});
await page.evaluate(()=>localStorage.setItem("psp-js:boot-options",JSON.stringify({"renderer-select":"webgl","resolution-select":"2","disable-audio-chk":true,"profiler-chk":false})));
await page.goto(`${BASE}/?iso=gran-turismo.iso`,{waitUntil:"load"});
await page.waitForSelector("#boot-btn",{timeout:30000});
await page.evaluate(()=>document.getElementById("boot-btn")?.click());
await page.waitForFunction(()=>!!window._dbgEmu&&window._dbgEmu.gameId==="UCES01245",{timeout:60000});
await page.waitForTimeout(1500);
const res=await page.evaluate(async()=>{
  const e=window._dbgEmu,r=window._dbgGeRenderer,gl=r.gl;
  await e.loadState(new Uint8Array(await(await fetch("/gt-menu.pspstate")).arrayBuffer()),{allowBuildMismatch:true});
  const SC=2, fbW=r.fbW||1024, fbH=r.fbH||544;
  // focused-icon box screen x12-140 y50-180 -> FBO scale 2
  const SX=12*SC, SW=128*SC, SY=50*SC, SH=130*SC;
  const avg=()=>{const px=new Uint8Array(SW*SH*4);gl.readPixels(SX,fbH-SY-SH,SW,SH,gl.RGBA,gl.UNSIGNED_BYTE,px);let s=0;for(let i=0;i<SW*SH;i++)s+=px[i*4]+px[i*4+1]+px[i*4+2];return Math.round(s/(SW*SH));};
  const grabFull=()=>{const px=new Uint8Array(fbW*fbH*4);gl.readPixels(0,0,fbW,fbH,gl.RGBA,gl.UNSIGNED_BYTE,px);const cv=document.createElement("canvas");cv.width=fbW;cv.height=fbH;const c=cv.getContext("2d");const im=c.createImageData(fbW,fbH);for(let y=0;y<fbH;y++)for(let x=0;x<fbW;x++){const ss=((fbH-1-y)*fbW+x)*4,d=(y*fbW+x)*4;im.data[d]=px[ss];im.data[d+1]=px[ss+1];im.data[d+2]=px[ss+2];im.data[d+3]=255;}c.putImageData(im,0,0);return cv.toDataURL("image/png");};
  const prog=[];let n=0;const dumps=[];
  const orig=r.drawPrimitives.bind(r);
  r.drawPrimitives=function(p,verts,state,bus,skip){const ret=orig(p,verts,state,bus,skip);try{if(r.flush)r.flush();const a=avg();const prev=prog.length?prog[prog.length-1].a:a;const ta=state.texEnable?"0x"+(state.texState.texAddr0>>>0).toString(16):"-";prog.push({n,a,ta});if(prev-a>50){dumps.push({label:`DROP_n${n}_${prev}to${a}_ta${ta}`,url:grabFull(),before:prev,after:a});}n++;}catch(er){}return ret;};
  window._dbgStep(1,1,0);
  r.drawPrimitives=orig;
  return {finalAvg:prog.length?prog[prog.length-1].a:-1, drops:prog.filter((q,i)=>i>0&&prog[i-1].a-q.a>50).map(q=>({n:q.n,a:q.a,ta:q.ta})), dumps};
});
console.log("finalAvg(focused region):", res.finalAvg);
console.log("DROPS:", JSON.stringify(res.drops));
for(const d of res.dumps){writeFileSync(`/tmp/drop_${d.label}.png`,Buffer.from(d.url.split(",")[1],"base64"));}
console.log("dumped",res.dumps.length,"drop images");
await browser.close();
