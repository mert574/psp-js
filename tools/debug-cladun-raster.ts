/** Hook GEProcessor internals to see where cladun's quad dies in the software raster. */
import { loadGame } from "../test/helpers/boot-game.js";
import { Logger } from "../src/utils/logger.js";
Logger.minLevel = "debug";

const emu = await loadGame("public/cladun-rpg.iso");

// warm up so the processor exists
for (let f = 0; f < 30; f++) { emu.runFrame(); await Promise.resolve(); }

const proc = (emu.hle as any).ensureGeProcessor ? (emu.hle as any).ensureGeProcessor() : (emu.hle as any).geProcessor;
console.log("proc:", proc?.constructor?.name, "webgl:", !!proc?.webglRenderer, "skipRaster:", proc?.skipSoftwareRaster);

let pmLog = 0;
const origEC = proc.executeCommand.bind(proc);
proc.executeCommand = (cmd: number, param: number) => {
  if ((cmd === 0x3e || cmd === 0x3f) && pmLog < 40) {
    console.log(`  cmd 0x${cmd.toString(16)} param=0x${param.toString(16).padStart(6, "0")}`);
    pmLog++;
  }
  return origEC(cmd, param);
};

let tvLog = 0;
const origTV = proc.transformVertex.bind(proc);
proc.transformVertex = (x: number, y: number, z: number) => {
  const r = origTV(x, y, z);
  if (tvLog < 4) {
    console.log(`transformVertex(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}) → sx=${r.sx.toFixed(1)} sy=${r.sy.toFixed(1)} sz=${r.sz.toFixed(1)} cw=${r.cw.toFixed(3)}`);
    console.log(`  world=[${[...proc.worldMat].map((v: number) => v.toFixed(2)).join(",")}]`);
    console.log(`  view =[${[...proc.viewMat].map((v: number) => v.toFixed(2)).join(",")}]`);
    console.log(`  proj =[${[...proc.projMat].map((v: number) => v.toFixed(2)).join(",")}]`);
    console.log(`  vp: scale=(${proc.vpScaleX},${proc.vpScaleY},${proc.vpScaleZ}) center=(${proc.vpCenterX},${proc.vpCenterY},${proc.vpCenterZ})`);
    tvLog++;
  }
  return r;
};

let dtLog = 0;
const origDT = proc.drawTriangle.bind(proc);
proc.drawTriangle = (a: any, b: any, c: any) => {
  if (dtLog < 6) {
    console.log(`drawTriangle (${a.x.toFixed(1)},${a.y.toFixed(1)},${a.z?.toFixed(1)}) (${b.x.toFixed(1)},${b.y.toFixed(1)}) (${c.x.toFixed(1)},${c.y.toFixed(1)}) col=0x${(a.color>>>0).toString(16)}`);
    dtLog++;
  }
  return origDT(a, b, c);
};

let dsLog = 0;
const origDS = proc.drawSprite.bind(proc);
proc.drawSprite = (a: any, b: any) => {
  if (dsLog < 6) {
    console.log(`drawSprite (${a.x},${a.y})-(${b.x},${b.y}) col=0x${(a.color>>>0).toString(16)} → 0x${(b.color>>>0).toString(16)} fbPtr=0x${proc.fbPtr.toString(16)}`);
    dsLog++;
  }
  return origDS(a, b);
};

let ppLog = 0;
const origPP = proc.plotPixel.bind(proc);
proc.plotPixel = (...args: any[]) => {
  if (ppLog < 6) { console.log(`plotPixel(${args[0]},${args[1]}, 0x${(args[2]>>>0).toString(16)})`); ppLog++; }
  return origPP(...args);
};

for (let f = 0; f < 30; f++) { emu.runFrame(); await Promise.resolve(); }

console.log(`prims so far: ${(emu.hle as any).gePrimCount}, clears: ${(emu.hle as any).geClearCount}`);
