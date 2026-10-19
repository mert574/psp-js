import { describe, expect, it } from "vitest";
import { consumeFrame, frameCapacity, refillWindow } from "./atrac-ring.js";
describe("incremental audio ring",()=>{
 it("offers only contiguous unused bytes before and after wrap",()=>{
  expect(refillWindow(128,256,1024,1000,5000,false)).toEqual({position:384,writable:640,fileOffset:1000});
  expect(refillWindow(768,400,1024,1000,5000,false)).toEqual({position:144,writable:624,fileOffset:1000});
  expect(refillWindow(128,1024,1024,1000,5000,false).writable).toBe(0);
 });
 it("limits refill at EOF and handles a linear halfway buffer",()=>{
  expect(refillWindow(128,256,1024,4900,5000,false).writable).toBe(100);
  expect(refillWindow(128,256,1024,5000,5000,false)).toEqual({position:0,writable:0,fileOffset:0});
  expect(refillWindow(128,256,1024,4000,5000,true)).toEqual({position:4000,writable:1000,fileOffset:4000});
 });
 it("rounds capacity to whole frames and consumes without negative counts",()=>{
  expect(frameCapacity(1025,192)).toBe(960);
  expect(consumeFrame(900,20,960,192)).toEqual({position:132,valid:0});
  expect(refillWindow(0,0,0,1,100,false).writable).toBe(0);
 });
});
