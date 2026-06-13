/** Drive Ridge Racer with input toward car-select; report when 3D prims appear. */
import { loadGame, PspButton } from "../test/helpers/boot-game.js";
const emu = await loadGame("test/fixtures/ridge-racer.iso");
let wrapped=false; let frame=0;
let total3D=0, total2D=0; const first3DFrame={v:-1};
function wrap(){const ge=(emu.hle as any).geProcessor; if(!ge||wrapped)return; wrapped=true;
  const o=ge.doPrim.bind(ge); ge.doPrim=(p:number)=>{const vc=p&0xffff; if(vc>0){const t=(ge.vtypeRaw>>>23)&1; if(t)total2D++; else {total3D++; if(first3DFrame.v<0)first3DFrame.v=frame;}} o(p);};}
// input schedule: tap Circle, then Cross, then Start, repeatedly with gaps (JP confirm=Circle)
const taps=[PspButton.Circle, PspButton.Cross, PspButton.Start, PspButton.Down, PspButton.Circle, PspButton.Right, PspButton.Circle];
let ti=0;
const ctrl=(emu.hle as any);
function setBtns(b:number){ if(ctrl.setButtons) ctrl.setButtons(b); else if(ctrl.padButtons!==undefined) ctrl.padButtons=b; }
for(frame=0; frame<3000 && !emu.halted; frame++){
  wrap();
  // every 120 frames, press the next button for 8 frames
  const phase = frame % 120;
  if(frame>420 && phase<8) setBtns(taps[ti % taps.length]!);
  else { setBtns(0); if(phase===8 && frame>420) ti++; }
  emu.runFrame();
  if(frame%300===0) console.log(`frame ${frame}: 3D=${total3D} 2D=${total2D} (btn idx ${ti%taps.length})`);
}
console.log(`DONE halted=${emu.halted} total3D=${total3D} total2D=${total2D} first3D@frame=${first3DFrame.v}`);
