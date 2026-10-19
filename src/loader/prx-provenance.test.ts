import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { pspDecryptPRX } from "./prx-decrypter.js";
import { kirk4, kirk7 } from "./kirk.js";
import { legacyTags, modernTags } from "./prx-key-data.js";
import { syntheticKirkPacket, referenceCmac } from "../crypto/test-packets.js";
const join=(...parts:Uint8Array[]):Uint8Array=>new Uint8Array(Buffer.concat(parts));
const mask=(bytes:Uint8Array,key:Uint8Array,start=0):Uint8Array=>bytes.map((v,i)=>v^key[(i+start)%key.length]!);
const hash=(bytes:Uint8Array):Uint8Array=>new Uint8Array(createHash('sha1').update(bytes).digest());
async function fixture(kind:0|1|2|5|6):Promise<{source:Uint8Array;plain:Uint8Array;seed?:Uint8Array|undefined}> {
 const plain=Uint8Array.from({length:32},(_,i)=>i*7+1), prefix=Uint8Array.from({length:128},(_,i)=>i*3);
 const packet=await syntheticKirkPacket(plain,prefix);
 if(kind===6){packet[0x64]=1;const key=Uint8Array.from({length:16},(_,i)=>i+33);packet.set(referenceCmac(packet.subarray(0x60,0x90),key),0x20);packet.set(referenceCmac(packet.subarray(0x60),key),0x30);}
 const header=packet.slice(0,0x90), source=new Uint8Array(0x150+plain.length), view=new DataView(source.buffer);
 source.set(prefix);source.set(packet.subarray(0x110),0x150);
 if(kind<2){
  const record=legacyTags[0]!;
  const encoded=header.slice(); encoded.set(mask(await kirk4(mask(header.subarray(0,0x70),record.key,0x20),record.code),record.key,0x14));
  const unused=new Uint8Array(40).fill(9);
  let combined=join(hash(join(record.key.subarray(0,20),unused,encoded,prefix)),unused,encoded);
  if(kind===1)combined.set(await kirk4(combined.slice(12,172),record.code),12);
  source.set(combined.subarray(0,20),0xd4);source.set(combined.subarray(20,60),0xe8);
  source.set(combined.subarray(60,124),0x110);source.set(combined.subarray(124),0x80);
  view.setUint32(0xd0,record.tag,true);
  return {source,plain};
 }
 const record=(kind===5?modernTags.find(r=>r.seed):modernTags[0])!;
 const bonus=kind===5?new Uint8Array(16).fill(0x42):undefined;
 const material=new Uint8Array(144);for(let i=0;i<9;i++){material.set(record.key,i*16);material[i*16]=i;}
 let expanded=await kirk7(material,record.code);if(bonus)expanded=mask(expanded,bonus);
 const encoded=mask(await kirk4(mask(header.subarray(0,64),expanded,80),record.code),expanded,16);
 const id=new Uint8Array(16).fill(17), tag=new Uint8Array(4);new DataView(tag.buffer).setUint32(0,record.tag,true);
 const signature=kind===6?header.slice(0x40,0x60):new Uint8Array();
 const digest=hash(join(tag,expanded.subarray(0,16),new Uint8Array(kind===6?56:88),signature,id,encoded,header.subarray(0x70,0x80),prefix));
 const identity=join(id,digest,encoded);
 let encrypted=await kirk4(identity.slice(0,96),record.code);
 if(kind===5 && record.seed)encrypted=mask(encrypted,record.seed);
 identity.set(encrypted);
 let wireHeader=identity.slice(36), wireHash=identity.slice(16,36);
 if(kind===5){let part=await kirk4(join(wireHeader,wireHash.subarray(0,16)),record.code);if(record.seed)part=mask(part,record.seed);if(bonus)part=mask(part,bonus);wireHeader=part.slice(0,64);wireHash.set(part.subarray(64));}
 source.set(wireHeader.subarray(0,48),0x80);source.set(wireHeader.subarray(48),0xc0);
 source.set(header.subarray(0x70,0x80),0xb0);source.set(wireHash,0x12c);source.set(identity.subarray(0,16),0x140);
 if(kind===6)source.set(signature,0x10c);source.set(tag,0xd0);
 return {source,plain,seed:bonus};
}
describe('synthetic encrypted PRX files',()=>{
 for(const kind of [0,1,2,5,6] as const)it(`decrypts packet layout ${kind} without a game image`,async()=>{
  const {source,plain,seed}=await fixture(kind), before=source.slice();
  expect(await pspDecryptPRX(source,seed)).toEqual(plain);expect(source).toEqual(before);
  const changed=source.slice();changed[changed.length-1]!^=1;
  expect(await pspDecryptPRX(changed,seed)).toBeNull();
 });
});

