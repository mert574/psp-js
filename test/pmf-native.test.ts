import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  extractH264FromPsmf,
  parseNalUnits,
  buildAvcC,
  groupAccessUnits,
  auToAvcC,
  type NalUnit,
} from "../src/media/psmf-decoder.js";

const PMF_PATH = join(__dirname, "fixtures/icon1.pmf");
const pmfData = new Uint8Array(readFileSync(PMF_PATH));

const GTA_PMF_PATH = join(__dirname, "fixtures/gta-icon1.pmf");
const gtaPmfData = new Uint8Array(readFileSync(GTA_PMF_PATH));

describe("PSMF decoder pipeline", () => {
  let esData: Uint8Array;
  let nals: NalUnit[];
  let sps: NalUnit;
  let pps: NalUnit;
  let accessUnits: { isKey: boolean; nals: NalUnit[] }[];

  it("extracts H.264 ES from PSMF", () => {
    const result = extractH264FromPsmf(pmfData);
    esData = result.esData;
    expect(esData.length).toBeGreaterThan(0);
    expect(result.width).toBe(144);
    expect(result.height).toBe(80);
  });

  it("parses NAL units correctly", () => {
    if (!esData) esData = extractH264FromPsmf(pmfData).esData;
    nals = parseNalUnits(esData);

    const typeCounts: Record<number, number> = {};
    for (const n of nals) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;

    expect(nals.length).toBeGreaterThan(0);
    expect(typeCounts[7]).toBeGreaterThan(0); // SPS
    expect(typeCounts[8]).toBeGreaterThan(0); // PPS
    expect(typeCounts[5]).toBeGreaterThan(0); // IDR
    expect(typeCounts[9]).toBeGreaterThan(0); // AUD
  });

  it("SPS has valid H.264 profile/level", () => {
    if (!nals) nals = parseNalUnits(extractH264FromPsmf(pmfData).esData);
    sps = nals.find(n => n.type === 7)!;
    pps = nals.find(n => n.type === 8)!;

    expect(sps).toBeDefined();
    expect(pps).toBeDefined();
    expect(sps.data[0] & 0x80).toBe(0); // forbidden_zero_bit
    expect(sps.data[0] & 0x1F).toBe(7); // type
  });

  it("builds valid avcC description", () => {
    if (!sps) {
      const n = parseNalUnits(extractH264FromPsmf(pmfData).esData);
      sps = n.find(nn => nn.type === 7)!;
      pps = n.find(nn => nn.type === 8)!;
    }
    const avcC = buildAvcC(sps.data, pps.data);

    expect(avcC[0]).toBe(1); // configurationVersion
    expect(avcC[1]).toBe(sps.data[1]); // profile
    expect(avcC[4]).toBe(0xFF); // lengthSizeMinusOne = 3
    expect(avcC[5]).toBe(0xE1); // numSPS = 1

    const spsLen = (avcC[6] << 8) | avcC[7];
    expect(spsLen).toBe(sps.data.length);
  });

  it("groups access units with correct keyframe detection", () => {
    if (!nals) nals = parseNalUnits(extractH264FromPsmf(pmfData).esData);
    accessUnits = groupAccessUnits(nals);

    expect(accessUnits.length).toBeGreaterThan(0);
    const keyframes = accessUnits.filter(au => au.isKey);
    expect(keyframes.length).toBeGreaterThan(0);
    expect(keyframes[0].nals.some(n => n.type === 5)).toBe(true);
  });

  it("produces valid avcC chunks", () => {
    if (!nals) nals = parseNalUnits(extractH264FromPsmf(pmfData).esData);
    if (!accessUnits) accessUnits = groupAccessUnits(nals);

    const firstKey = accessUnits.find(au => au.isKey)!;
    const sliceNals = firstKey.nals.filter(n => n.type !== 7 && n.type !== 8 && n.type !== 9);
    const chunk = auToAvcC(sliceNals);

    expect(chunk.length).toBeGreaterThan(0);
    // First 4 bytes should be length prefix
    const firstNalLen = (chunk[0] << 24) | (chunk[1] << 16) | (chunk[2] << 8) | chunk[3];
    expect(firstNalLen).toBe(sliceNals[0].data.length);
  });
});

describe("GTA PSMF decoder pipeline", () => {
  it("extracts H.264 ES from GTA PSMF", () => {
    const result = extractH264FromPsmf(gtaPmfData);
    expect(result.esData.length).toBeGreaterThan(0);
    expect(result.width).toBe(144);
    expect(result.height).toBe(80);
  });

  it("parses NALs with extension types", () => {
    const { esData } = extractH264FromPsmf(gtaPmfData);
    const nals = parseNalUnits(esData);

    const typeCounts: Record<number, number> = {};
    for (const n of nals) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;

    expect(typeCounts[7]).toBeGreaterThan(0); // SPS
    expect(typeCounts[8]).toBeGreaterThan(0); // PPS
    expect(typeCounts[5]).toBeGreaterThan(0); // IDR
    expect(typeCounts[9]).toBeGreaterThan(0); // AUD
  });

  it("groups into ~934 AUs with ~30 keyframes", () => {
    const { esData } = extractH264FromPsmf(gtaPmfData);
    const nals = parseNalUnits(esData);
    const aus = groupAccessUnits(nals);

    expect(aus.length).toBeGreaterThanOrEqual(900);
    const keyframes = aus.filter(au => au.isKey);
    expect(keyframes.length).toBeGreaterThanOrEqual(25);
  });

  it("chunk NALs filtered to types 1-6 are non-empty for keyframes", () => {
    const { esData } = extractH264FromPsmf(gtaPmfData);
    const nals = parseNalUnits(esData);
    const aus = groupAccessUnits(nals);

    const firstKey = aus.find(au => au.isKey)!;
    const chunkNals = firstKey.nals.filter(n => n.type >= 1 && n.type <= 6);
    expect(chunkNals.length).toBeGreaterThan(0);
    expect(chunkNals.some(n => n.type === 5)).toBe(true); // IDR slice
  });
});
