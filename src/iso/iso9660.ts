const SECTOR_SIZE = 2048;
const PVD_SECTOR = 16;

export interface IsoFile {
  name: string;
  isDirectory: boolean;
  lba: number;
  size: number;
  children?: IsoFile[];
}

export interface IsoVolume {
  volumeId: string;
  root: IsoFile;
}

const decoder = new TextDecoder("ascii");

export function parseIso(buffer: ArrayBuffer): IsoVolume {
  const view = new DataView(buffer);
  const pvdOffset = PVD_SECTOR * SECTOR_SIZE;

  // Validate Primary Volume Descriptor
  const type = view.getUint8(pvdOffset);
  if (type !== 1) {
    throw new Error(`Expected PVD type 1, got ${type}`);
  }

  const identBytes = new Uint8Array(buffer, pvdOffset + 1, 5);
  const ident = decoder.decode(identBytes);
  if (ident !== "CD001") {
    throw new Error(`Invalid ISO 9660 identifier: "${ident}"`);
  }

  // Volume identifier: bytes 40-71 (32 bytes), ASCII, right-padded with spaces
  const volIdBytes = new Uint8Array(buffer, pvdOffset + 40, 32);
  const volumeId = decoder.decode(volIdBytes).trimEnd();

  // Root directory record is embedded at PVD offset 156, fixed 34 bytes
  const rootRecord = readDirRecord(buffer, pvdOffset + 156);
  if (rootRecord === null) {
    throw new Error("Failed to read root directory record from PVD");
  }

  // Populate children of root
  rootRecord.children = readDirectory(buffer, rootRecord.lba, rootRecord.size);

  return { volumeId, root: rootRecord };
}

function readDirRecord(buffer: ArrayBuffer, recordOffset: number): IsoFile | null {
  const view = new DataView(buffer);

  const recordLength = view.getUint8(recordOffset);
  if (recordLength === 0) {
    return null;
  }

  // LBA: 4 bytes LE at offset +2
  const lba = view.getUint32(recordOffset + 2, true);
  // Data length: 4 bytes LE at offset +10
  const size = view.getUint32(recordOffset + 10, true);
  // File flags at offset +25: bit 1 = directory
  const flags = view.getUint8(recordOffset + 25);
  const isDirectory = (flags & 0x02) !== 0;
  // File identifier length at offset +32
  const identLen = view.getUint8(recordOffset + 32);
  // File identifier at offset +33
  const identBytes = new Uint8Array(buffer, recordOffset + 33, identLen);

  let name: string;
  if (identLen === 1 && (identBytes[0] === 0x00 || identBytes[0] === 0x01)) {
    // Special entries: . and ..
    name = identBytes[0] === 0x00 ? "." : "..";
  } else {
    name = decoder.decode(identBytes);
    // Strip version suffix (e.g. ";1")
    const semicolonIdx = name.indexOf(";");
    if (semicolonIdx !== -1) {
      name = name.slice(0, semicolonIdx);
    }
  }

  return { name, isDirectory, lba, size };
}

function readDirectory(buffer: ArrayBuffer, lba: number, size: number): IsoFile[] {
  const files: IsoFile[] = [];
  const sectorOffset = lba * SECTOR_SIZE;
  let pos = 0;

  while (pos < size) {
    const recordOffset = sectorOffset + pos;
    const view = new DataView(buffer);
    const recordLength = view.getUint8(recordOffset);

    if (recordLength === 0) {
      // Padding: advance to next sector boundary
      const nextSectorBoundary = (Math.floor(pos / SECTOR_SIZE) + 1) * SECTOR_SIZE;
      if (nextSectorBoundary >= size) break;
      pos = nextSectorBoundary;
      continue;
    }

    const entry = readDirRecord(buffer, recordOffset);
    if (entry !== null && entry.name !== "." && entry.name !== "..") {
      if (entry.isDirectory) {
        entry.children = readDirectory(buffer, entry.lba, entry.size);
      }
      files.push(entry);
    }

    pos += recordLength;
  }

  return files;
}

export function readFile(buffer: ArrayBuffer, file: IsoFile): Uint8Array {
  const offset = file.lba * SECTOR_SIZE;
  return new Uint8Array(buffer, offset, file.size);
}
