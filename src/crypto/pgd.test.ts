import { describe, expect, it } from "vitest";
import { createDecipheriv, createCipheriv } from "node:crypto";
import { pgdOpen, pgdDecryptBlock } from "./amctrl.js";
import { keyvault } from "./kirk-keys.js";
import { kirkCreate, kirkInit } from "./kirk.js";
import { referenceCmac } from "./test-packets.js";
const bytes=(hex:string):Uint8Array=>new Uint8Array(Buffer.from(hex,'hex'));
const xor=(a:Uint8Array,b:Uint8Array):Uint8Array=>a.map((v,i)=>v^b[i]!);
const constants=[bytes('e350ed1d910a1fd029bb1c3ef34077fb'),bytes('135fa47cab395ba476b8cca98f3a0445'),bytes('678d7fa32a9ca0d1508ad8385e4b017e')];
function crypt(data:Uint8Array,slot:number,decrypt:boolean):Uint8Array {
 const cipher=decrypt?createDecipheriv('aes-128-cbc',keyvault[slot]!,new Uint8Array(16)):createCipheriv('aes-128-cbc',keyvault[slot]!,new Uint8Array(16));
 cipher.setAutoPadding(false);return new Uint8Array(Buffer.concat([cipher.update(data),cipher.final()]));
}
function stream(data:Uint8Array,headerKey:Uint8Array,versionKey:Uint8Array,first:number):Uint8Array {
 const nonce=xor(crypt(xor(xor(headerKey,versionKey),constants[2]!),0x39,true),constants[1]!);
 const blocks=new Uint8Array(data.length),view=new DataView(blocks.buffer);
 for(let at=0;at<data.length;at+=16){blocks.set(nonce.subarray(0,12),at);view.setUint32(at+12,first+at/16+1,true);}
 const mask=crypt(blocks,0x63,true);
 if(first){new DataView(nonce.buffer).setUint32(12,first,true);for(let i=0;i<16;i++)mask[i]!^=nonce[i]!;}
 return xor(data,mask);
}
function fixture(mode:1|3,blockSize=32){
 const data=new Uint8Array(0x90),view=new DataView(data.buffer);
 const versionKey=new Uint8Array(16).fill(17),headerKey=new Uint8Array(16).fill(31),dataKey=new Uint8Array(16).fill(47);
 view.setUint32(4,mode===3?2:1,true);view.setUint32(8,1,true);data.set(headerKey,0x10);
 const descriptor=new Uint8Array(48),dv=new DataView(descriptor.buffer);descriptor.set(dataKey);dv.setUint32(0x14,96,true);dv.setUint32(0x18,blockSize,true);dv.setUint32(0x1c,0x90,true);
 data.set(stream(descriptor,headerKey,versionKey,0),0x30);
 const makeTag=(input:Uint8Array,key:Uint8Array):Uint8Array=>{const tag=crypt(xor(xor(referenceCmac(input,keyvault[0x38]!),constants[0]!),key),0x38,false);return mode===3?crypt(tag,0x63,false):tag;};
 data.set(makeTag(data.subarray(0,0x70),versionKey),0x70);
 data.set(makeTag(data.subarray(0,0x80),bytes('2774fbeba4a001d702569e338c195783')),0x80);
 return {data,versionKey,dataKey};
}
describe('synthetic PGD containers',()=>{
 for(const mode of [1,3] as const)it(`authenticates mode ${mode}, derives its key, and decrypts a later block`,()=>{
  const {data,versionKey,dataKey}=fixture(mode),state=kirkCreate();kirkInit(state);
  const container=new Uint8Array(data.length+7);container.set(data,7);
  const pgd=pgdOpen(state,container,7,1,null)!;expect(pgd).not.toBeNull();expect(pgd.vkey).toEqual(versionKey);expect(pgd.dkey).toEqual(dataKey);
  expect([pgd.dataSize,pgd.blockSize,pgd.blockNr]).toEqual([96,32,3]);
  const plain=Uint8Array.from({length:32},(_,i)=>i*3);pgd.blockBuf.set(stream(plain,dataKey,versionKey,4));
  expect(pgdDecryptBlock(state,pgd,2)).toBe(32);expect(pgd.blockBuf.subarray(0,32)).toEqual(plain);
  expect(pgdOpen(state,data.slice(),0,1,versionKey)).not.toBeNull();
  expect(pgdOpen(state,data.slice(),0,1,new Uint8Array(16))).toBeNull();
  const bad=data.slice();bad[0x40]!^=1;expect(pgdOpen(state,bad,0,1,null)).toBeNull();
 });
 it('rejects truncated headers, unsupported fuse keys and invalid block sizes',()=>{
  const state=kirkCreate();kirkInit(state);expect(pgdOpen(state,new Uint8Array(20),0,1,null)).toBeNull();
  expect(pgdOpen(state,fixture(1,0).data,0,1,null)).toBeNull();
  const bad=fixture(1).data;new DataView(bad.buffer).setUint32(8,2,true);expect(pgdOpen(state,bad,0,1,null)).toBeNull();
 });
});
