/** Does Ridge Racer ever set up 3D state (proj matrix, view matrix, world matrix
 *  loads via GE cmds 0x3A-0x3F) even though it draws 0 transform-mode prims? */
import { loadGame } from "../test/helpers/boot-game.js";
const emu = await loadGame("test/fixtures/ridge-racer.iso");
let wrapped=false; let frame=0;
const cmd = { world:0, view:0, proj:0, xformPrim:0, thruPrim:0 };
function wrap(){const ge=(emu.hle as any).geProcessor; if(!ge||wrapped)return; wrapped=true;
  const oc=ge.executeCommand.bind(ge);
  ge.executeCommand=(op:number,p:number)=>{ if(op===0x3B)cmd.world++; if(op===0x3D)cmd.view++; if(op===0x3F)cmd.proj++; oc(op,p); };
  const op2=ge.doPrim.bind(ge);
  ge.doPrim=(p:number)=>{ if((p&0xffff)>0){ if((ge.vtypeRaw>>>23)&1)cmd.thruPrim++; else cmd.xformPrim++; } op2(p); };
}
for(frame=0; frame<1500 && !emu.halted; frame++){ wrap(); emu.runFrame(); }
console.log(`RR 1500f: worldMatWrites=${cmd.world} viewMatWrites=${cmd.view} projMatWrites=${cmd.proj}`);
console.log(`prims: transform(3D)=${cmd.xformPrim} through(2D)=${cmd.thruPrim}`);
