/** Test 3D rendering with realistic game vertex formats: indexed triangle strip,
 *  s16 positions. If these render 0 pixels while float-list works, the vertex read
 *  for game formats is the invisible-3D bug. */
import { loadGame } from "../test/helpers/boot-game.js";
import { GEProcessor } from "../src/gpu/ge-processor.js";
const emu = await loadGame("test/fixtures/puzzle-bobble.iso");
const bus = emu.bus;

function setupVP(p: any) {
  p.fbPtr=0x04000000; p.fbWidth=512; p.fbFormat=3;
  p.vpScaleX=240; p.vpCenterX=240; p.vpScaleY=-136; p.vpCenterY=136;
  p.vpScaleZ=65535; p.vpCenterZ=0; p.geOffsetX=0; p.geOffsetY=0;
  p.scissorX1=0; p.scissorY1=0; p.scissorX2=479; p.scissorY2=271;
  p.clearMode=false; p.depthTestEnable=false; p.texEnable=false;
  p.cullEnable=false; p.lightingEnable=false;
  p.materialAmbient=0xffffffff; p.materialAlpha=255;
}
function countVram(): number {
  const v = bus.vramBuffer; let n=0;
  for (let i=0;i<272*512*4;i+=4) if (v[i]||v[i+1]||v[i+2]||v[i+3]) n++;
  return n;
}
function clearVram(){ bus.vramBuffer.fill(0); }

// Scenario A: indexed (u16) triangle list, float pos, color8888.
{
  const p = new GEProcessor(bus) as any; setupVP(p);
  p.vtypeRaw = (3<<7)|(7<<2)|(2<<11); // float pos, color8888, u16 index
  const VADDR=0x08200000, IADDR=0x08210000;
  const dv=new DataView(new ArrayBuffer(16*3));
  const vs=[[-0.5,-0.5,0],[0.5,-0.5,0],[0,0.5,0]];
  for(let i=0;i<3;i++){dv.setUint32(i*16,0xffffffff,true);dv.setFloat32(i*16+4,vs[i][0],true);dv.setFloat32(i*16+8,vs[i][1],true);dv.setFloat32(i*16+12,vs[i][2],true);}
  for(let i=0;i<48;i++) bus.writeU8(VADDR+i,dv.getUint8(i));
  for(const [j,idx] of [0,1,2].entries()) bus.writeU16(IADDR+j*2,idx);
  p.vertexAddr=VADDR; p.indexAddr=IADDR;
  clearVram(); p.doPrim((3<<16)|3);
  console.log(`A indexed-u16 float-list: ${countVram()} px`);
}

// Scenario B: s16 positions, non-indexed, triangle list.
{
  const p = new GEProcessor(bus) as any; setupVP(p);
  p.vtypeRaw = (2<<7)|(7<<2); // s16 pos, color8888
  const VADDR=0x08220000;
  // s16 pos: try raw integer coords scaled to NDC range. PSP s16 pos in transform mode.
  const vs=[[-100,-100,0],[100,-100,0],[0,100,0]];
  let off=0;
  function wU32(a:number,v:number){bus.writeU32(a,v);}
  for(let i=0;i<3;i++){
    wU32(VADDR+off,0xffffffff); off+=4; // color
    bus.writeU16(VADDR+off, vs[i][0]&0xffff); off+=2;
    bus.writeU16(VADDR+off, vs[i][1]&0xffff); off+=2;
    bus.writeU16(VADDR+off, vs[i][2]&0xffff); off+=2;
    off=(off+1)&~1; // align to 2
  }
  p.vertexAddr=VADDR;
  clearVram(); p.doPrim((3<<16)|3);
  console.log(`B s16-pos list (coords ±100): ${countVram()} px`);
}

// Scenario C: triangle STRIP, float pos.
{
  const p = new GEProcessor(bus) as any; setupVP(p);
  p.vtypeRaw=(3<<7)|(7<<2);
  const VADDR=0x08230000;
  const vs=[[-0.5,-0.5,0],[0.5,-0.5,0],[-0.3,0.5,0],[0.6,0.5,0]];
  for(let i=0;i<4;i++){bus.writeU32(VADDR+i*16,0xffffffff);bus.writeU8(VADDR+i*16,0xff);
    const dv=new DataView(new ArrayBuffer(12));dv.setFloat32(0,vs[i][0],true);dv.setFloat32(4,vs[i][1],true);dv.setFloat32(8,vs[i][2],true);
    for(let k=0;k<12;k++)bus.writeU8(VADDR+i*16+4+k,dv.getUint8(k));}
  p.vertexAddr=VADDR;
  clearVram(); p.doPrim((4<<16)|4); // tristrip, 4 verts
  console.log(`C tristrip float: ${countVram()} px`);
}
