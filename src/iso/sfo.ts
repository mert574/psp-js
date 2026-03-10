export type SfoValue = string | number;
export type SfoData = Record<string, SfoValue>;

export interface GameInfo {
  title: string;
  discId: string;
  category: string;
  version: string;
  region: string;
  parentalLevel: number;
  saveTitle: string;
  saveDetail: string;
}

// DISC_ID prefix → region name
const REGION_MAP: Record<string, string> = {
  UCUS: "North America",
  ULUS: "North America",
  UCES: "Europe",
  ULES: "Europe",
  UCAS: "Asia",
  ULAS: "Asia",
  UCJS: "Japan",
  ULJS: "Japan",
  NPUH: "North America (PSN)",
  NPUG: "North America (PSN)",
  NPEH: "Europe (PSN)",
  NPEG: "Europe (PSN)",
  NPJH: "Japan (PSN)",
  NPJG: "Japan (PSN)",
  NPHG: "Asia (PSN)",
  NPAG: "Asia (PSN)",
};

function regionFromDiscId(discId: string): string {
  const prefix = discId.slice(0, 4).toUpperCase();
  return REGION_MAP[prefix] ?? discId.slice(0, 4);
}

const SFO_MAGIC = 0x00505346; // "\x00PSF" read as big-endian uint32 (bytes: 0x00, 0x50, 0x53, 0x46)

// Data format constants
const FMT_UTF8_SPECIAL = 0x0004;
const FMT_UTF8 = 0x0204;
const FMT_UINT32 = 0x0404;

const utf8Decoder = new TextDecoder("utf-8");

export function parseSfo(buffer: ArrayBuffer): SfoData {
  const view = new DataView(buffer);

  // Validate magic: bytes 0-3 = "\x00PSF" = 0x00, 0x50, 0x53, 0x46
  // Reading as big-endian uint32: 0x00505346
  const magic = view.getUint32(0, false);
  if (magic !== SFO_MAGIC) {
    throw new Error(`Invalid SFO magic: 0x${magic.toString(16).padStart(8, "0")}`);
  }

  const keyTableOffset = view.getUint32(8, true);
  const dataTableOffset = view.getUint32(12, true);
  const entryCount = view.getUint32(16, true);

  const result: SfoData = {};

  for (let i = 0; i < entryCount; i++) {
    const indexBase = 20 + i * 16;

    const keyOffset = view.getUint16(indexBase + 0, true);
    const dataFormat = view.getUint16(indexBase + 2, true);
    const dataLength = view.getUint32(indexBase + 4, true);
    const dataOffset = view.getUint32(indexBase + 12, true);

    // Read null-terminated key from key table
    const keyStart = keyTableOffset + keyOffset;
    let keyEnd = keyStart;
    while (keyEnd < buffer.byteLength && view.getUint8(keyEnd) !== 0) {
      keyEnd++;
    }
    const key = utf8Decoder.decode(new Uint8Array(buffer, keyStart, keyEnd - keyStart));

    // Read value from data table
    const valueStart = dataTableOffset + dataOffset;

    if (dataFormat === FMT_UINT32) {
      result[key] = view.getUint32(valueStart, true);
    } else if (dataFormat === FMT_UTF8 || dataFormat === FMT_UTF8_SPECIAL) {
      // Null-terminated UTF-8 string; dataLength includes the null terminator
      const raw = new Uint8Array(buffer, valueStart, dataLength);
      // Find the null terminator
      let strLen = raw.indexOf(0);
      if (strLen === -1) strLen = dataLength;
      result[key] = utf8Decoder.decode(raw.subarray(0, strLen));
    }
  }

  return result;
}

export function extractGameInfo(sfoData: SfoData): GameInfo {
  const discId = String(sfoData["DISC_ID"] ?? "");
  return {
    title:         String(sfoData["TITLE"] ?? "Unknown"),
    discId,
    category:      String(sfoData["CATEGORY"] ?? ""),
    version:       String(sfoData["APP_VER"] ?? ""),
    region:        discId ? regionFromDiscId(discId) : "",
    parentalLevel: Number(sfoData["PARENTAL_LEVEL"] ?? 0),
    saveTitle:     String(sfoData["SAVEDATA_TITLE"] ?? ""),
    saveDetail:    String(sfoData["SAVEDATA_DETAIL"] ?? ""),
  };
}
