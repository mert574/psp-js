# Core Timing

`CoreTiming` (`src/timing/core-timing.ts`) is a cycle-based event scheduler, modeled on PPSSPP's `Core/CoreTiming.cpp`. It tracks a global cycle count and fires scheduled events when their time arrives. There is no wall clock, the emulator decides when to advance, so timing is deterministic.

## Clock

```ts
CPU_HZ = 222_000_000   // default; games switch to 333 MHz via scePowerSetClockFrequency
```

`msToCycles(ms)` and `cyclesToUs(cycles)` convert using the current `CPU_HZ`. Changing the clock frequency affects conversions from that point forward.

## Types

`EventTypeId = number`

A handle for a registered event type, returned by `registerEventType`.

`TimedCallback = (cyclesLate: number, userdata: number) => void`

An event handler. `cyclesLate` is how far past the scheduled time the event actually fired (`globalTimer - event.time`, always 0 or more). `userdata` is the value that was passed to `scheduleEvent`.

## API

`init(): void`

Reset the timer and clear the queue. Called on each game load. Registered event types are kept (callers re-register on load).

`registerEventType(name: string, callback: TimedCallback): EventTypeId`

Register an event type and get a stable id back. Ids are assigned in registration order.

`scheduleEvent(cyclesFromNow: number, typeId: EventTypeId, userdata = 0): void`

Queue an event to fire at `globalTimer + cyclesFromNow` (a negative delta is clamped to 0). Several events of the same type can be queued at once.

`removeEvent(typeId: EventTypeId): void`

Drop every pending event of that type.

`unscheduleEvent(typeId: EventTypeId, userdata: number): void`

Drop pending events matching both the type and the `userdata`.

`advance(cycles: number): void`

Add `cycles` to `globalTimer`, then fire every event whose time has arrived.

`nextEventDelta(): number`

Cycles until the next scheduled event, or `Infinity` if the queue is empty.

`getTicks(): number`

The current global cycle count.

`setClockHz(hz: number): void`

Change `CPU_HZ`. Pending events keep their original absolute fire times (they are not rescaled).

`msToCycles(ms: number): number` / `usToCycles(us: number): number` / `cyclesToUs(cycles: number): number`

Convert between time and cycles using the current `CPU_HZ`.

The queue is sorted by absolute fire time. An event that reschedules itself from inside its callback does not re-fire within the same `advance()` pass.

## VBlank

The emulator registers VBlank events at boot. VBlank fires every frame (frame period = 1001/60 ms = ~16.683 ms). `EnterVBlank` fires near the end of the frame and `LeaveVBlank` a fraction of a millisecond later (0.7315 ms). `runFrame()` advances `CoreTiming` by the cycles the CPU ran and lets due events fire, which is how `sceDisplayWaitVblankStart` and friends unblock threads.

## Save states

`serialize()` captures `{ globalTimer, cpuHz, events }` and `deserialize()` restores it. Events are stored by their event-type *name*, not the numeric id: some types register lazily (e.g. `IoAsyncNotify` only on first async IO), so the same logical event can have a different id after a fresh boot. `deserialize()` remaps each name back to the current id with `findEventTypeByName`, warns and drops any event whose type isn't registered, then re-sorts the queue by time.
