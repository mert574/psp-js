# Audio & Media

Sound and video both decode compressed PSP formats and feed them to browser APIs.

## Audio (`src/audio/`)

| File | Contents |
| --- | --- |
| `audio-engine.ts` | `AudioEngine`, `AudioContext` + `AudioWorkletNode`, channel mixing |
| `atrac-decoder.ts` | ATRAC3+ decode functions (`decodeAtrac`, `warmupAtracDecode`, `parseAtracHeader`, ...) via `@ffmpeg/ffmpeg` (WASM) |
| `audio-worklet-processor.ts` | the AudioWorklet script (runs off the main thread) |

The PSP has 8 regular PCM audio channels (indices 0-7), a separate SRC channel (index 8, used by `sceAudioSRC*` with its own sample rate), and a single shared Output2 stereo channel (index 9). `AudioEngine` reserves/releases channels and queues PCM submitted by the `sceAudio*` HLE handlers; the AudioWorklet mixes all channels to stereo at the PSP-native 44.1 kHz and plays them through Web Audio.

ATRAC3+ (the PSP's compressed audio) is decoded by module-level functions in `atrac-decoder.ts` (`decodeAtrac`, `parseAtracHeader`) using a bundled `@ffmpeg/ffmpeg` (WASM) build. Decode is asynchronous (Promise-based), so the `sceAtrac*` handlers return their result in a follow-up step. `warmupAtracDecode()` pre-heats the ffmpeg pool before gameplay so the first decode doesn't stall.

::: tip Wall-clock audio
Audio output is paced by the Web Audio hardware clock, not the emulated cycle clock. In a save state the audio context isn't serialized; playback resumes from the restored channel/decode state, which may produce a tiny blip.
:::

## Media / Video (`src/media/`)

| File | Contents |
| --- | --- |
| `mpeg-decoder.ts` | `MpegMediaDecoder`, H.264 decode via WebCodecs |
| `psmf-demux.ts` | `PsmfDemux`, streaming MPEG-2 Program Stream demultiplexer |
| `psmf-decoder.ts` | `PsmfDecoder`, H.264 decode helpers (WebCodecs) |

PSP cutscenes are H.264 inside an MPEG Program Stream (PSMF). The demuxer is streaming: the game feeds Program Stream bytes incrementally through the `sceMpeg` ringbuffer, and `PsmfDemux` splits out H.264 access units as the bytes arrive (cheap byte work). The decoder then decodes frames **lazily** on demand via the browser's `VideoDecoder` (WebCodecs), keeping a small lookahead. This avoids racing hundreds of frames ahead when a game fills its ringbuffer in one burst.

The `sceMpeg*` and `scePsmfPlayer*` HLE handlers (`hle-media.ts`, `hle-mpeg.ts`, `hle-psmf-player.ts`) drive these, and the frontend's `pmf.ts` plays opening movies.

::: warning Browser only
WebCodecs is not available in Node, so video decode only works in the browser. A mid-stream seek may glitch a single frame across a save-state restore, since the `VideoDecoder`'s internal state can't be serialized.
:::
