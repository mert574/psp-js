import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SasInstance } from "./sas-core.js";
import type { MemoryBus } from "../memory/memory-bus.js";
function memory() {
 const ram=new Uint8Array(65536),view=new DataView(ram.buffer);
 const bus={readU8:(at:number)=>ram[at]!,readU16:(at:number)=>view.getUint16(at,true),writeU16:(at:number,n:number)=>view.setUint16(at,n,true)} as unknown as MemoryBus;
 return {ram,view,bus};
}
// Captured from synthetic PCM/VAG inputs before replacing the mixer.
const vectors = [[1, 2048, "414b6bab97502cda7fb754fa379f6a9c409b972607709d852fe5360169c212ac"], [1, 4096, "cc02bce3b8b3c6d42cf73f264911dae968b0372bcf638bf56863fbb5b58fdfcf"], [1, 6144, "971583ad5a060ee8febab86b5d3f6443d21f72486ca69a04d25a6cbd4c88b57e"], [1, 16384, "472c4c6338afaca0e97266a758fcda7c95196b5880e43dacbe4f20e1ff04b9c9"], [5, 2048, "5af5fea39ab1ce10a74b7d2fb148da14b5edaabfb3883293c1e5c23dd8eac5b1"], [5, 4096, "31dddf1ebe69d039b3a59e464c7cf9d3ac9c9740d4b9261bb9c54c4257c21060"], [5, 6144, "2640de056c320bb4872c4be0eaedb30d10dbcfbe79069ff7881b4b5d42664726"], [5, 16384, "bb50d9a3b939bd99ab6b293d09b1377489ebf1dc52045cd6ec6f73151182e435"]] as const;
describe("SAS replacement",()=>{
 for(const [type,pitch,expected] of vectors)it(`preserves synthetic type ${type}, pitch ${pitch} across grains`,()=>{
  const {ram,view,bus}=memory();
  for(let n=0;n<4096;n++)view.setInt16(0x100+n*2,Math.floor(Math.sin(n*.17)*16000),true);
  if(type===1)for(let n=0;n<64;n++){ram[0x100+n*16]=((n%5)<<4)|8;ram[0x101+n*16]=n===0?6:n===63?3:0;}
  const sas=new SasInstance();sas.setGrainSize(256);const voice=sas.voices[0]!;
  voice.type=type;voice.pitch=pitch;voice.pcmAddr=voice.vagAddr=0x100;voice.pcmSize=4096;voice.vagSize=1024;voice.loop=true;
  voice.envelope.setRate(15,0x40000000,0x40000000,0,0x800000);voice.envelope.setEnvelope(15,5,5,0,1);voice.envelope.sustainLevel=0x40000000;
  voice.keyOn();const hash=createHash('sha256');
  for(let grain=0;grain<6;grain++){sas.mix(bus,0x4000,0,0x1000,0x1000,false);hash.update(ram.subarray(0x4000,0x4400));}
  expect(hash.digest('hex')).toBe(expected);
 });
 it("keeps paused voices stationary and clips stereo input mixing",()=>{
  const {ram,view,bus}=memory(),sas=new SasInstance(),voice=sas.voices[0]!;
  sas.setGrainSize(64);voice.type=5;voice.pcmAddr=256;voice.pcmSize=64;voice.keyOn();voice.paused=true;
  view.setInt16(4096,30000,true);view.setInt16(4098,-30000,true);
  sas.mix(bus,8192,4096,8192,8192,false);
  expect(voice.pcmIndex).toBe(0);expect(view.getInt16(8192,true)).toBe(32767);expect(view.getInt16(8194,true)).toBe(-32768);
  expect(sas.getEndFlag()&1).toBe(0);
  sas.mix(bus,8192,0,4096,4096,true);expect(ram.subarray(8192,8448).every(v=>v===0)).toBe(true);
 });
});
