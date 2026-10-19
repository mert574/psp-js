import { describe, expect, it } from "vitest";
import { lookupCategory } from "./psp-registry.js";
import { readFileSync } from "node:fs";
describe("project registry",()=>{
 it("lists only available replacement fonts with their actual PGF metadata",()=>{
  const font=lookupCategory('/data/font')!;expect(font.keys.find(k=>k.name==='num_fonts')!.intValue).toBe(16);
  const properties=lookupCategory('/DATA/FONT/PROPERTY')!;expect(properties.count).toBe(16);
  for(const directory of properties.keys){
   const info=lookupCategory('/DATA/FONT/PROPERTY/'+directory.name)!.keys;
   const name=info.find(k=>k.name==='file_name')!.strValue!;
   const bytes=readFileSync(new URL('../../public/flash0/font/'+name,import.meta.url));
   expect(info.find(k=>k.name==='h_size')!.intValue).toBe(bytes.readInt32LE(36));
   expect(info.find(k=>k.name==='font_name')!.strValue).toMatch(/^PSP\.js (Sans|Mono)$/);
  }
 });
 it("uses synthetic zero counters and rejects missing categories",()=>{
  expect(lookupCategory('/DATA/COUNT')!.keys.every(k=>k.intValue===0)).toBe(true);
  expect(lookupCategory('/DATA/FONT/PROPERTY/INFO17')).toBeNull();expect(lookupCategory('/DATA/FONT/num_fonts')).toBeNull();
 });
});
