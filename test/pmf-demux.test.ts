import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Import the demuxer internals — we need to export them for testing
// For now, inline the key parsing logic to validate the demuxer approach

const PMF_PATH = join(__dirname, "fixtures/icon1.pmf");

function readU16BE(buf: Uint8Array, off: number): number {
  return (buf[off] << 8) | buf[off + 1];
}

function readU32BE(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readPesPts(buf: Uint8Array, off: number): number {
  const b0 = buf[off], b1 = buf[off + 1], b2 = buf[off + 2];
  const b3 = buf[off + 3], b4 = buf[off + 4];
  return ((b0 & 0x0E) * (1 << 29)) +
    (((b1 << 8) | b2) >>> 1) * (1 << 15) +
    (((b3 << 8) | b4) >>> 1);
}

describe("PSMF demuxer", () => {
  const pmfData = new Uint8Array(readFileSync(PMF_PATH));

  it("parses PSMF header correctly", () => {
    const magic = readU32BE(pmfData, 0);
    expect(magic).toBe(0x50534D46); // "PSMF"

    const streamOffset = readU32BE(pmfData, 8);
    const streamSize = readU32BE(pmfData, 12);
    expect(streamOffset).toBe(2048);
    expect(streamSize).toBeGreaterThan(0);
    expect(streamOffset + streamSize).toBeLessThanOrEqual(pmfData.length);

    const numStreams = readU16BE(pmfData, 0x80);
    expect(numStreams).toBeGreaterThan(0);
    expect(numStreams).toBeLessThan(16);

    // First stream should be video (0xE0-0xEF)
    const firstStreamId = pmfData[0x82];
    expect(firstStreamId & 0xF0).toBe(0xE0);

    // Video dimensions
    const widthUnits = pmfData[0x82 + 12];
    const heightUnits = pmfData[0x82 + 13];
    expect(widthUnits * 16).toBeGreaterThan(0);
    expect(heightUnits * 16).toBeGreaterThan(0);
    console.log(`Video: ${widthUnits * 16}x${heightUnits * 16}, streams: ${numStreams}`);
  });

  it("finds MPEG-PS pack headers after streamOffset", () => {
    const streamOffset = readU32BE(pmfData, 8);
    // First bytes should be pack start code: 00 00 01 BA
    expect(pmfData[streamOffset]).toBe(0);
    expect(pmfData[streamOffset + 1]).toBe(0);
    expect(pmfData[streamOffset + 2]).toBe(1);
    expect(pmfData[streamOffset + 3]).toBe(0xBA);
  });

  it("extracts video PES packets with H.264 data", () => {
    const streamOffset = readU32BE(pmfData, 8);
    const streamSize = readU32BE(pmfData, 12);
    const streamEnd = streamOffset + streamSize;

    let pos = streamOffset;
    let videoPackets = 0;
    let totalVideoBytes = 0;
    const ptsList: number[] = [];

    while (pos < streamEnd - 4) {
      if (pmfData[pos] !== 0 || pmfData[pos + 1] !== 0 || pmfData[pos + 2] !== 1) {
        pos++;
        continue;
      }

      const streamId = pmfData[pos + 3];
      pos += 4;

      // Pack header
      if (streamId === 0xBA) {
        if (pos + 9 < streamEnd) {
          const stuffing = pmfData[pos + 9] & 0x07;
          pos += 10 + stuffing;
        }
        continue;
      }

      if (streamId < 0xBC) continue;

      if (pos + 1 >= streamEnd) break;
      const pesLen = readU16BE(pmfData, pos);
      pos += 2;

      // Video stream 0xE0
      if ((streamId & 0xF0) === 0xE0) {
        videoPackets++;
        const pesEnd = Math.min(pos + pesLen, streamEnd);
        if (pos + 2 < pesEnd) {
          const flags2 = pmfData[pos + 1];
          const headerDataLen = pmfData[pos + 2];

          if ((flags2 & 0x80) && headerDataLen >= 5) {
            const pts = readPesPts(pmfData, pos + 3);
            ptsList.push(pts);
          }

          const esStart = pos + 3 + headerDataLen;
          if (esStart < pesEnd) {
            totalVideoBytes += pesEnd - esStart;
          }
        }
        pos = pesEnd;
      } else {
        pos += pesLen;
      }
    }

    console.log(`Video PES packets: ${videoPackets}, total ES bytes: ${totalVideoBytes}`);
    console.log(`PTS values: ${ptsList.map(p => p.toString())}`);
    console.log(`Unique PTS: ${new Set(ptsList).size} → ${new Set(ptsList).size} access units`);

    expect(videoPackets).toBeGreaterThan(0);
    expect(totalVideoBytes).toBeGreaterThan(0);
    expect(ptsList.length).toBeGreaterThan(0);
  });

  it("finds H.264 NAL units in video ES data", () => {
    const streamOffset = readU32BE(pmfData, 8);
    const streamSize = readU32BE(pmfData, 12);
    const streamEnd = streamOffset + streamSize;

    // Collect all video ES data
    const esChunks: Uint8Array[] = [];
    let pos = streamOffset;

    while (pos < streamEnd - 4) {
      if (pmfData[pos] !== 0 || pmfData[pos + 1] !== 0 || pmfData[pos + 2] !== 1) {
        pos++;
        continue;
      }

      const streamId = pmfData[pos + 3];
      pos += 4;

      if (streamId === 0xBA) {
        if (pos + 9 < streamEnd) {
          pos += 10 + (pmfData[pos + 9] & 0x07);
        }
        continue;
      }
      if (streamId < 0xBC) continue;
      if (pos + 1 >= streamEnd) break;

      const pesLen = readU16BE(pmfData, pos);
      pos += 2;

      if ((streamId & 0xF0) === 0xE0) {
        const pesEnd = Math.min(pos + pesLen, streamEnd);
        if (pos + 2 < pesEnd) {
          const headerDataLen = pmfData[pos + 2];
          const esStart = pos + 3 + headerDataLen;
          if (esStart < pesEnd) {
            esChunks.push(pmfData.subarray(esStart, pesEnd));
          }
        }
        pos = pesEnd;
      } else {
        pos += pesLen;
      }
    }

    // Concatenate ES data
    let totalLen = 0;
    for (const c of esChunks) totalLen += c.length;
    const esData = new Uint8Array(totalLen);
    let off = 0;
    for (const c of esChunks) { esData.set(c, off); off += c.length; }

    console.log(`Total ES data: ${esData.length} bytes from ${esChunks.length} PES packets`);

    // Find NAL units
    const nalTypes = new Map<number, number>();
    let hasSPS = false, hasPPS = false, hasIDR = false;

    for (let i = 0; i < esData.length - 4; i++) {
      let scLen = 0;
      if (esData[i] === 0 && esData[i + 1] === 0 && esData[i + 2] === 1) scLen = 3;
      else if (esData[i] === 0 && esData[i + 1] === 0 && esData[i + 2] === 0 && esData[i + 3] === 1) scLen = 4;
      if (scLen > 0) {
        const nalType = esData[i + scLen] & 0x1F;
        nalTypes.set(nalType, (nalTypes.get(nalType) ?? 0) + 1);
        if (nalType === 7) hasSPS = true;
        if (nalType === 8) hasPPS = true;
        if (nalType === 5) hasIDR = true;
      }
    }

    console.log("NAL types found:", Object.fromEntries(nalTypes));

    expect(hasSPS).toBe(true);
    expect(hasPPS).toBe(true);
    expect(hasIDR).toBe(true);

    // Count AUD boundaries (the real number of access units)
    const audCount = nalTypes.get(9) ?? 0;
    console.log(`AUD count: ${audCount} (= real number of access units, NOT 6)`);
    expect(audCount).toBeGreaterThan(6);

    // Verify SPS content
    for (let i = 0; i < esData.length - 8; i++) {
      if (esData[i] === 0 && esData[i + 1] === 0 && esData[i + 2] === 0 && esData[i + 3] === 1) {
        const nalType = esData[i + 4] & 0x1F;
        if (nalType === 7) {
          const profile = esData[i + 5];
          const compat = esData[i + 6];
          const level = esData[i + 7];
          console.log(`SPS: profile=${profile.toString(16)}, compat=${compat.toString(16)}, level=${level.toString(16)}`);
          console.log(`Codec string: avc1.${profile.toString(16).padStart(2,'0')}${compat.toString(16).padStart(2,'0')}${level.toString(16).padStart(2,'0')}`);
          break;
        }
      }
    }
  });
});
