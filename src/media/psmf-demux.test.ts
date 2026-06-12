import { describe, it, expect } from "vitest";
import { PsmfDemux, avcCodecFromAnnexB } from "./psmf-demux.js";

// MPEG-2 pack header (14 bytes, no stuffing).
const PACK = [0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8];

// PTS bytes for 90000 (verified against the demuxer's decode).
const PTS_90000 = [0x21, 0x00, 0x05, 0xbf, 0x21];
function ptsBytes(v: number): number[] {
  const b0 = 0x21 | (((v >> 30) & 7) << 1);
  const b1 = (v >> 22) & 0xff;
  const b2 = (((v >> 15) & 0x7f) << 1) | 1;
  const b3 = (v >> 7) & 0xff;
  const b4 = ((v & 0x7f) << 1) | 1;
  return [b0, b1, b2, b3, b4];
}

function videoPes(pts: number[], payload: number[]): number[] {
  const header = [0x80, 0x80, pts.length, ...pts];
  const len = header.length + payload.length;
  return [0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff, ...header, ...payload];
}

const SPS = [0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x88]; // NAL 7, profile 0x42 lvl 0x1e
// IDR slice (NAL 5). The byte after the NAL header has its top bit set, so
// first_mb_in_slice == 0 -> a new picture starts here.
const IDR = [0x00, 0x00, 0x01, 0x65, 0x88, 0x80];
// Non-IDR slice (NAL 1), also first_mb_in_slice == 0 (new picture).
const SLICE = [0x00, 0x00, 0x01, 0x41, 0x9a, 0x00];

describe("PsmfDemux", () => {
  it("splits the elementary stream into access units on picture boundaries", () => {
    // SPS+IDR are one access unit (the SPS belongs to that picture); the next
    // slice is a second picture, so a second AU. PES/PTS boundaries don't split.
    const stream = new Uint8Array([
      ...PACK,
      ...videoPes(PTS_90000, [...SPS, ...IDR]),
      ...videoPes(ptsBytes(93003), SLICE),
    ]);
    const dem = new PsmfDemux();
    dem.feed(stream);
    dem.end();
    const aus = dem.take();
    expect(aus.length).toBe(2);
    expect(aus[0]!.pts).toBe(90000);
    expect(aus[0]!.keyframe).toBe(true); // SPS + IDR
    expect(Array.from(aus[0]!.data)).toEqual([...SPS, ...IDR]);
    expect(aus[1]!.pts).toBe(93003);
    expect(aus[1]!.keyframe).toBe(false); // plain slice
    expect(Array.from(aus[1]!.data)).toEqual(SLICE);
  });

  it("keeps several slices in one AU until the next picture starts", () => {
    // SPS + IDR, then a slice with first_mb_in_slice != 0 (continuation of the
    // same picture, top bit clear), then a new picture. Two AUs, not three.
    const CONT = [0x00, 0x00, 0x01, 0x41, 0x10, 0x00]; // top bit clear -> same picture
    const stream = new Uint8Array([
      ...PACK,
      ...videoPes(PTS_90000, [...SPS, ...IDR, ...CONT]),
      ...videoPes(ptsBytes(93003), SLICE),
    ]);
    const dem = new PsmfDemux();
    dem.feed(stream);
    dem.end();
    const aus = dem.take();
    expect(aus.length).toBe(2);
    expect(Array.from(aus[0]!.data)).toEqual([...SPS, ...IDR, ...CONT]);
    expect(Array.from(aus[1]!.data)).toEqual(SLICE);
  });

  it("handles data split across multiple feeds (partial packet)", () => {
    const stream = new Uint8Array([
      ...PACK,
      ...videoPes(PTS_90000, [...SPS, ...IDR]),
      ...videoPes(ptsBytes(93003), SLICE),
    ]);
    const dem = new PsmfDemux();
    // Feed in 7-byte slivers so packets straddle feed boundaries.
    for (let i = 0; i < stream.length; i += 7) dem.feed(stream.subarray(i, i + 7));
    dem.end();
    const aus = dem.take();
    expect(aus.length).toBe(2);
    expect(aus[0]!.pts).toBe(90000);
    expect(aus[1]!.pts).toBe(93003);
  });

  it("ignores audio PES (0xBD) and emits only video", () => {
    const audioPes = [0x00, 0x00, 0x01, 0xbd, 0x00, 0x05, 0x80, 0x00, 0x00, 0x00, 0x00];
    const stream = new Uint8Array([...PACK, ...audioPes, ...videoPes(PTS_90000, [...SPS, ...IDR])]);
    const dem = new PsmfDemux();
    dem.feed(stream);
    dem.end();
    const aus = dem.take();
    expect(aus.length).toBe(1);
    expect(aus[0]!.keyframe).toBe(true);
  });

  it("parses an avc1 codec string from an SPS", () => {
    expect(avcCodecFromAnnexB(new Uint8Array(SPS))).toBe("avc1.42001e");
    expect(avcCodecFromAnnexB(new Uint8Array(SLICE))).toBe(null);
  });
});
