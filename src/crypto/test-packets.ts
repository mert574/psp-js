import { createCipheriv } from "node:crypto";
import { aesCbcEncrypt, kirk1_key } from "../loader/kirk.js";
const block = (key: Uint8Array, data: Uint8Array): Uint8Array => {
  const aes = createCipheriv("aes-128-ecb", key, null); aes.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([aes.update(data), aes.final()]));
};
const xor = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((byte, i) => byte ^ b[i]!);
export function referenceCmac(data: Uint8Array, key: Uint8Array): Uint8Array {
  const double = (input: Uint8Array): Uint8Array => {
    const n = BigInt('0x'+Buffer.from(input).toString('hex'));
    const shifted = BigInt.asUintN(128, n << 1n) ^ (n >> 127n ? 0x87n : 0n);
    return new Uint8Array(Buffer.from(shifted.toString(16).padStart(32,'0'),'hex'));
  };
  const one = double(block(key,new Uint8Array(16))), two = double(one);
  const count = Math.max(1,Math.ceil(data.length/16));
  let tag: Uint8Array = new Uint8Array(16);
  for(let i=0;i<count;i++) {
    let part: Uint8Array = new Uint8Array(16); part.set(data.subarray(i*16,i*16+16));
    if(i===count-1) {
      const complete=data.length>0 && data.length%16===0;
      if(!complete)part[data.length%16]=0x80;
      part=xor(part,complete?one:two);
    }
    tag=block(key,xor(part,tag));
  }
  return tag;
}
export async function syntheticKirkPacket(payload: Uint8Array, gap = new Uint8Array(0)): Promise<Uint8Array> {
  if (payload.length % 16) throw new Error("Synthetic payload must contain complete AES blocks");
  const key = Uint8Array.from({length:16},(_,i)=>i+1), macKey=key.map(v=>v+32);
  const packet=new Uint8Array(0x90+gap.length+payload.length);
  packet.set(await aesCbcEncrypt(new Uint8Array([...key,...macKey]),kirk1_key));
  const view=new DataView(packet.buffer);view.setUint32(0x60,1,true);view.setUint32(0x70,payload.length,true);view.setUint32(0x74,gap.length,true);
  packet.set(gap,0x90);packet.set(await aesCbcEncrypt(payload,key),0x90+gap.length);
  packet.set(referenceCmac(packet.subarray(0x60,0x90),macKey),0x20);
  packet.set(referenceCmac(packet.subarray(0x60),macKey),0x30);
  return packet;
}
