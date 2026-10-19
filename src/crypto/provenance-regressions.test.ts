import { describe, expect, it } from "vitest";
import { createCipheriv, createHash } from "node:crypto";
import { shaInit, shaUpdate, shaFinal } from "./sha1.js";
import { kirkCreate, kirkInit, kirkSceUtilsBufferCopyWithRange as command } from "./kirk.js";
import { aesCbcEncrypt, aesCbcDecrypt, kirkCMD1, kirkCMD10 } from "../loader/kirk.js";
import { syntheticKirkPacket } from "./test-packets.js";
describe("replacement crypto regressions",()=>{
  it("matches SHA-1 across padding boundaries and arbitrary update slices",()=>{
    for(const length of [0,1,55,56,63,64,65,127,128,129,1000000]){
      const input=Uint8Array.from({length},(_,i)=>i*17&255), state=shaInit();
      for(let at=0;at<length;at+=37)shaUpdate(state,input,at,Math.min(37,length-at));
      const result=new Uint8Array(24).fill(0xaa);shaFinal(result,2,state);
      expect(Buffer.from(result.subarray(2,22)).toString("hex")).toBe(createHash("sha1").update(input).digest("hex"));
      expect([result[0],result[23]]).toEqual([0xaa,0xaa]);
    }
  });
  it("handles nonzero CBC IVs and preserves trailing bytes",async()=>{
    const key=new Uint8Array(16).fill(4),iv=new Uint8Array(16).fill(7),data=Uint8Array.from({length:48},(_,i)=>i);
    const aes=createCipheriv('aes-128-cbc',key,iv);aes.setAutoPadding(false);
    const encrypted=await aesCbcEncrypt(data,key,iv);
    expect(Buffer.from(encrypted)).toEqual(Buffer.concat([aes.update(data),aes.final()]));
    expect(await aesCbcDecrypt(new Uint8Array([...encrypted,123]),key,iv)).toEqual(new Uint8Array([...data,123]));
  });
  it("authenticates private packets and rejects changed headers and payloads",async()=>{
    const plaintext=new TextEncoder().encode('PSP sample data!');
    const packet=await syntheticKirkPacket(plaintext,new Uint8Array(32));
    expect(await kirkCMD10(packet)).toBe(true);expect(await kirkCMD1(packet)).toEqual(plaintext);
    for(const at of [0x70,packet.length-1]){const changed=packet.slice();changed[at]!^=1;expect(await kirkCMD10(changed)).toBe(false);await expect(kirkCMD1(changed)).rejects.toThrow();}
  });
  it("supports in-place command buffers with payload-length inputSize",()=>{
    const state=kirkCreate();kirkInit(state);
    const data=Uint8Array.from({length:32},(_,i)=>i),buffer=new Uint8Array(52),view=new DataView(buffer.buffer);
    buffer.set(data,20);view.setUint32(0,4,true);view.setUint32(12,0x38,true);view.setUint32(16,32,true);
    expect(command(state,buffer,52,buffer,32,4)).toBe(0);
    view.setUint32(0,5,true);expect(command(state,buffer,52,buffer,32,7)).toBe(0);
    expect(buffer.subarray(0,32)).toEqual(data);
  });
  it("validates malformed commands and fills a long random result",()=>{
    const state=kirkCreate(),out=new Uint8Array(70000);
    expect(command(state,out,out.length,new Uint8Array(),0,14)).toBe(0);
    expect(out.some(v=>v!==0)).toBe(true);
    expect(command(state,out,20,new Uint8Array(3),3,11)).toBe(15);
    expect(command(state,out,20,new Uint8Array(20),20,4)).toBe(12);
  });
});
