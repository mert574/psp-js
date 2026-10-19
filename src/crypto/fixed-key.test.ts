import { describe, expect, it } from "vitest";
import { sceNpDrmGetFixedKey } from "./amctrl.js";
import { kirkCreate, kirkInit } from "./kirk.js";
const vectors = [
  {
    "name": "",
    "type": 0,
    "status": 0,
    "expectedHex": "84e394bf05631059c62368a3afc2115b"
  },
  {
    "name": "",
    "type": 1,
    "status": 0,
    "expectedHex": "8d988fc8a74d6f9acfe81852d5eb7a95"
  },
  {
    "name": "",
    "type": 2,
    "status": 0,
    "expectedHex": "e722c5eb16f4b170312b8abc520cd0ff"
  },
  {
    "name": "",
    "type": 3,
    "status": 0,
    "expectedHex": "d150edd62bc13347fae99cab6cc9d4a0"
  },
  {
    "name": "TEST00001",
    "type": 0,
    "status": 0,
    "expectedHex": "afbb6e9d8cf9056e00acdb68f3cffc7f"
  },
  {
    "name": "TEST00001",
    "type": 1,
    "status": 0,
    "expectedHex": "6c9e53de06a2201ed6918fa76a7f681c"
  },
  {
    "name": "TEST00001",
    "type": 2,
    "status": 0,
    "expectedHex": "49f16e5b8cb437ac6f54786e457364d0"
  },
  {
    "name": "TEST00001",
    "type": 3,
    "status": 0,
    "expectedHex": "efdb7ce06de707e4d14431a94415810d"
  },
  {
    "name": "TEST-CONTENT-ID-00000000000000000000000000000000000000",
    "type": 0,
    "status": 0,
    "expectedHex": "f37cdc7e7e703b1e8c3a295da6cf3016"
  },
  {
    "name": "TEST-CONTENT-ID-00000000000000000000000000000000000000",
    "type": 1,
    "status": 0,
    "expectedHex": "5ca1b95ecd5b346acde5ba1f2ca13834"
  },
  {
    "name": "TEST-CONTENT-ID-00000000000000000000000000000000000000",
    "type": 2,
    "status": 0,
    "expectedHex": "67c95edefdf76812c25c525917dabacf"
  },
  {
    "name": "TEST-CONTENT-ID-00000000000000000000000000000000000000",
    "type": 3,
    "status": 0,
    "expectedHex": "f6ee76157f954c1df57d618cdd436891"
  }
];
describe("fixed-key replacement",()=>{
 for(const sample of vectors)it(`matches synthetic variant ${sample.type}: ${sample.name}`,()=>{
  const state=kirkCreate();kirkInit(state);const output=new Uint8Array(20).fill(0xaa);
  expect(sceNpDrmGetFixedKey(state,output,2,sample.name,0x1000000+sample.type)).toBe(sample.status);
  expect(Buffer.from(output.subarray(2,18)).toString('hex')).toBe(sample.expectedHex);
  expect([output[0],output[19]]).toEqual([0xaa,0xaa]);
 });
});
