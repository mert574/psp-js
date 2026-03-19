/**
 * CoreTiming — cycle-accurate event scheduler for the PSP emulator.
 * Modelled after PPSSPP's Core/CoreTiming.cpp.
 *
 * Key invariants:
 *  - globalTimer is the authoritative total cycles elapsed
 *  - Event queue is sorted ascending by absolute fire time
 *  - advance(n) adds n to globalTimer then fires all due events
 *  - Callbacks that reschedule will NOT re-fire in the same advance() pass
 */

export type EventTypeId = number;
export type TimedCallback = (cyclesLate: number, userdata: number) => void;

interface EventType {
  name: string;
  callback: TimedCallback;
}

interface ScheduledEvent {
  time: number;       // absolute cycle count
  typeId: EventTypeId;
  userdata: number;
}

export class CoreTiming {
  /** PPSSPP default: initialHz = 222000000 (CoreTiming.cpp:36) */
  CPU_HZ = 222_000_000;

  private globalTimer = 0;
  private eventTypes: EventType[] = [];
  private queue: ScheduledEvent[] = []; // sorted ascending by .time

  /** Reset timing state (call on each new game load). */
  init(): void {
    this.globalTimer = 0;
    this.queue = [];
    // Keep registered event types — callers re-register on each load
    // and clearing here would require full re-registration.
  }

  /** Register a new event type. Returns a stable EventTypeId. */
  registerEventType(name: string, callback: TimedCallback): EventTypeId {
    const id = this.eventTypes.length;
    this.eventTypes.push({ name, callback });
    return id;
  }

  /**
   * Schedule an event to fire cyclesFromNow cycles in the future.
   * Multiple events of the same typeId can coexist.
   */
  scheduleEvent(cyclesFromNow: number, typeId: EventTypeId, userdata = 0): void {
    const time = this.globalTimer + Math.max(0, cyclesFromNow);
    const ev: ScheduledEvent = { time, typeId, userdata };
    // Insertion-sorted ascending by time.
    // Scan from end — events typically target the near future so the
    // correct position is usually near the front.
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.time > time) i--;
    this.queue.splice(i, 0, ev);
  }

  /** Remove all pending events of a given type. */
  removeEvent(typeId: EventTypeId): void {
    this.queue = this.queue.filter(ev => ev.typeId !== typeId);
  }

  /** Remove pending events matching both typeId and userdata (like PPSSPP UnscheduleEvent). */
  unscheduleEvent(typeId: EventTypeId, userdata: number): void {
    this.queue = this.queue.filter(ev => !(ev.typeId === typeId && ev.userdata === userdata));
  }

  /**
   * Advance the global timer by `cycles`, then fire all due events.
   * Callbacks receive `cyclesLate = globalTimer - event.time`.
   */
  advance(cycles: number): void {
    this.globalTimer += cycles;
    this._processEvents();
  }

  /**
   * Cycles until the next scheduled event.
   * Returns Infinity if the queue is empty.
   */
  nextEventDelta(): number {
    if (this.queue.length === 0) return Infinity;
    return Math.max(0, this.queue[0]!.time - this.globalTimer);
  }

  /** Current global cycle count. */
  getTicks(): number {
    return this.globalTimer;
  }

  /**
   * Update CPU_HZ. Does NOT rescale pending events (matches PPSSPP behavior).
   * Pending events fire at their original absolute cycle counts.
   */
  setClockHz(hz: number): void {
    if (hz > 0) this.CPU_HZ = hz;
  }

  // ── Time conversion helpers (match PPSSPP CoreTiming.h formulas) ─────────

  msToCycles(ms: number): number {
    return Math.floor(this.CPU_HZ / 1000 * ms);
  }

  usToCycles(us: number): number {
    return Math.floor(this.CPU_HZ / 1_000_000 * us);
  }

  cyclesToUs(cycles: number): number {
    return Math.floor(cycles * 1_000_000 / this.CPU_HZ);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _processEvents(): void {
    const now = this.globalTimer;
    // Collect all due events before firing any callbacks.
    // This prevents a callback that reschedules at time=0 from re-firing
    // in the same pass (which would cause an infinite loop).
    const due: ScheduledEvent[] = [];
    while (this.queue.length > 0 && this.queue[0]!.time <= now) {
      due.push(this.queue.shift()!);
    }
    for (const ev of due) {
      const type = this.eventTypes[ev.typeId];
      if (type) type.callback(now - ev.time, ev.userdata);
    }
  }
}
