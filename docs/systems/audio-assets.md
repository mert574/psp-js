# Background Audio Decoding

PSP games store music and sound effects as ATRAC3 / ATRAC3+ (`.at3`) files. These are compressed and have to be turned into PCM before they can be played. psp-js decodes them with `@ffmpeg/ffmpeg` (an FFmpeg build compiled to WebAssembly), and it does that work in the background rather than inside the emulator loop.

## Why it runs in the background

ATRAC decoding through the WASM FFmpeg is CPU heavy. If a `sceAtrac` or `sceAudio` syscall had to decode a file on the spot, the call would block for tens of milliseconds and the emulator would hitch. To avoid that, the decode is moved off the hot path in three ways:

- **Parallel.** Decoding runs across a pool of FFmpeg WASM instances, one busy at a time per pool slot, so several files decode at once.
- **Ahead of time.** Every `.at3` file in the mounted game is pre-decoded at load, before gameplay starts, so the result is already in memory when a syscall asks for it.
- **Off the main thread for playback.** Decoded PCM is mixed and played by an `AudioWorkletProcessor`, which runs on the Web Audio thread, so the audio callback never blocks the emulator.

The syscall handlers themselves never decode. They look the PCM up in a cache and, if it is ready, hand it straight to the audio engine.

## The decode pool

`FFmpegPool` (`src/audio/ffmpeg-pool.ts`) owns the FFmpeg WASM instances. Each instance is single threaded and not re-entrant, so the pool gives each decode exclusive use of one instance and queues callers when all are busy.

The shared pool in `atrac-decoder.ts` is sized to the machine: `min(16, max(2, cores - 2))`, reserving two cores for the main thread and the GE work. Instances are created lazily on first use and their WASM core is fetched once from a CDN.

### `class FFmpegPool`

```ts
constructor(opts: FFmpegPoolOptions = {})
exec<T>(fn: (ff: FFmpeg) => Promise<T>): Promise<T>
getInstance(): Promise<FFmpeg>
terminate(): void
get size(): number     // instances created so far
get busy(): number     // instances currently in use
get waiting(): number  // callers queued for a free instance
```

- **`exec(fn)`** acquires a free instance (creating one if under `maxSize`, otherwise waiting), runs `fn` with it, and releases it afterward. This is the normal entry point.
- **`getInstance()`** returns a raw instance for callers that need direct access; prefer `exec` since it releases automatically. The decoder re-exports it as `getFFmpeg()` for non-pool callers, though the PMF path in `pmf.ts` currently keeps its own separate FFmpeg instance rather than using the pool.
- **`FFmpegPoolOptions`** carries `{ maxSize?, coreVersion?, coreURL?, wasmURL? }`.

## Pre-warming at load

When a game is mounted, the frontend collects every `.at3`/`.at3p` file from `hle.fileData`, sorts them largest first (so background music starts decoding before short sound effects), and feeds them through the pool with a bounded number in flight (`getDecodeConcurrency()`), so all the file buffers are not held in memory at once. A progress bar is shown while this runs (`showAt3Loading` / `hideAt3Loading` in `src/frontend/ui.ts`), and the debug panel's pre-boot view updates alongside it. This is in `src/frontend/main.ts`.

### Decoder API (`src/audio/atrac-decoder.ts`)

```ts
parseAtracHeader(data: Uint8Array): AtracInfo
decodeAtrac(data: Uint8Array, info: AtracInfo): Promise<Int16Array>
warmupAtracDecode(data: Uint8Array): Promise<void>
getCachedAtrac(data: Uint8Array): Int16Array | null
getCachedAtracBySize(bufferAllocation: number, hint?: number):
  { pcm: Int16Array; info: AtracInfo; fileSize: number } | null
getDecodeConcurrency(): number
getPoolStats(): { size: number; busy: number; waiting: number; cached: number }
getFFmpeg(): Promise<FFmpeg>
```

- **`parseAtracHeader(data)`** reads the RIFF/WAVE header and returns an `AtracInfo` (`{ codecType, totalSamples, loopStart, loopEnd, channels, sampleRate, samplesPerFrame, bytesPerFrame, dataOffset, dataSize }`), where `codecType` is `"AT3"` or `"AT3PLUS"` (chosen from the fmt codec tag, `0x0270` means AT3PLUS) and `samplesPerFrame` is 512 for AT3, 1024 for AT3+. `bytesPerFrame` is the RIFF `nBlockAlign`; `dataOffset`/`dataSize` locate the compressed payload. It does not decode anything.
- **`decodeAtrac(data, info)`** runs FFmpeg on a pool instance (`-f s16le` plus `-ar`/`-ac` from the parsed header) and returns interleaved 16-bit PCM as an `Int16Array`. The result is cached, keyed by a fingerprint of the file (length plus its first 32 bytes).
- **`warmupAtracDecode(data)`** is the load-time entry point: it parses the header, decodes in the background, and stores the PCM in the cache. Repeat calls for the same file are de-duplicated, so warming an already-warmed file is free.
- **`getCachedAtrac(data)`** is the synchronous lookup the syscall handlers use; it returns the cached PCM or `null` if it is not ready yet.
- **`getCachedAtracBySize(bufferAllocation, hint)`** is a fallback for streaming games that register an uninitialized buffer: it matches a cached file by its declared buffer size.
- **`getDecodeConcurrency()`** returns the pool size (used to bound the load-time pass). **`getPoolStats()`** feeds the debug panel.

## Playback off the main thread

`AudioEngine` (`src/audio/audio-engine.ts`) routes decoded PCM to the speaker through an `AudioWorkletNode`. The PSP mixes at 44100 Hz, and the engine creates the `AudioContext` at that rate.

```ts
init(): Promise<void>
destroy(): void
get isReady(): boolean
setSpeed(speed: number): void
reserveChannel(index: number, sampleCount: number, format: number): number
releaseChannel(index: number): void
enqueueFrames(pcm: Int16Array, leftVol: number, rightVol: number,
              sampleCount: number, mono: boolean, channelId: number): void
```

- **`init()`** loads the worklet module and connects a `psp-audio-processor` node (stereo out) to the context.
- **`enqueueFrames(...)`** applies the PSP per-channel volume in integer math, then posts `{ channel, pcm }` to the worklet, transferring the buffer so there is no copy.
- **`setSpeed(speed)`** tells the worklet how many input frames to consume per output frame, so audio keeps pace at 2x/4x fast-forward.

The worklet (`src/audio/audio-worklet-processor.ts`) keeps a separate PCM queue per PSP channel (0-9) and mixes them all together in its `process()` callback. Per-channel queues let background music and sound effects play at once without serializing them.

## The HTML audio fallback

Separately from the `sceAudio` pipeline, the frontend can transcode a sound file straight to a playable URL for an HTML `<audio>` element. `transcodeAt3(at3Data: Uint8Array): Promise<string>` (`src/frontend/pmf.ts`) decodes an AT3 file to MP3 (falling back to WAV) and returns an object URL. This is used for simple playback cases, not for the per-channel game mix.
