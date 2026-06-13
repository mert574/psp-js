/** Test the transform with a realistic PERSPECTIVE projection + view, like a game. */
import { loadGame } from "../test/helpers/boot-game.js";
import { GEProcessor } from "../src/gpu/ge-processor.js";
const emu = await loadGame("test/fixtures/puzzle-bobble.iso");
const p = new GEProcessor(emu.bus) as unknown as Record<string, unknown> & {
  transformVertex: (x:number,y:number,z:number)=>{sx:number;sy:number;sz:number;cw:number;viewZ:number};
};
p.vpScaleX=240; p.vpCenterX=240; p.vpScaleY=-136; p.vpCenterY=136;
p.vpScaleZ=65535; p.vpCenterZ=0; p.geOffsetX=0; p.geOffsetY=0;
// perspective: f=1/tan(45deg)=1, aspect=480/272, near=1, far=1000 (column-major 4x4)
const f=1, aspect=480/272, near=1, far=1000;
p.projMat=new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),-1, 0,0,2*far*near/(near-far),0]);
// view: camera at origin looking down -z (identity view, geometry placed in front)
p.viewMat=new Float32Array([1,0,0, 0,1,0, 0,0,1, 0,0,0]);
p.worldMat=new Float32Array([1,0,0, 0,1,0, 0,0,1, 0,0,0]);
// Test vertices at various view-space depths in FRONT of camera (-z) and behind (+z)
for (const [label,x,y,z] of [["front-z=-5",0,0,-5],["front-z=-100",0,0,-100],["front-off",2,1,-5],["behind-z=+5",0,0,5],["forward+z",0,0,100]] as [string,number,number,number][]) {
  const r = p.transformVertex(x,y,z);
  const on = r.sx>=0&&r.sx<480&&r.sy>=0&&r.sy<272;
  console.log(`${label.padEnd(14)} -> screen(${r.sx.toFixed(1)},${r.sy.toFixed(1)}) z=${r.sz.toFixed(3)} cw=${r.cw.toFixed(2)} onScreen=${on}`);
}
