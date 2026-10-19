import { describe, expect, it } from "vitest";
import { BlockAllocator } from "./block-allocator.js";
describe("range allocator replacement",()=>{
 it("aligns both allocation directions and coalesces released ranges",()=>{
  const a=new BlockAllocator(16);a.init(0x101,0x400);
  expect(a.allocAligned(17,32,64,false,'low')).toBe(0x140);
  expect(a.allocAligned(16,16,64,true,'high')).toBe(0x4c0);
  expect(a.freeExact(0x141)).toBe(false);expect(a.free(0x14a)).toBe(true);expect(a.freeExact(0x4c0)).toBe(true);
  expect(a.listBlocks()).toEqual([{start:0x101,size:0x400,taken:false,tag:''}]);
 });
 it("preserves fixed-address reservations and serialized state",()=>{
  const a=new BlockAllocator();a.init(0x100,0x100);
  expect(a.allocAt(0x143,20,'elf')).toBe(0x143);expect(a.getBlockStartFromAddress(0x150)).toBe(0x140);
  const b=new BlockAllocator();b.deserialize(a.serialize());expect(b.serialize()).toEqual(a.serialize());
  expect(b.allocAt(0x148,4)).toBe(-1);expect(b.free(0x153)).toBe(true);expect(b.getLargestFreeBlockSize()).toBe(256);
 });
 it("conserves the address space across fragmented allocation and free sequences",()=>{
  const a=new BlockAllocator();a.init(0x1000,4096);let random=19;const live:number[]=[];
  for(let n=0;n<600;n++){
   random=(Math.imul(random,1664525)+1013904223)>>>0;
   if((random&3)===0&&live.length){const i=random%live.length;expect(a.freeExact(live.splice(i,1)[0]!)).toBe(true);}
   else{const start=a.allocAligned((random%113)+1,16,1<<((random%4)+4),Boolean(random&4),'test');if(start!==-1)live.push(start);}
   const blocks=a.listBlocks();expect(blocks.reduce((sum,b)=>sum+b.size,0)).toBe(4096);
   expect(blocks[0]!.start).toBe(0x1000);
   for(let i=1;i<blocks.length;i++){expect(blocks[i]!.start).toBe(blocks[i-1]!.start+blocks[i-1]!.size);expect(blocks[i]!.taken||blocks[i-1]!.taken).toBe(true);}
  }
  for(const address of live)expect(a.freeExact(address)).toBe(true);expect(a.getTotalFreeBytes()).toBe(4096);
 });
});
