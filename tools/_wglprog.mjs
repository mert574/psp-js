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
  const fbW=r.fbW||512,fbH=r.fbH||272;
  const cv=document.createElement("canvas");cv.width=fbW;cv.height=fbH;const ctx=cv.getContext("2d");
  const grab=()=>{const px=new Uint8Array(fbW*fbH*4);gl.readPixels(0,0,fbW,fbH,gl.RGBA,gl.UNSIGNED_BYTE,px);const img=ctx.createImageData(fbW,fbH);for(let y=0;y<fbH;y++)for(let x=0;x<fbW;x++){const s=((fbH-1-y)*fbW+x)*4,d=(y*fbW+x)*4;img.data[d]=px[s];img.data[d+1]=px[s+1];img.data[d+2]=px[s+2];img.data[d+3]=255;}ctx.putImageData(img,0,0);return cv.toDataURL("image/png");};
  const out=[];let n=0;
  const orig=r.drawPrimitives.bind(r);
  r.drawPrimitives=function(p,verts,state,bus,skip){const ret=orig(p,verts,state,bus,skip);try{let mnY=1e9,mxY=-1e9,mnX=1e9,mxX=-1e9;for(const v of verts){if(v.y<mnY)mnY=v.y;if(v.y>mxY)mxY=v.y;if(v.x<mnX)mnX=v.x;if(v.x>mxX)mxX=v.x;}
    // focused-icon box (enlarged icon): x10-145 y45-190
    if(mxX>10&&mnX<145&&mxY>45&&mnY<190&&out.length<24){if(r.flush)r.flush();const ta=state.texEnable?"0x"+(state.texState.texAddr0>>>0).toString(16):"-";out.push({label:`d${out.length}_n${n}_ta${ta}_x${Math.round(mnX)}-${Math.round(mxX)}_y${Math.round(mnY)}-${Math.round(mxY)}_p${p}`,url:grab()});}
    n++;}catch(er){}return ret;};
  window._dbgStep(1,1,0);
  r.drawPrimitives=orig;
  return out;
});
for(const im of res){writeFileSync(`/tmp/fp_${im.label}.png`,Buffer.from(im.url.split(",")[1],"base64"));}
console.log("wrote",res.length,"images");console.log(res.map(i=>i.label).join("\n"));
await browser.close();
