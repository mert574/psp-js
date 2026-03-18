import { describe, it, expect, beforeEach } from "vitest";
import { CoreTiming } from "./core-timing.js";

describe("CoreTiming", () => {
  let ct: CoreTiming;

  beforeEach(() => {
    ct = new CoreTiming();
  });

  it("registerEventType returns stable ids", () => {
    const a = ct.registerEventType("A", () => {});
    const b = ct.registerEventType("B", () => {});
    expect(a).toBe(0);
    expect(b).toBe(1);
  });

  it("fires callback at correct cycle", () => {
    const fired: number[] = [];
    const id = ct.registerEventType("T", (late) => fired.push(late));
    ct.scheduleEvent(100, id);
    ct.advance(50);
    expect(fired).toHaveLength(0);
    ct.advance(50);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBe(0);
  });

  it("reports cyclesLate when advance overshoots", () => {
    let late = -1;
    const id = ct.registerEventType("T", (l) => { late = l; });
    ct.scheduleEvent(100, id);
    ct.advance(150);
    expect(late).toBe(50);
  });

  it("removeEvent cancels pending event", () => {
    let fired = false;
    const id = ct.registerEventType("T", () => { fired = true; });
    ct.scheduleEvent(100, id);
    ct.removeEvent(id);
    ct.advance(200);
    expect(fired).toBe(false);
  });

  it("nextEventDelta returns correct value", () => {
    const id = ct.registerEventType("T", () => {});
    ct.scheduleEvent(100, id);
    expect(ct.nextEventDelta()).toBe(100);
    ct.advance(40);
    expect(ct.nextEventDelta()).toBe(60);
  });

  it("returns Infinity when queue is empty", () => {
    expect(ct.nextEventDelta()).toBe(Infinity);
  });

  it("setClockHz changes msToCycles output", () => {
    ct.setClockHz(333_000_000);
    expect(ct.msToCycles(1)).toBe(333_000);
  });

  it("fires multiple events in chronological order", () => {
    const order: number[] = [];
    const id = ct.registerEventType("T", (_late, ud) => order.push(ud));
    ct.scheduleEvent(300, id, 3);
    ct.scheduleEvent(100, id, 1);
    ct.scheduleEvent(200, id, 2);
    ct.advance(300);
    expect(order).toEqual([1, 2, 3]);
  });

  it("callback rescheduling does not fire in same advance pass", () => {
    let count = 0;
    let id: number;
    id = ct.registerEventType("T", () => {
      count++;
      ct.scheduleEvent(0, id);
    });
    ct.scheduleEvent(100, id);
    ct.advance(100);
    expect(count).toBe(1);
  });

  it("usToCycles at 222 MHz matches PPSSPP formula", () => {
    expect(ct.usToCycles(16683)).toBe(Math.floor(222_000_000 / 1_000_000 * 16683));
  });

  it("init() resets timer and queue", () => {
    const id = ct.registerEventType("T", () => {});
    ct.scheduleEvent(100, id);
    ct.advance(50);
    ct.init();
    expect(ct.getTicks()).toBe(0);
    expect(ct.nextEventDelta()).toBe(Infinity);
  });
});
