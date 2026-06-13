/** Drive Ridge Racer via the real inputSnapshot path; tap Circle (JP confirm) and
 *  occasionally Start/dirs, watch for the first transform-mode (3D) prim. */
import { loadGame } from "../test/helpers/boot-game.js";
const emu = await loadGame("test/fixtures/ridge-racer.iso");
const B = { Start:0x8, Up:0x10, Right:0x20, Down:0x40, Left:0x80, Circle:0x2000, Cross:0x4000 };
let frame=0, total3D=0, total2D=0, first3D=-1;
let wrapped=false;
function wrap(){const ge=(emu.hle as any).geProcessor; if(!ge||wrapped)return; wrapped=true;
  const o=ge.doPrim.bind(ge); ge.doPrim=(p:number)=>{ if((p&0xffff)>0){ if((ge.vtypeRaw>>>23)&1)total2D++; else {total3D++; if(first3D<0){first3D=frame; console.log(`FIRST 3D prim at frame ${frame}!`);}}} o(p);};}
// real input path: override inputSnapshot to return buttons by frame
const seq = [B.Start, B.Circle, B.Cross, B.Circle, B.Down, B.Circle, B.Right, B.Circle, B.Up, B.Circle];
(emu.hle as any).inputSnapshot = () => {
  let buttons = 0;
  if (frame > 300) { const phase = frame % 90; if (phase < 6) buttons = seq[Math.floor(frame/90) % seq.length]!; }
  return { buttons, analog: { x: 0, y: 0 } };
};
for(frame=0; frame<4000 && !emu.halted; frame++){ wrap(); emu.runFrame();
  if(frame%500===0) console.log(`frame ${frame}: 3D=${total3D} 2D=${total2D}`);
}
console.log(`DONE halted=${emu.halted} total3D=${total3D} total2D=${total2D} first3D@${first3D}`);
