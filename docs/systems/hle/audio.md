# Audio (`hle-audio.ts`)

Implements `sceAudio` (PCM output channels), `sceAtrac` (ATRAC3+ decode), and `sceAudiocodec`. The handlers read the engine from `kernel.audioEngine`, so audio calls silently no-op until the frontend sets up audio and the browser's `AudioContext` is unlocked by a user gesture; the game's audio thread keeps running in the meantime.

## sceAudio (PCM output)

| Signature | What it does |
| --- | --- |
| `sceAudioChReserve(chan: int, sampleCount: u32, format: u32): u32` | Reserves a PCM channel and returns its index. Always succeeds even when audio is off: it records the channel state (the blocking output calls read `sampleCount` to know how long to wait), and with no engine at all it hands back a fake index so the game proceeds. |
| `sceAudioChRelease(chan: u32): u32` | Frees a reserved channel and returns 0. |
| `sceAudioOutput(chan: u32, vol: int, samplePtr: u32): u32` | Reads `sampleCount` samples from RAM and adds them to the channel queue, then returns the queued sample count. Non-blocking, single volume for both speakers. |
| `sceAudioOutputBlocking(chan: u32, vol: int, samplePtr: u32): u32` | Same as `sceAudioOutput` but blocks the thread for the buffer duration and returns 0. Blocks even when audio is off so the audio thread does not spin forever. |
| `sceAudioOutputPanned(chan: u32, leftvol: int, rightvol: int, samplePtr: u32): u32` | Like `sceAudioOutput` with separate left and right volume. Non-blocking. |
| `sceAudioOutputPannedBlocking(chan: u32, leftvol: int, rightvol: int, samplePtr: u32): u32` | Like `sceAudioOutputPanned` but blocks for the buffer duration and returns 0. |
| `sceAudioChangeChannelVolume(chan: u32, leftvol: u32, rightvol: u32): u32` | Stores the left and right volume on the channel and returns 0. |
| `sceAudioChangeChannelConfig(chan: u32, format: u32): u32` | Stores the channel format (mono/stereo) and returns 0. |
| `sceAudioSetChannelDataLen(chan: u32, len: u32): u32` | Sets the channel's sample count and returns 0. |
| `sceAudioGetChannelRestLen(chan: u32): int` | Returns the number of samples still queued for playback (from the engine, or 0 when audio is off). |
| `sceAudioGetChannelRestLength(chan: u32): int` | Same as `sceAudioGetChannelRestLen`; a separate NID with identical behavior. |

### sceAudioSRC (sample-rate-converted output)

| Signature | What it does |
| --- | --- |
| `sceAudioSRCChReserve(sampleCount: u32, freq: u32, format: u32): u32` | Reserves the single SRC output channel at the given sample rate and returns 0. |
| `sceAudioSRCChRelease(): u32` | Frees the SRC channel and returns 0. |
| `sceAudioSRCOutputBlocking(vol: u32, buf: u32): u32` | Reads stereo PCM from `buf`, adds it to SRC channel 8, and blocks for the buffer duration (at the reserved SRC rate). Returns the queued sample count, or 0 when the engine is off. |

### sceAudioOutput2 (single shared stereo channel, index 9)

| Signature | What it does |
| --- | --- |
| `sceAudioOutput2Reserve(sampleCount: u32): u32` | Reserves the shared stereo Output2 channel and returns 0. |
| `sceAudioOutput2Release(): u32` | Frees the Output2 channel and returns 0. |
| `sceAudioOutput2OutputBlocking(vol: u32, dataPtr: u32): u32` | Reads stereo s16 PCM from `dataPtr`, adds it to channel 9, and blocks for the buffer duration. Returns the queued sample count, or 0 when the engine is off. |
| `sceAudioOutput2GetRestSample(): u32` | Returns the number of samples still queued (from the engine, or 0 when audio is off). |

## sceAtrac (ATRAC3+)

Decoding goes through the ATRAC decoder (`@ffmpeg/ffmpeg`); see [Audio assets](/systems/audio-assets). Up to 6 ATRAC IDs exist at once.

| Signature | What it does |
| --- | --- |
| `sceAtracSetDataAndGetID(buffer: u32, bufferSize: int): int` | Parses the AT3 header at `buffer`, allocates a free ATRAC ID, starts an async decode of the whole buffer, and returns the new ID (or an error when no ID is free). |
| `sceAtracSetHalfwayBufferAndGetID(buffer: u32, readSize: u32, bufferSize: u32): int` | Same as above for a partially-filled streaming buffer: sets the context ALL_DATA_LOADED when `readSize == bufferSize`, otherwise HALFWAY_BUFFER. Returns the new ID. |
| `sceAtracGetAtracID(codecType: int): u32` | Allocates an empty ATRAC ID for low-level decode (no data yet). Errors on an unknown codec type. |
| `sceAtracSetData(atracID: int, buffer: u32, bufferSize: u32): u32` | Re-reads the buffer into an existing ID and starts a fresh decode. Returns 0, or a bad-ID error. |
| `sceAtracSetHalfwayBuffer(atracID: int, buffer: u32, readSize: u32, bufferSize: u32): u32` | Like `sceAtracSetData` for a partial streaming buffer on an existing ID; sets the context HALFWAY_BUFFER. Returns 0. |
| `sceAtracAddStreamData(atracID: int, bytesToAdd: u32): u32` | Called when the game has written more compressed data into its ring buffer. Re-reads the buffer from RAM and decodes again. Returns an ALL_DATA_LOADED error if the stream was already fully loaded. |
| `sceAtracDecodeData(atracID: int, outAddr: u32, numSamplesAddr: u32, finishFlagAddr: u32, remainAddr: u32): u32` | Writes the next decoded PCM frame (or silence) to `outAddr` and updates the sample-count, finish-flag, and remain-frame out-params. If the decode is still running it blocks the thread and writes the output from the wake callback. Handles loop wrapping via the loop count. |
| `sceAtracGetRemainFrame(atracID: int, remainAddr: u32): u32` | Writes the frames still left in the buffer (or -1 for ALL_DATA_LOADED) and returns 0. Bad-ID error if the context is gone. |
| `sceAtracGetStreamDataInfo(atracID: int, writePtrAddr: u32, writableBytesAddr: u32, readOffsetAddr: u32): u32` | Writes the streaming write-pointer, writable byte count, and read offset so the game knows where to refill its ring. For a streaming context it computes these from the ring state; for a fully-loaded context the writable count and read offset are 0. Returns 0. |
| `sceAtracGetNextSample(atracID: int, outNAddr: u32): u32` | Writes the number of samples the next `sceAtracDecodeData` will produce (the frame size). Returns 0. |
| `sceAtracGetSoundSample(atracID: int, outEndSampleAddr: u32, outLoopStartSampleAddr: u32, outLoopEndSampleAddr: u32): u32` | Writes the track's end sample plus the loop start/end samples from the parsed header. Returns 0. |
| `sceAtracGetMaxSample(atracID: int, maxSamplesAddr: u32): u32` | Writes the max samples per decode call (the frame size). Returns 0. |
| `sceAtracGetNextDecodePosition(atracID: int, outposAddr: u32): u32` | Writes the current decode position in samples and returns 0. |
| `sceAtracGetChannel(atracID: int, channelAddr: u32): u32` | Writes the channel count (1 or 2) and returns 0. |
| `sceAtracGetBitrate(atracID: int, outBitrateAddr: u32): u32` | Writes a fixed bitrate (132) and returns 0. Not derived from the real stream. |
| `sceAtracGetLoopStatus(atracID: int, loopNumAddr: u32, statusAddr: u32): u32` | Writes the stored loop count and a status of 0, then returns 0. |
| `sceAtracSetLoopNum(atracID: int, loopNum: int): u32` | Stores the loop count (-1 = forever, N > 0 = N times). Errors with NO_LOOP_INFORMATION when the track has no loop points. |
| `sceAtracGetSecondBufferInfo(atracID: int, fileOffsetAddr: u32, desiredSizeAddr: u32): u32` | Writes zeros for both out-params and returns 0; we never use a second buffer. |
| `sceAtracGetOutputChannel(atracID: int, outputChanPtr: u32): int` | Writes a fixed output channel count of 2 and returns 0. |
| `sceAtracIsSecondBufferNeeded(atracID: int): int` | Validates the ID's status, then returns 1 only for STREAMED_LOOP_WITH_TRAILER. Since we buffer the whole stream this is normally 0. |
| `sceAtracReleaseAtracID(atracID: int): u32` | Deletes the context and returns the slot to the free pool. Bad-ID error if it was already freed. |
| `sceAtracReinit(at3Count: int, at3plusCount: int): int` | Reassigns the codec type of the ID slots (AT3+ slots cost double). Returns BUSY if any ID is still in use; `(0, 0)` deinitializes. |
| `sceAtracResetPlayPosition(atracID: int, sample: int, bytesWrittenFirstBuf: int, bytesWrittenSecondBuf: int): u32` | Sets the decode position to `sample` (clamped to the track length) and returns 0. |
| `sceAtracGetInternalErrorInfo(atracID: int, errorAddr: u32): u32` | Writes 0 (no error) and returns 0. |
| `sceAtracGetBufferInfoForResetting(atracID: int, sample: int, bufferInfoAddr: u32): u32` | Writes a zeroed 16-byte buffer-info struct and returns 0. Registered under both NIDs: the misspelled export `sceAtracGetBufferInfoForReseting` (0xca3ca3d2) and the correct spelling (0x2dd3e298), same handler. |

### sceAtrac stubs

No-op stubs (return 0, or 1 where noted) for functions we do not implement: `_sceAtracGetContextAddress` (returns 1), `sceAtracLowLevelDecode`, `sceAtracLowLevelInitDecoder`, `sceAtracReleaseResources`, `sceAtracSetAA3DataAndGetID`, `sceAtracSetAA3HalfwayBufferAndGetID`, `sceAtracSetMOutData`, `sceAtracSetMOutDataAndGetID`, `sceAtracSetMOutHalfwayBuffer`, `sceAtracSetMOutHalfwayBufferAndGetID`, `sceAtracSetSecondBuffer`, `sceAtracStartEntry`.

## sceAudiocodec

The lower-level codec interface some games use instead of `sceAtrac`. Calls operate on a 128-byte `SceAudiocodecCodec` struct in RAM whose pointer is `ctxPtr`; `codec` is 0x1000 (AT3+), 0x1001 (AT3), 0x1002 (MP3), or 0x1003 (AAC).

| Signature | What it does |
| --- | --- |
| `sceAudiocodecCheckNeedMem(ctxPtr: u32, codec: int): int` | Writes the per-codec working-memory size into the struct and returns 0. Bad-argument error for an unknown codec. |
| `sceAudiocodecGetEDRAM(ctxPtr: u32, codec: int): int` | Writes a fake EDRAM allocation and aligned address into the struct and returns 0. No real EDRAM is reserved. |
| `sceAudiocodecReleaseEDRAM(ctxPtr: u32, id: int): int` | Drops our per-context decoder state for `ctxPtr` and returns 0. |
| `sceAudiocodecInit(ctxPtr: u32, codec: int): int` | Writes the firmware-version and error fields, creates the per-context decoder state (an MP3 frame accumulator for MP3), and returns 0. |
| `sceAudiocodecInitMono(ctxPtr: u32, codec: int): int` | Same as `sceAudiocodecInit`; used by `sceAtrac` for the MOut functions. |
| `sceAudiocodecGetInfo(ctxPtr: u32, codec: int): int` | For MP3, fills the expected MP3 response fields in the struct; returns 0. |
| `sceAudiocodecGetOutputBytes(ctxPtr: u32, codec: int, outBytesAddr: u32): int` | Writes the per-codec output frame size in bytes and returns 0. |
| `sceAudiocodecDecode(ctxPtr: u32, codec: int): int` | Reads one compressed frame from the struct's input pointer, decodes it async (MP3 goes through the frame accumulator for the bit reservoir), blocks the thread, then writes the PCM (or silence on failure) to the output pointer and updates the sample-count fields. |

## Other stubs

This module also holds a large number of no-op stubs (over 100) for less-common audio functions, grouped by API: `sceAudio` input and routing helpers, `sceVaudio`, `sceAac`, `sceMp3`, and `sceMp4`.
