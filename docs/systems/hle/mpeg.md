# sceMpeg (`hle-mpeg.ts`)

Implements `sceMpeg`, the lower-level video API. The ringbuffer accounting, PSMF header analysis, access-unit bookkeeping, and the ringbuffer-fill callback follow PPSSPP faithfully, so a game sees correct buffer flow, advancing timestamps, and a clean end of stream. Real video decode is browser-only; under Node (tests, headless tools) it is skipped and the video path writes black frames. Audio decode always writes silence. Every handler in this module is real (no `kernel.stub()` calls), within the black-frame / silent-audio limitation.

For the actual cutscene playback path that games more commonly use, see [scePsmfPlayer](/systems/hle/psmf-player).

## Lifecycle and memory

| Signature | What it does |
| --- | --- |
| `sceMpegInit(): int` | Per-instance MPEG library init. Returns 0. |
| `sceMpegFinish(): int` | Counterpart to `sceMpegInit`. Returns 0. |
| `sceMpegCreate(mpeg: u32, data: u32, size: u32, ringbuffer: u32, frameWidth: u32, mode: u32, ddrTop: u32): int` | Sets up an MPEG instance. The real handle struct lives in the work buffer at `data + 0x30`: it gets the `LIBMPEG\0001\0` marker, and `mpeg` just holds a pointer to it (PPSSPP sceMpeg.cpp:491). Links the ringbuffer and creates our `MpegContext` (with a real `MpegMediaDecoder` in the browser, `null` headless). Fails with `NO_MEMORY` if `size < 0x10000`. |
| `sceMpegDelete(mpeg: u32): int` | Disposes the instance's decoder and drops its context. Returns 0. |
| `sceMpegQueryMemSize(mode: u32): int` | Returns the fixed instance memory size `0x10000`. |
| `sceMpegMallocAvcEsBuf(mpeg: u32): int` | Hands out one of two AVC ES buffer slots (returns 1 or 2), or 0 when both are taken. |
| `sceMpegFreeAvcEsBuf(mpeg: u32, esBuf: int): int` | Releases the slot taken by `sceMpegMallocAvcEsBuf`. Returns 0. |

## Stream queries

| Signature | What it does |
| --- | --- |
| `sceMpegQueryStreamOffset(mpeg: u32, buffer: u32, offsetAddr: u32): int` | Runs the PSMF header analysis on `buffer` and writes the payload offset to `offsetAddr`. Returns `INVALID_VALUE` if the magic is wrong or the offset is not a 2048-byte multiple. |
| `sceMpegQueryStreamSize(buffer: u32, sizeAddr: u32): u32` | Reads the byte-swapped stream size out of the PSMF header directly (no MPEG handle) and writes it to `sizeAddr`. Returns `INVALID_VALUE` on a bad magic. |
| `sceMpegQueryAtracEsSize(mpeg: u32, esSizeAddr: u32, outSizeAddr: u32): int` | Writes the ATRAC ES sizes: `2112` to `esSizeAddr` and `8192` to `outSizeAddr`. Returns 0. |
| `sceMpegQueryPcmEsSize(mpeg: u32, esSizeAddr: u32, outSizeAddr: u32): int` | Writes `320` to both size pointers. Returns 0. |

## Ringbuffer

| Signature | What it does |
| --- | --- |
| `sceMpegRingbufferQueryMemSize(packets: int): u32` | Returns the ringbuffer memory size, `packets * (104 + 2048)`. |
| `sceMpegRingbufferConstruct(ringbuffer: u32, numPackets: u32, data: u32, size: u32, callbackAddr: u32, callbackArg: u32): u32` | Lays out the `SceMpegRingBuffer` struct: packet counts, packet size 2048, data pointer, the fill callback and its arg, and the upper bound. Fails with `NO_MEMORY` if `size < 0`. |
| `sceMpegRingbufferDestruct(ringbuffer: u32): u32` | No-op. Returns 0. |
| `sceMpegRingbufferAvailableSize(ringbuffer: u32): int` | Returns free packet slots, `packets - packetsAvail`. |
| `sceMpegRingbufferPut(ringbuffer: u32, numPackets: int, available: int): u32` | Calls the game's fill callback `cb(dataPtr, n, arg)` via the mini-CPU call to pull compressed packets off the disc, advances the ringbuffer pointers by however many the callback returned, and feeds the new Program Stream bytes to the real decoder (browser). Returns the total packets added, or the first error code if nothing was added. |

## Streams

| Signature | What it does |
| --- | --- |
| `sceMpegRegistStream(mpeg: u32, streamType: u32, streamNum: u32): int` | Registers an audio or video stream and returns a new stream id. Returns -1 if the MPEG handle is unknown. |
| `sceMpegUnRegistStream(mpeg: u32, streamUid: int): u32` | Removes a registered stream from the instance. Returns 0. |

## Access units

| Signature | What it does |
| --- | --- |
| `sceMpegInitAu(mpeg: u32, buffer: u32, auPointer: u32): int` | Initializes a `SceMpegAu` at `auPointer`. An ES-buffer id in `buffer` makes it an AVC AU (es size 2048); otherwise it is an ATRAC AU (es size 2112) with dts set to UNKNOWN. |
| `sceMpegGetAvcAu(mpeg: u32, streamId: u32, auAddr: u32, attrAddr: u32): int` | Fills the next video AU with a pts derived from `videoFrameCount` and the per-stream number, writes attr 1. Returns `NO_DATA` when the ringbuffer is empty or the stream has ended. |
| `sceMpegGetAtracAu(mpeg: u32, streamId: u32, auAddr: u32, attrAddr: u32): int` | Same as `sceMpegGetAvcAu` for audio: pts from `audioFrameCount`, dts UNKNOWN, attr 0. Returns `NO_DATA` at end of audio. |

## Video decode

| Signature | What it does |
| --- | --- |
| `sceMpegAvcDecode(mpeg: u32, auAddr: u32, frameWidth: u32, buffer: u32, initAddr: u32): u32` | Advances one video frame (consumes packets, bumps the AU pts) and writes it to the framebuffer at `*buffer`. The frame is the real decoded picture in the browser, or a black fill with a name/frame-counter overlay headless. Sets `*initAddr = 1` (decode success). Returns `AVC_DECODE_FATAL` when there is no data. |
| `sceMpegAvcDecodeYCbCr(mpeg: u32, auAddr: u32, buffer: u32, initAddr: u32): int` | Decodes one frame but does not draw it; the frame is held in the context until `sceMpegAvcCsc` writes it out (Burnout Legends uses this path). Sets `*initAddr = 1`. Returns `AVC_DECODE_FATAL` when there is no data. |
| `sceMpegAvcCsc(mpeg: u32, source: u32, rangeAddr: u32, frameWidth: int, dest: u32): u32` | Color-converts the frame held by `sceMpegAvcDecodeYCbCr` into `dest` at the (x, y) read from `rangeAddr`. Returns `INVALID_VALUE` on a negative offset. |
| `sceMpegAvcQueryYCbCrSize(mpeg: u32, mode: u32, width: u32, height: u32, resultAddr: u32): int` | Writes the YCbCr work-buffer size `(width/2)*(height/2)*6 + 128` to `resultAddr`. Returns `INVALID_VALUE` for non-16-aligned or oversized dimensions. |
| `sceMpegAvcInitYCbCr(mpeg: u32, mode: int, width: int, height: int, ycbcr: u32): u32` | No-op. Returns 0. |
| `sceMpegAvcDecodeStop(mpeg: u32, frameWidth: u32, buffer: u32, statusAddr: u32): u32` | Writes 0 (no remaining frames) to `statusAddr`. Returns 0. |
| `sceMpegAvcDecodeDetail(mpeg: u32, detailAddr: u32): int` | Fills the detail struct: decode result, `videoFrameCount`, frame width and height, and the frame-status flag. Returns 0. |
| `sceMpegAvcDecodeMode(mpeg: u32, modeAddr: u32): int` | Reads the pixel mode (0=5650, 1=5551, 2=4444, 3=8888) from `modeAddr + 4` and stores it on the context for later draws. Returns 0. |

## Audio decode and flush

| Signature | What it does |
| --- | --- |
| `sceMpegAtracDecode(mpeg: u32, auAddr: u32, buffer: u32, init: int): u32` | Consumes one audio packet, writes 8192 bytes of silence to `buffer`, and advances the AU pts. Real ATRAC decode is not wired here. Returns 0. |
| `sceMpegFlushAllStream(mpeg: u32): u32` | Resets the ringbuffer pointers, frame counts, and end-of-stream flags. Returns 0. |
