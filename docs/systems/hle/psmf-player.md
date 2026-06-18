# scePsmfPlayer (`hle-psmf-player.ts`)

Implements `scePsmfPlayer`, the high-level cutscene playback API, and the `scePsmf` container parsing calls. Unlike [sceMpeg](/systems/hle/mpeg), this path does real video: it bridges the game's calls to the WebCodecs-based `PsmfDecoder`, converts decoded frames to the PSP pixel format, and writes them to VRAM or RAM. Video decode needs the browser (WebCodecs); see [Audio & Media](/systems/audio-media).

A player is identified by a context address in game memory. `Create` writes a small integer id at that address, and every other call reads it back to find the player instance.

## Typical flow

`scePsmfPlayerCreate`, then `scePsmfPlayerSetPsmf(filename)` (or the `Offset` / `CB` variants), then `scePsmfPlayerStart`, then a loop of `scePsmfPlayerUpdate` and `scePsmfPlayerGetVideoData` / `scePsmfPlayerGetAudioData`, then `scePsmfPlayerStop` and `scePsmfPlayerDelete`.

## Player setup

| Signature | What it does |
| --- | --- |
| `scePsmfPlayerCreate(psmfPlayer: u32, dataPtr: u32): int` | Allocates a player instance, writes its id to `psmfPlayer`, and sets status to INIT. `dataPtr` (init params) is ignored here. |
| `scePsmfPlayerSetPsmf(psmfPlayer: u32, filename: const char*): int` | Looks the PMF file up in the virtual filesystem, hands its bytes to a new `PsmfDecoder`, and kicks off async decode. Sets status to STANDBY on success, ERROR if the file is missing. |
| `scePsmfPlayerSetPsmfCB(psmfPlayer: u32, filename: const char*): int` | Same as `SetPsmf`; the real PSP variant runs callbacks while loading. We use the identical handler with no separate callback behavior. |
| `scePsmfPlayerSetPsmfOffset(psmfPlayer: u32, filename: const char*, offset: int): int` | Same handler as `SetPsmf`. The `offset` argument is not used (we always load the file from its start). |
| `scePsmfPlayerSetPsmfOffsetCB(psmfPlayer: u32, filename: const char*, offset: int): int` | Same handler as `SetPsmf`; callback and offset arguments are not used. |
| `scePsmfPlayerSetTempBuf(psmfPlayer: u32, tempBufAddr: u32, tempBufSize: u32): int` | No-op stub that returns 0. We do not use the game's temp buffer; decode runs through WebCodecs. |
| `scePsmfPlayerConfigPlayer(psmfPlayer: u32, configMode: int, configAttr: int): u32` | No-op stub that returns 0. Player config (looping mode, pixel format) is ignored. |

## Playback

| Signature | What it does |
| --- | --- |
| `scePsmfPlayerStart(psmfPlayer: u32, psmfPlayerData: u32, initPts: int): int` | Resets the frame cursor to 0 and sets status to PLAYING. `psmfPlayerData` and `initPts` are ignored; playback always starts at the first frame. |
| `scePsmfPlayerUpdate(psmfPlayer: u32): int` | Advances the frame cursor by one while PLAYING and the decode has finished, and flips status to FINISHED once the cursor reaches the last frame. |
| `scePsmfPlayerGetVideoData(psmfPlayer: u32, videoDataAddr: u32): int` | Reads the videoData struct (`frameWidth`, `displayBuf` pointer, then PTS high/low), writes the current decoded frame to `displayBuf` as ABGR8888, and writes the frame PTS back into the struct. Returns an error before decode is ready. |
| `scePsmfPlayerGetAudioData(psmfPlayer: u32, audioDataAddr: u32): int` | Writes one 2048-sample stereo frame (8192 bytes) of decoded cutscene audio, advancing the audio cursor in lockstep with the video. Falls back to silence when the audio track is not decoded yet (or has none). Returns 0. The cutscene audio is decoded to PCM through FFmpeg WASM in the browser; headless has no audio. |
| `scePsmfPlayerGetAudioOutSize(psmfPlayer: u32): int` | Returns the fixed PSP audio buffer size, 8192 bytes (2048 stereo samples). |
| `scePsmfPlayerStop(psmfPlayer: u32): int` | Sets status back to STANDBY and resets the frame cursor to 0. |
| `scePsmfPlayerBreak(psmfPlayer: u32): int` | Sets status back to STANDBY (stops playback without resetting the cursor). |
| `scePsmfPlayerChangePlayMode(psmfPlayer: u32, playMode: int, playSpeed: int): u32` | No-op stub that returns 0. Play mode and speed changes are ignored. |
| `scePsmfPlayerReleasePsmf(psmfPlayer: u32): int` | Drops the decoder and decoded frames and sets status back to INIT, so a new PMF can be loaded into the same player. |
| `scePsmfPlayerDelete(psmfPlayer: u32): int` | Frees the readback canvas and removes the player instance from the map. |

## State and selection

| Signature | What it does |
| --- | --- |
| `scePsmfPlayerGetCurrentStatus(psmfPlayer: u32): int` | Returns the player's PSP status code (INIT, STANDBY, PLAYING, FINISHED), or ERROR if the player is unknown, so the game's state machine advances. |
| `scePsmfPlayerGetCurrentPts(psmfPlayer: u32, currentPtsAddr: u32): u32` | Writes the current frame's PTS (low 32 bits) to `currentPtsAddr`. Returns an error before decode is ready. |
| `scePsmfPlayerGetPsmfInfo(psmfPlayer: u32, psmfInfoAddr: u32, widthAddr: u32, heightAddr: u32): u32` | Writes video width, height, and frame count into the struct at `psmfInfoAddr`. Our handler uses only the first pointer argument and does not fill the separate `widthAddr` / `heightAddr` outputs. |
| `scePsmfPlayerGetCurrentPlayMode(psmfPlayer: u32, playModeAddr: u32, playSpeedAddr: u32): u32` | Writes a fixed normal play mode (0) and 1x speed (1) to the given pointers. |
| `scePsmfPlayerSelectVideo(psmfPlayer: u32): u32` | No-op stub that returns 0. We always play the single decoded video stream. |
| `scePsmfPlayerSelectAudio(psmfPlayer: u32): u32` | No-op stub that returns 0. |
| `scePsmfPlayerSelectSpecificVideo(psmfPlayer: u32, videoCodec: int, videoStreamNum: int): u32` | No-op stub that returns 0. Stream selection is ignored. |
| `scePsmfPlayerSelectSpecificAudio(psmfPlayer: u32, audioCodec: int, audioStreamNum: int): u32` | No-op stub that returns 0. |
| `scePsmfPlayerGetCurrentVideoStream(psmfPlayer: u32, videoCodecAddr: u32, videoStreamNumAddr: u32): u32` | Writes 0 for both codec and stream number to the given pointers. |
| `scePsmfPlayerGetCurrentAudioStream(psmfPlayer: u32, audioCodecAddr: u32, audioStreamNumAddr: u32): u32` | Writes 0 for both codec and stream number to the given pointers. |
| `scePsmfPlayer_340C12CB(psmfPlayer: u32): u32` | Unnamed in PPSSPP, so the real signature is unknown beyond the player context arg. Our handler is a no-op that returns 0. |

## scePsmf container parsing

These calls inspect a PSMF container and report its streams and timing. Most are no-op stubs that return 0; the few that return a useful constant are noted.

| Signature | What it does |
| --- | --- |
| `scePsmfSetPsmf(psmfStruct: u32, psmfData: u32): u32` | No-op stub that returns 0. We do not parse the container header into the game's struct. |
| `scePsmfVerifyPsmf(psmfAddr: u32): u32` | No-op stub that returns 0 (reports the data as a valid PSMF). |
| `scePsmfGetHeaderSize(psmfStruct: u32, sizeAddr: u32): u32` | Returns the header size 0x800 directly in `v0`. PPSSPP writes it to `sizeAddr`; our handler ignores that pointer. |
| `scePsmfGetStreamSize(psmfStruct: u32, sizeAddr: u32): u32` | Returns 0 directly in `v0`. As with `GetHeaderSize`, the `sizeAddr` pointer is not written. |
| `scePsmfGetNumberOfStreams(psmfStruct: u32): int` | Returns 1 (we report a single stream). |
| `scePsmfGetNumberOfEPentries(psmfStruct: u32): u32` | No-op stub that returns 0 (no entry-point table entries). |
| `scePsmfGetVideoInfo(psmfStruct: u32, videoInfoAddr: u32): int` | No-op stub that returns 0; no video info is written to the struct. |
| `scePsmfGetAudioInfo(psmfStruct: u32, audioInfoAddr: u32): int` | No-op stub that returns 0; no audio info is written to the struct. |
| `scePsmfGetPresentationStartTime(psmfStruct: u32, startTimeAddr: u32): u32` | No-op stub that returns 0; the start-time pointer is not written. |
| `scePsmfGetPresentationEndTime(psmfStruct: u32, endTimeAddr: u32): u32` | No-op stub that returns 0; the end-time pointer is not written. |
| `scePsmfGetCurrentStreamType(psmfStruct: u32, typeAddr: u32, channelAddr: u32): u32` | No-op stub that returns 0; the type and channel pointers are not written. |
| `scePsmfSpecifyStreamWithStreamType(psmfStruct: u32, streamType: u32, channel: u32): int` | No-op stub that returns 0. Stream selection by type is ignored. |

## Summary

All `scePsmfPlayer` and `scePsmf` calls have real `register()` handlers (none use `kernel.stub()`), but several are no-op handlers that just return 0 as noted above. The video path (`SetPsmf`, `Start`, `Update`, `GetVideoData`) runs through `PsmfDecoder`, and the cutscene audio path (`GetAudioData`) decodes through FFmpeg WASM, both browser-only. The `scePsmf` container-parsing calls are not really implemented (they return fixed constants or 0).
