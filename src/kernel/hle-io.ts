/**
 * HLE I/O handlers for sceIo and kernel stdio.
 */

import { Logger } from "../utils/logger.js";
import type { HLEKernel } from "./hle-kernel.js";
import type { MemoryBus } from "../memory/memory-bus.js";
import { ThreadState, WaitType } from "./hle-kernel.js";
import { IO, NP_DRM, USB, USB_ACC, USB_GPS, USB_MIC } from "./nids.js";
import type { PspFileInfo } from "./psp-filesystem.js";
import { kirkCreate, kirkInit, type KirkState } from "../crypto/kirk.js";
import { pgdOpen, pgdDecryptBlock, type PgdDesc } from "../crypto/amctrl.js";

const log = Logger.get("HLE-IO");
const pspLog = Logger.get("PSP");

export function registerIoHLE(kernel: HLEKernel): void {

  /** Open file descriptors: fd → FileNode.
   *  Mirrors PPSSPP sceIo.cpp FileNode — asyncResult is s64, hasAsyncResult
   *  tracks whether a result is ready for sceIoPollAsync/WaitAsync to consume. */
  interface FileNode {
    path: string;
    data: Uint8Array;
    position: number;
    asyncResult: number;       // s64 result of last async op (PPSSPP FileNode::asyncResult)
    hasAsyncResult: boolean;   // PPSSPP FileNode::hasAsyncResult — true when result ready to read
    npdrm: boolean;            // PPSSPP FileNode::npdrm — true when PGD decryption active
    pgdOffset: number;         // PPSSPP FileNode::pgd_offset — offset of PGD header within file
    pgdInfo: PgdDesc | null;   // PPSSPP FileNode::pgdInfo — PGD descriptor for decryption
  }
  const openFiles = new Map<number, FileNode>();
  let nextFd = 3; // 0/1/2 reserved for stdin/stdout/stderr

  // KIRK crypto engine — initialized once, shared across all DRM operations
  const kirk: KirkState = kirkCreate();
  kirkInit(kirk);

  /** Open directory handles: fd → listing + cursor */
  interface DirListing {
    entries: PspFileInfo[];
    index: number;
  }
  const openDirs = new Map<number, DirListing>();

  /** Write SceIoStat (88 bytes) to guest memory at addr. */
  function writeIoStat(bus: MemoryBus, addr: number, info: PspFileInfo): void {
    // st_mode: directory = 0x1016f, file = 0x2016f (matches PPSSPP defaults)
    bus.writeU32(addr + 0, info.isDirectory ? 0x1016f : 0x2016f);
    // st_attr: directory = 0x0010, file = 0x0024 (archive bit)
    bus.writeU32(addr + 4, info.isDirectory ? 0x0010 : 0x0024);
    // st_size (u64 LE)
    bus.writeU32(addr + 8, info.size & 0xFFFFFFFF);
    bus.writeU32(addr + 12, 0); // high 32 bits
    // st_ctime, st_atime, st_mtime — fixed date 2024-01-01
    for (let t = 0; t < 3; t++) {
      const base = addr + 16 + t * 16;
      // ScePspDateTime: year(s16), month(s16), day(s16), hour(s16), minute(s16), second(s16), microsecond(u32)
      bus.writeU16(base + 0, 2024);  // year
      bus.writeU16(base + 2, 1);     // month
      bus.writeU16(base + 4, 1);     // day
      bus.writeU16(base + 6, 0);     // hour
      bus.writeU16(base + 8, 0);     // minute
      bus.writeU16(base + 10, 0);    // second
      bus.writeU32(base + 12, 0);    // microsecond
    }
    // st_private[6]
    for (let i = 0; i < 6; i++) bus.writeU32(addr + 64 + i * 4, 0);
  }

  // PPSSPP sceIo.cpp:871-877: return PSP_STDIN/STDOUT/STDERR (fd 0/1/2)
  kernel.register(IO.sceKernelStdin, (regs) => { regs.setGpr(2, 0); });
  kernel.register(IO.sceKernelStdout, (regs) => { regs.setGpr(2, 1); });
  kernel.register(IO.sceKernelStderr, (regs) => { regs.setGpr(2, 2); });

  // Special fds for pspautotests: host0:/__testoutput.txt → fd 100, host0:/__testerror.txt → fd 101
  const TEST_OUTPUT_FD = 100;
  const TEST_ERROR_FD = 101;

  /** Check if fd is stdout-like (real stdout/stderr or test output fds). */
  function isStdoutFd(fd: number): boolean {
    return fd === 1 || fd === 2 || fd === TEST_OUTPUT_FD || fd === TEST_ERROR_FD;
  }

  // sceIoWrite(fd, data, size)
  kernel.register(IO.sceIoWrite, (regs, bus) => {
    const fd   = regs.getGpr(4);
    const data = regs.getGpr(5);
    const size = regs.getGpr(6);
    if (isStdoutFd(fd) && size > 0) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = bus.readU8(data + i);
      const text = new TextDecoder().decode(bytes);
      if (kernel.stdoutBuffer !== null) kernel.stdoutBuffer.push(text);
      pspLog.info(`${text.replace(/\n$/, "")}`);
    }
    kernel.ioOpsCount++;
    regs.setGpr(2, size);
  });

  // sceIoOpen(filename, flags, mode) → fd or error
  kernel.register(IO.sceIoOpen, (regs, bus) => {
    const pathAddr = regs.getGpr(4);
    const path = kernel.readCString(bus, pathAddr);
    if (!path) {
      log.warn(`sceIoOpen: null/empty path (addr=0x${pathAddr.toString(16)})`);
      regs.setGpr(2, 0x80010002); // SCE_ERROR_ERRNO_ENOENT
      return;
    }
    // pspautotests: intercept host0:/__testoutput.txt and host0:/__testerror.txt
    if (path === "host0:/__testoutput.txt") {
      log.debug(`sceIoOpen: test output fd=${TEST_OUTPUT_FD}`);
      regs.setGpr(2, TEST_OUTPUT_FD);
      return;
    }
    if (path === "host0:/__testerror.txt") {
      log.debug(`sceIoOpen: test error fd=${TEST_ERROR_FD}`);
      regs.setGpr(2, TEST_ERROR_FD);
      return;
    }
    // pspautotests: __testfinish.txt signals test completion
    if (path === "host0:/__testfinish.txt") {
      log.debug("sceIoOpen: test finish marker — halting");
      regs.setGpr(2, 99); // dummy fd
      return;
    }
    const fileBytes = kernel.pspFs.getFileData(path, kernel.currentThreadId);
    if (!fileBytes) {
      const level = path.startsWith("ms0:") || path.startsWith("host0:") ? "debug" : "warn";
      log[level](`sceIoOpen: file not found: ${path}`);
      regs.setGpr(2, 0x80010002);
      return;
    }
    const fd = nextFd++;
    openFiles.set(fd, { path, data: fileBytes, position: 0, asyncResult: 0, hasAsyncResult: false, npdrm: false, pgdOffset: 0, pgdInfo: null });
    log.info(`sceIoOpen: fd=${fd} path=${path}`);
    regs.setGpr(2, fd);
  });

  // sceIoClose(fd)
  kernel.register(IO.sceIoClose, (regs) => {
    const fd = regs.getGpr(4);
    openFiles.delete(fd);
    regs.setGpr(2, 0);
  });

  // npdrmRead — PPSSPP sceIo.cpp:998-1043 — read through PGD block decryption
  function npdrmRead(file: FileNode, bus: MemoryBus, destAddr: number, size: number): number {
    const pgd = file.pgdInfo!;

    // PPSSPP sceIo.cpp:1011-1012: clamp size to data_size
    if (size > pgd.dataSize) size = pgd.dataSize;

    let block  = (pgd.fileOffset / pgd.blockSize) | 0;
    let offset = pgd.fileOffset % pgd.blockSize;
    let remainSize = size;
    let dataPtr = 0;

    while (remainSize > 0) {
      // Decrypt block if not cached — PPSSPP sceIo.cpp:1019-1025
      if (pgd.currentBlock !== block) {
        const blockPos = block * pgd.blockSize;
        const fileBlockStart = pgd.dataOffset + blockPos;
        const available = Math.min(pgd.blockSize, file.data.length - fileBlockStart);
        if (available > 0) {
          pgd.blockBuf.set(file.data.subarray(fileBlockStart, fileBlockStart + available));
        }
        if (available < pgd.blockSize) pgd.blockBuf.fill(0, Math.max(0, available), pgd.blockSize);
        pgdDecryptBlock(kirk, pgd, block);
        pgd.currentBlock = block;
      }

      // PPSSPP sceIo.cpp:1027-1035
      let copySize: number;
      if (offset + remainSize > pgd.blockSize) {
        copySize = pgd.blockSize - offset;
      } else {
        copySize = remainSize;
      }

      for (let i = 0; i < copySize; i++) {
        bus.writeU8(destAddr + dataPtr + i, pgd.blockBuf[offset + i]!);
      }

      if (offset + remainSize > pgd.blockSize) {
        block += 1;
        offset = 0;
      }

      dataPtr += copySize;
      remainSize -= copySize;
      pgd.fileOffset += copySize;
    }

    return size;
  }

  // npdrmLseek — PPSSPP sceIo.cpp:1365-1389
  function npdrmLseek(file: FileNode, where: number, whence: number): number {
    const pgd = file.pgdInfo!;
    let newPos: number;
    if (whence === 0) { // SEEK_SET
      newPos = where;
    } else if (whence === 1) { // SEEK_CUR
      newPos = pgd.fileOffset + where;
    } else { // SEEK_END
      newPos = pgd.dataSize + where;
    }
    if (newPos < 0 || newPos > pgd.dataSize) return -1;
    pgd.fileOffset = newPos;
    return newPos;
  }

  // sceIoRead(fd, buf, size) → bytes read
  // PPSSPP sceIo.cpp:1131-1160: reads data then delays via hleDelayResult
  // (blocks the thread for size/100 µs, min 100µs).
  kernel.register(IO.sceIoRead, (regs, bus) => {
    const fd   = regs.getGpr(4);
    const buf  = regs.getGpr(5);
    const size = regs.getGpr(6);
    const file = openFiles.get(fd);
    if (!file) {
      regs.setGpr(2, 0x80010002); // SCE_ERROR_ERRNO_ENOENT
      return;
    }
    // PPSSPP sceIo.cpp:1076-1077: negative size = illegal addr
    if ((size | 0) < 0) {
      regs.setGpr(2, 0x800200d3); // SCE_KERNEL_ERROR_ILLEGAL_ADDR
      return;
    }

    // PPSSPP sceIo.cpp:1084-1088: npdrm read path
    if (file.npdrm && file.pgdInfo) {
      const bytesToRead = npdrmRead(file, bus, buf, size);
      file.position = file.pgdInfo.fileOffset; // keep position in sync
      kernel.ioOpsCount++;
      log.debug(`sceIoRead(npdrm): fd=${fd} size=${size} → ${bytesToRead} bytes`);
      regs.setGpr(2, bytesToRead);
      return;
    }

    const bytesAvailable = file.data.length - file.position;
    const bytesToRead = Math.min(size, bytesAvailable);
    log.debug(`sceIoRead: fd=${fd} buf=0x${buf.toString(16)} size=${size} pos=${file.position} → ${bytesToRead} bytes`);
    for (let i = 0; i < bytesToRead; i++) {
      bus.writeU8(buf + i, file.data[file.position + i]!);
    }
    file.position += bytesToRead;
    kernel.ioOpsCount++;

    // PPSSPP sceIo.cpp:1053-1058: delay = max(100, size/100) microseconds
    // PPSSPP sceIo.cpp:1155-1156: hleDelayResult → __KernelWaitCurThread(WAITTYPE_HLEDELAY)
    // Only delay for disc files (fd > 2) when inside a thread with CoreTiming available.
    const t = kernel.currentThreadId > 0 ? kernel.threads.get(kernel.currentThreadId) : null;
    if (t && kernel.coreTiming && kernel.wakeThreadEventId >= 0 && fd > 2) {
      const delayUs = Math.max(100, Math.floor(size / 100));
      log.debug(`sceIoRead: delay ${delayUs}µs tid=${kernel.currentThreadId} v0=${bytesToRead}`);
      t.state = ThreadState.WAITING;
      t.waitType = WaitType.DELAY;
      kernel.saveContext(t, regs);
      t.context.gpr[2] = bytesToRead; // return value when woken
      const cycles = kernel.coreTiming.usToCycles(delayUs);
      kernel.coreTiming.scheduleEvent(cycles, kernel.wakeThreadEventId, kernel.currentThreadId);
      if (!kernel.reschedule(regs)) kernel.idleBreak = true;
    } else {
      log.debug(`sceIoRead: instant v0=${bytesToRead}`);
      regs.setGpr(2, bytesToRead);
    }
  });

  // sceIoLseek(fd, offset, whence) → new position (64-bit)
  kernel.register(IO.sceIoLseek, (regs) => {
    const fd       = regs.getGpr(4);
    const offsetLo = regs.getGpr(6);
    const whence   = regs.getGpr(8);
    const file     = openFiles.get(fd);
    if (!file) {
      regs.setGpr(2, 0x80010002);
      regs.setGpr(3, 0xffffffff);
      return;
    }
    // PPSSPP sceIo.cpp:1434-1435: npdrm seek
    if (file.npdrm && file.pgdInfo) {
      const newPos = npdrmLseek(file, offsetLo, whence);
      file.position = file.pgdInfo.fileOffset;
      regs.setGpr(2, newPos);
      regs.setGpr(3, 0);
      return;
    }
    const newPosition = kernel.computeSeekPosition(file.position, file.data.length, offsetLo, whence);
    log.debug(`sceIoLseek: fd=${fd} offset=${offsetLo} whence=${whence} → pos=${newPosition}`);
    file.position = newPosition;
    regs.setGpr(2, newPosition);
    regs.setGpr(3, 0);
  });

  // sceIoLseekAsync(fd, offset, whence) — offset is s64 in r6:r7 (aligned pair), whence in r8
  kernel.register(IO.sceIoLseekAsync, (regs) => {
    const fd       = regs.getGpr(4);
    const offsetLo = regs.getGpr(6);
    const whence   = regs.getGpr(8);
    const file     = openFiles.get(fd);
    if (!file) {
      regs.setGpr(2, 0x80010002);
      return;
    }
    if (file.npdrm && file.pgdInfo) {
      file.asyncResult = npdrmLseek(file, offsetLo, whence);
      file.position = file.pgdInfo.fileOffset;
    } else {
      file.position = kernel.computeSeekPosition(file.position, file.data.length, offsetLo, whence);
      file.asyncResult = file.position;
    }
    file.hasAsyncResult = true;
    regs.setGpr(2, 0);
  });

  // sceIoLseek32(fd, offset, whence)
  kernel.register(IO.sceIoLseek32, (regs) => {
    const fd     = regs.getGpr(4);
    const offset = regs.getGpr(5);
    const whence = regs.getGpr(6);
    const file   = openFiles.get(fd);
    if (!file) {
      regs.setGpr(2, 0x80010002);
      return;
    }
    if (file.npdrm && file.pgdInfo) {
      const newPos = npdrmLseek(file, offset, whence);
      file.position = file.pgdInfo.fileOffset;
      regs.setGpr(2, newPos);
      return;
    }
    file.position = kernel.computeSeekPosition(file.position, file.data.length, offset, whence);
    log.debug(`sceIoLseek32: fd=${fd} offset=${offset} whence=${whence} → pos=${file.position}`);
    regs.setGpr(2, file.position);
  });

  // sceIoGetstat(path, stat) — PPSSPP sceIo.cpp:1853-1878
  kernel.register(IO.sceIoGetstat, (regs, bus) => {
    const path      = kernel.readCString(bus, regs.getGpr(4));
    const statAddr  = regs.getGpr(5);
    const info = kernel.pspFs.getFileInfo(path, kernel.currentThreadId);
    if (!info.exists) {
      const level = path.startsWith("ms0:") ? "debug" : "warn";
      log[level](`sceIoGetstat: not found: ${path}`);
      regs.setGpr(2, 0x80010002); // SCE_ERROR_ERRNO_ENOENT
      return;
    }
    if (statAddr !== 0) {
      writeIoStat(bus, statAddr, info);
    }
    regs.setGpr(2, 0);
  });

  // sceIoDopen(dirname) — PPSSPP sceIo.cpp:1669-1700
  kernel.register(IO.sceIoDopen, (regs, bus) => {
    const path = kernel.readCString(bus, regs.getGpr(4));
    const entries = kernel.pspFs.getDirListing(path, kernel.currentThreadId);
    const info = kernel.pspFs.getFileInfo(path, kernel.currentThreadId);
    if (!info.exists) {
      log.debug(`sceIoDopen: not found: ${path}`);
      regs.setGpr(2, 0x80010002); // SCE_ERROR_ERRNO_ENOENT
      return;
    }
    const fd = nextFd++;
    openDirs.set(fd, { entries, index: 0 });
    log.info(`sceIoDopen: fd=${fd} path=${path} entries=${entries.length}`);
    regs.setGpr(2, fd);
  });

  // sceIoDread(fd, dirEntPtr) — PPSSPP sceIo.cpp:1702-1741
  kernel.register(IO.sceIoDread, (regs, bus) => {
    const fd = regs.getGpr(4);
    const dirEntPtr = regs.getGpr(5);
    const listing = openDirs.get(fd);
    if (!listing) {
      regs.setGpr(2, 0x80010009); // SCE_KERNEL_ERROR_BADF
      return;
    }
    if (listing.index >= listing.entries.length) {
      regs.setGpr(2, 0); // end of listing
      return;
    }
    const entry = listing.entries[listing.index]!;
    // Write SceIoDirEnt: SceIoStat (88 bytes) + d_name[256] + d_private(u32)
    writeIoStat(bus, dirEntPtr, entry);
    // d_name at offset 88, 256 bytes null-terminated
    const nameBytes = new TextEncoder().encode(entry.name);
    for (let i = 0; i < 256; i++) {
      bus.writeU8(dirEntPtr + 88 + i, i < nameBytes.length ? nameBytes[i]! : 0);
    }
    // d_private at offset 344
    bus.writeU32(dirEntPtr + 344, 0);
    listing.index++;
    regs.setGpr(2, 1); // more entries available (or last one)
  });

  // sceIoDclose(fd) — PPSSPP sceIo.cpp:1743-1759
  kernel.register(IO.sceIoDclose, (regs) => {
    const fd = regs.getGpr(4);
    openDirs.delete(fd);
    regs.setGpr(2, 0);
  });

  // sceIoDevctl(name, cmd, arg, argLen, out, outLen)
  // PPSSPP: PARAM(4) = $t0, PARAM(5) = $t1
  kernel.register(IO.sceIoDevctl, (regs, bus) => {
    const cmd    = regs.getGpr(5);
    const outPtr = regs.getGpr(8); // 5th arg = PARAM(4) = $t0

    switch (cmd) {
      case 0x01F20001:
        if (outPtr !== 0) bus.writeU32(outPtr + 4, 0x10);
        regs.setGpr(2, 0);
        break;
      case 0x01F20002:
        if (outPtr !== 0) bus.writeU32(outPtr, 0x10);
        regs.setGpr(2, 0);
        break;
      case 0x01F20003:
        if (outPtr !== 0) bus.writeU32(outPtr, 0x10000);
        regs.setGpr(2, 0);
        break;
      default:
        log.debug(`sceIoDevctl: unhandled cmd=0x${cmd.toString(16)}`);
        regs.setGpr(2, 0);
        break;
    }
  });

  // sceIoAssign(alias, physical, filesystem, mode, argPtr, argSize)
  kernel.register(IO.sceIoAssign, (regs) => {
    log.debug("sceIoAssign (stub)");
    regs.setGpr(2, 0);
  });

  // sceIoOpenAsync(file, flags, mode) → fake fd
  kernel.register(IO.sceIoOpenAsync, (regs) => {
    regs.setGpr(2, kernel.nextBlockId++);
  });

  // Helper: write s64 asyncResult to memory (PPSSPP uses Memory::Write_U64)
  function writeAsyncResult(bus: { writeU32(addr: number, val: number): void }, addr: number, result: number): void {
    // asyncResult is s64, write as two u32 (little-endian)
    bus.writeU32(addr + 0, result & 0xFFFFFFFF);
    bus.writeU32(addr + 4, result < 0 ? 0xFFFFFFFF : 0); // sign-extend
  }

  // sceIoWaitAsync(fd, resultPtr)
  // PPSSPP sceIo.cpp:2297-2331
  kernel.register(IO.sceIoWaitAsync, (regs, bus) => {
    const fd      = regs.getGpr(4);
    const address = regs.getGpr(5);
    const file = openFiles.get(fd);
    if (!file) { regs.setGpr(2, 0x80010009); return; }
    if (file.hasAsyncResult) {
      writeAsyncResult(bus, address, file.asyncResult);
      file.hasAsyncResult = false;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x8002032a);
    }
  });

  // sceIoWaitAsyncCB(fd, resultPtr)
  // PPSSPP sceIo.cpp:2333-2363
  kernel.register(IO.sceIoWaitAsyncCB, (regs, bus) => {
    const fd      = regs.getGpr(4);
    const address = regs.getGpr(5);
    const file = openFiles.get(fd);
    if (!file) { regs.setGpr(2, 0x80010009); return; }
    if (file.hasAsyncResult) {
      writeAsyncResult(bus, address, file.asyncResult);
      file.hasAsyncResult = false;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x8002032a); // SCE_KERNEL_ERROR_NOASYNC
    }
  });

  // sceIoPollAsync(fd, resultPtr)
  // PPSSPP sceIo.cpp:2365-2385
  kernel.register(IO.sceIoPollAsync, (regs, bus) => {
    const fd      = regs.getGpr(4);
    const address = regs.getGpr(5);
    const file = openFiles.get(fd);
    if (!file) { regs.setGpr(2, 0x80010009); return; }
    if (file.hasAsyncResult) {
      writeAsyncResult(bus, address, file.asyncResult);
      file.hasAsyncResult = false;
      regs.setGpr(2, 0);
    } else {
      regs.setGpr(2, 0x8002032a);
    }
  });

  // sceIoGetAsyncStat(fd, poll, resultPtr)
  // PPSSPP sceIo.cpp:2248-2287
  kernel.register(IO.sceIoGetAsyncStat, (regs, bus) => {
    const fd      = regs.getGpr(4);
    const poll    = regs.getGpr(5);
    const address = regs.getGpr(6);
    const file = openFiles.get(fd);
    if (!file) { regs.setGpr(2, 0x80010009); return; }
    if (file.hasAsyncResult) {
      writeAsyncResult(bus, address, file.asyncResult);
      file.hasAsyncResult = false;
      regs.setGpr(2, 0);
    } else {
      // PPSSPP: SCE_KERNEL_ERROR_NOASYNC (no pending or completed result)
      regs.setGpr(2, 0x8002032a);
    }
  });

  // sceIoReadAsync(fd, buf, size) → 0 on success
  // PPSSPP sceIo.cpp:1162-1179: validates fd, checks asyncBusy, starts async I/O.
  // We complete the read immediately (HLE shortcut) and set hasAsyncResult.
  kernel.register(IO.sceIoReadAsync, (regs, bus) => {
    const fd   = regs.getGpr(4);
    const buf  = regs.getGpr(5);
    const size = regs.getGpr(6);
    const file = openFiles.get(fd);
    if (!file) {
      regs.setGpr(2, 0x80010009); // SCE_KERNEL_ERROR_BADF
      return;
    }
    // PPSSPP sceIo.cpp:1166-1168: asyncBusy check
    if (file.hasAsyncResult) {
      regs.setGpr(2, 0x80020329); // SCE_KERNEL_ERROR_ASYNC_BUSY
      return;
    }
    // Perform the read immediately, store result for sceIoPollAsync/WaitAsync
    if ((size | 0) < 0) {
      file.asyncResult = 0x800200d3; // SCE_KERNEL_ERROR_ILLEGAL_ADDR
    } else if (file.npdrm && file.pgdInfo) {
      file.asyncResult = npdrmRead(file, bus, buf, size);
      file.position = file.pgdInfo.fileOffset;
      kernel.ioOpsCount++;
    } else {
      const bytesAvailable = file.data.length - file.position;
      const bytesToRead = Math.min(size, bytesAvailable);
      for (let i = 0; i < bytesToRead; i++) {
        bus.writeU8(buf + i, file.data[file.position + i]!);
      }
      file.position += bytesToRead;
      file.asyncResult = bytesToRead;
      kernel.ioOpsCount++;
    }
    log.debug(`sceIoReadAsync: fd=${fd} size=${size} result=${file.asyncResult}`);
    file.hasAsyncResult = true;
    regs.setGpr(2, 0);
  });

  // sceIoWriteAsync(fd, data, size) → 0 on success
  // PPSSPP sceIo.cpp:1310-1327: validates fd, checks asyncBusy, starts async I/O.
  kernel.register(IO.sceIoWriteAsync, (regs, bus) => {
    const fd   = regs.getGpr(4);
    const data = regs.getGpr(5);
    const size = regs.getGpr(6);
    const file = openFiles.get(fd);
    if (!file) {
      regs.setGpr(2, 0x80010009); // SCE_KERNEL_ERROR_BADF
      return;
    }
    if (file.hasAsyncResult) {
      regs.setGpr(2, 0x80020329); // SCE_KERNEL_ERROR_ASYNC_BUSY
      return;
    }
    // stdout/stderr: print output
    if (isStdoutFd(fd) && size > 0) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = bus.readU8(data + i);
      const text = new TextDecoder().decode(bytes);
      if (kernel.stdoutBuffer !== null) kernel.stdoutBuffer.push(text);
      pspLog.info(`${text.replace(/\n$/, "")}`);
    }
    file.asyncResult = size;
    file.hasAsyncResult = true;
    kernel.ioOpsCount++;
    regs.setGpr(2, 0);
  });

  // sceIoGetDevType(fd) → device type
  // PPSSPP sceIo.cpp:1329-1348: returns PSPDevType::FILE (0x10) for most files
  kernel.register(IO.sceIoGetDevType, (regs) => {
    const fd = regs.getGpr(4);
    // stdin/stdout/stderr = FILE type (PPSSPP sceIo.cpp:1330-1332)
    if (fd <= 2) { regs.setGpr(2, 0x10); return; } // PSPDevType::FILE
    const file = openFiles.get(fd);
    if (!file) { regs.setGpr(2, 0x80010009); return; } // SCE_KERNEL_ERROR_BADF
    // For disc-backed files return BLOCK (0x04), matches PPSSPP ISOFileSystem::DevType
    regs.setGpr(2, 0x04); // PSPDevType::BLOCK
  });

  // sceIoChangeAsyncPriority(fd, priority) — we don't have real async threads
  kernel.register(IO.sceIoChangeAsyncPriority, (regs) => {
    regs.setGpr(2, 0);
  });

  // sceIoChdir(dirname) — PPSSPP sceIo.cpp:2132-2134
  kernel.register(IO.sceIoChdir, (regs, bus) => {
    const path = kernel.readCString(bus, regs.getGpr(4));
    log.debug(`sceIoChdir: ${path}`);
    regs.setGpr(2, kernel.pspFs.chDir(path, kernel.currentThreadId));
  });

  // ── Stubs: IO ──────────────────────────────────────────────────────────
  kernel.stub(IO.IoFileMgrForKernel_76DA16E3);
  kernel.stub(IO.__IoAsyncFinish);
  kernel.stub(IO.fdprintf);
  kernel.stub(IO.printf);
  kernel.stub(IO.puts);
  kernel.stub(IO.sceIoAddDrv, 1);
  kernel.stub(IO.sceIoCancel);
  kernel.stub(IO.sceIoChangeThreadCwd);
  kernel.stub(IO.sceIoChstat);
  kernel.stub(IO.sceIoCloseAll);
  kernel.stub(IO.sceIoCloseAsync);
  kernel.stub(IO.sceIoDelDrv);
  kernel.stub(IO.sceIoGetFdList);
  kernel.stub(IO.sceIoGetIobUserLevel);
  kernel.stub(IO.sceIoGetThreadCwd);
  // sceIoIoctl(fd, cmd, indata, inlen, outdata, outlen)
  // PPSSPP sceIo.cpp:2560-2740 — UMD-specific ioctl commands
  kernel.register(IO.sceIoIoctl, (regs, bus) => {
    const fd         = regs.getGpr(4);
    const cmd        = regs.getGpr(5);
    const indataPtr  = regs.getGpr(6);
    const inlen      = regs.getGpr(7);
    // PPSSPP reads all syscall args from sequential registers: PARAM(n) = r[A0+n]
    const outdataPtr = regs.getGpr(8); // PARAM(4) = $t0
    const outlen     = regs.getGpr(9); // PARAM(5) = $t1
    const file = openFiles.get(fd);
    if (!file) { regs.setGpr(2, 0x80010009); return; } // SCE_KERNEL_ERROR_BADF

    switch (cmd) {
      // Get UMD sector size → always 2048
      case 0x01020003: {
        if (outdataPtr !== 0 && outlen >= 4) bus.writeU32(outdataPtr, 2048);
        else { regs.setGpr(2, 0x80010016); return; }
        break;
      }
      // Get UMD file offset (current seek position)
      case 0x01020004: {
        if (outdataPtr !== 0 && outlen >= 4) bus.writeU32(outdataPtr, file.position);
        else { regs.setGpr(2, 0x80010016); return; }
        break;
      }
      // Seek within UMD file (16-byte struct: offset(u64), unk(u32), whence(u32))
      case 0x01010005: {
        if (indataPtr !== 0 && inlen >= 4) {
          const offset = bus.readU32(indataPtr); // low 32 bits
          const whence = inlen >= 16 ? bus.readU32(indataPtr + 12) : 0;
          file.position = kernel.computeSeekPosition(file.position, file.data.length, offset, whence);
        } else { regs.setGpr(2, 0x80010016); return; }
        break;
      }
      // Get UMD file start sector (LBA)
      case 0x01020006: {
        if (outdataPtr !== 0 && outlen >= 4) bus.writeU32(outdataPtr, 0); // fake LBA=0
        else { regs.setGpr(2, 0x80010016); return; }
        break;
      }
      // Get UMD file size in bytes (u64)
      case 0x01020007: {
        if (outdataPtr !== 0 && outlen >= 8) {
          bus.writeU32(outdataPtr, file.data.length & 0xFFFFFFFF);
          bus.writeU32(outdataPtr + 4, 0);
        } else { regs.setGpr(2, 0x80010016); return; }
        break;
      }
      // Read from UMD file (indata = u32 size, outdata = buffer)
      case 0x01030008: {
        if (indataPtr !== 0 && inlen >= 4) {
          const size = bus.readU32(indataPtr);
          if (outdataPtr !== 0 && size <= outlen) {
            const avail = file.data.length - file.position;
            const toRead = Math.min(size, avail);
            for (let i = 0; i < toRead; i++) {
              bus.writeU8(outdataPtr + i, file.data[file.position + i]!);
            }
            file.position += toRead;
            kernel.ioOpsCount++;
            regs.setGpr(2, toRead); return;
          }
        }
        regs.setGpr(2, 0x80010016); return;
      }
      // Get current sector seek position
      case 0x01d20001: {
        if (outdataPtr !== 0 && outlen >= 4) bus.writeU32(outdataPtr, file.position);
        else { regs.setGpr(2, 0x80010016); return; }
        break;
      }
      // Get file sector count
      case 0x01d20002: {
        if (outdataPtr !== 0 && outlen >= 4) {
          bus.writeU32(outdataPtr, Math.ceil(file.data.length / 2048));
        } else { regs.setGpr(2, 0x80010016); return; }
        break;
      }
      // NpDrm key setup (PGD open) — PPSSPP sceIo.cpp:2587-2624
      // Reads PGD header at pgd_offset and calls pgd_open() with KIRK crypto.
      case 0x04100001: {
        const off = file.pgdOffset;
        const pgdMagic = [0x00, 0x50, 0x47, 0x44]; // "\0PGD"

        // Read 0x90-byte PGD header from file at pgd_offset
        // PPSSPP: pspFileSystem.SeekFile(f->handle, f->pgd_offset, FILEMOVE_BEGIN);
        //         pspFileSystem.ReadFile(f->handle, pgd_header, 0x90);
        const pgdHeader = new Uint8Array(0x90);
        if (file.data.length >= off + 0x90) {
          pgdHeader.set(file.data.subarray(off, off + 0x90));
        }

        // PPSSPP: f->pgdInfo = pgd_open(kirk, pgd_header, 2, key_ptr);
        const pgdInfo = pgdOpen(kirk, pgdHeader, 0, 2, licenseeKeyForPgd);
        if (!pgdInfo) {
          // pgd_open failed
          file.npdrm = false;
          file.pgdOffset = 0;
          file.pgdInfo = null;
          // Check if file has PGD magic — if yes, it's encrypted but key mismatch
          if (pgdHeader[0] === pgdMagic[0] && pgdHeader[1] === pgdMagic[1] &&
              pgdHeader[2] === pgdMagic[2] && pgdHeader[3] === pgdMagic[3]) {
            log.error(`sceIoIoctl: PGD key mismatch fd=${fd} path=${file.path}`);
            regs.setGpr(2, 0x80510204); // SCE_ERROR_PGD_INVALID_HEADER
            return;
          }
          // No PGD magic — not encrypted (PPSSPP sceIo.cpp:2614-2616)
          log.debug(`sceIoIoctl: 0x04100001 no PGD magic fd=${fd}, not encrypted`);
          file.position = 0;
        } else {
          // PGD open succeeded — PPSSPP sceIo.cpp:2620-2622
          file.npdrm = true;
          pgdInfo.dataOffset += file.pgdOffset;
          file.pgdInfo = pgdInfo;
          log.info(`sceIoIoctl: PGD decryption active fd=${fd} path=${file.path} dataSize=${pgdInfo.dataSize} dataOff=${pgdInfo.dataOffset} blockSize=${pgdInfo.blockSize}`);
        }
        break;
      }
      // NpDrm set PGD offset — PPSSPP sceIo.cpp:2628-2629: f->pgd_offset = indataPtr
      case 0x04100002:
        file.pgdOffset = indataPtr;
        break;
      // NpDrm get data size — PPSSPP sceIo.cpp:2633-2637
      case 0x04100010: {
        if (file.pgdInfo) {
          regs.setGpr(2, file.pgdInfo.dataSize);
        } else {
          regs.setGpr(2, file.data.length);
        }
        return;
      }
      default:
        log.warn(`sceIoIoctl: unhandled cmd=0x${cmd.toString(16)} fd=${fd} in=${indataPtr.toString(16)} inlen=${inlen} out=${outdataPtr.toString(16)} outlen=${outlen}`);
        break;
    }
    regs.setGpr(2, 0);
  });
  kernel.stub(IO.sceIoIoctlAsync);
  kernel.stub(IO.sceIoLseek32Async);
  // sceIoMkdir(dirname, mode) — PPSSPP sceIo.cpp
  kernel.register(IO.sceIoMkdir, (regs, bus) => {
    const path = kernel.readCString(bus, regs.getGpr(4));
    log.debug(`sceIoMkdir: ${path}`);
    regs.setGpr(2, kernel.pspFs.mkDir(path, kernel.currentThreadId));
  });
  kernel.stub(IO.sceIoRemove);
  kernel.stub(IO.sceIoRename);
  kernel.stub(IO.sceIoReopen, 1);
  kernel.stub(IO.sceIoRmdir);
  kernel.stub(IO.sceIoSetAsyncCallback);
  kernel.stub(IO.sceIoSync);
  kernel.stub(IO.sceIoUnassign);
  kernel.stub(IO.sceKernelRegisterStderrPipe, 1);
  kernel.stub(IO.sceKernelRegisterStdoutPipe, 1);
  kernel.stub(IO.sceKernelStderrReopen, 1);
  kernel.stub(IO.sceKernelStdioClose);
  kernel.stub(IO.sceKernelStdioLseek);
  kernel.stub(IO.sceKernelStdioOpen, 1);
  kernel.stub(IO.sceKernelStdioRead);
  kernel.stub(IO.sceKernelStdioSendChar);
  kernel.stub(IO.sceKernelStdioWrite);
  kernel.stub(IO.sceKernelStdoutReopen, 1);

  // ── USB ──────────────────────────────────────────────────────────
  kernel.stub(USB.sceUsbActivate);
  kernel.stub(USB.sceUsbDeactivate);
  kernel.stub(USB.sceUsbGetDrvList);
  kernel.stub(USB.sceUsbGetDrvState);
  kernel.stub(USB.sceUsbGetState);
  kernel.stub(USB.sceUsbStart, 1);
  kernel.stub(USB.sceUsbStop);
  kernel.stub(USB.sceUsbWaitCancel);
  kernel.stub(USB.sceUsbWaitState);
  kernel.stub(USB.sceUsbWaitStateCB);
  kernel.stub(USB.sceUsbstorBootGetDataSize);
  kernel.stub(USB.sceUsbstorBootRegisterNotify, 1);
  kernel.stub(USB.sceUsbstorBootSetCapacity);
  kernel.stub(USB.sceUsbstorBootSetLoadAddr, 1);
  kernel.stub(USB.sceUsbstorBootSetStatus);
  kernel.stub(USB.sceUsbstorBootUnregisterNotify, 1);
  kernel.stub(USB.sceUsbstorGetStatus);
  // ── USB_ACC ──────────────────────────────────────────────────────────
  kernel.stub(USB_ACC.sceUsbAccGetAuthStat);
  kernel.stub(USB_ACC.sceUsbAccGetInfo);
  // ── USB_GPS ──────────────────────────────────────────────────────────
  kernel.stub(USB_GPS.sceUsbGpsClose);
  kernel.stub(USB_GPS.sceUsbGpsGetData);
  kernel.stub(USB_GPS.sceUsbGpsGetInitDataLocation, 1);
  kernel.stub(USB_GPS.sceUsbGpsGetPowerSaveMode);
  kernel.stub(USB_GPS.sceUsbGpsGetState);
  kernel.stub(USB_GPS.sceUsbGpsGetStaticNavMode);
  kernel.stub(USB_GPS.sceUsbGpsOpen, 1);
  kernel.stub(USB_GPS.sceUsbGpsReset);
  kernel.stub(USB_GPS.sceUsbGpsResetInitialPosition, 1);
  kernel.stub(USB_GPS.sceUsbGpsSaveInitData, 1);
  kernel.stub(USB_GPS.sceUsbGpsSetInitDataLocation, 1);
  kernel.stub(USB_GPS.sceUsbGpsSetPowerSaveMode);
  kernel.stub(USB_GPS.sceUsbGpsSetStaticNavMode);
  // ── USB_MIC ──────────────────────────────────────────────────────────
  kernel.stub(USB_MIC.sceUsbMicGetInputLength);
  kernel.stub(USB_MIC.sceUsbMicInput);
  kernel.stub(USB_MIC.sceUsbMicInputBlocking);
  kernel.stub(USB_MIC.sceUsbMicInputInit, 1);
  kernel.stub(USB_MIC.sceUsbMicInputInitEx, 1);
  kernel.stub(USB_MIC.sceUsbMicPollInputEnd);
  kernel.stub(USB_MIC.sceUsbMicWaitInputEnd);

  // ── NP_DRM — PPSSPP scePspNpDrm_user.cpp ───────────────────────────

  // Module-level state for DRM licensee key (PPSSPP scePspNpDrm_user.cpp:11-13)
  let licenseeKey = new Uint8Array(16);
  let isLicenseeKeySet = false;
  // Computed: return licensee key for pgd_open, or null if not set
  // Used by IoCtl 0x04100001 handler
  let licenseeKeyForPgd: Uint8Array | null = null;

  // sceNpDrmSetLicenseeKey(keyAddr) — PPSSPP scePspNpDrm_user.cpp:57-66
  kernel.register(NP_DRM.sceNpDrmSetLicenseeKey, (regs, bus) => {
    const keyAddr = regs.getGpr(4);
    if (keyAddr === 0) {
      regs.setGpr(2, 0x80550902); // SCE_NPDRM_ERROR_INVALID_FILE
      return;
    }
    for (let i = 0; i < 16; i++) {
      licenseeKey[i] = bus.readU8(keyAddr + i);
    }
    isLicenseeKeySet = true;
    licenseeKeyForPgd = new Uint8Array(licenseeKey);
    log.info("sceNpDrmSetLicenseeKey: key set");
    regs.setGpr(2, 0);
  });

  // sceNpDrmClearLicenseeKey() — PPSSPP scePspNpDrm_user.cpp:68-73
  kernel.register(NP_DRM.sceNpDrmClearLicenseeKey, (regs) => {
    licenseeKey.fill(0);
    isLicenseeKeySet = false;
    licenseeKeyForPgd = null;
    log.info("sceNpDrmClearLicenseeKey");
    regs.setGpr(2, 0);
  });

  // sceNpDrmRenameCheck(filename) — PPSSPP scePspNpDrm_user.cpp:75-77
  kernel.register(NP_DRM.sceNpDrmRenameCheck, (regs) => {
    log.debug("sceNpDrmRenameCheck (stub ok)");
    regs.setGpr(2, 0);
  });

  // sceNpDrmEdataSetupKey(fd) — PPSSPP scePspNpDrm_user.cpp:79-124
  // Checks EDAT magic, sets pgd_offset=0x90, calls IoCtl 0x04100001 (PGD open).
  kernel.register(NP_DRM.sceNpDrmEdataSetupKey, (regs) => {
    const fd = regs.getGpr(4);
    const file = openFiles.get(fd);
    if (!file) {
      log.warn(`sceNpDrmEdataSetupKey: invalid fd=${fd}`);
      regs.setGpr(2, -1);
      return;
    }

    // Check for EDAT magic at file start: \0PSPEDAT (8 bytes)
    // PPSSPP scePspNpDrm_user.cpp:16-54 — isEncrypted()
    const isEdat = file.data.length >= 8 &&
      file.data[0] === 0x00 && file.data[1] === 0x50 &&
      file.data[2] === 0x53 && file.data[3] === 0x50 &&
      file.data[4] === 0x45 && file.data[5] === 0x44 &&
      file.data[6] === 0x41 && file.data[7] === 0x54;

    if (isEdat) {
      // PPSSPP scePspNpDrm_user.cpp:98-99: check licensee key
      if (!isLicenseeKeySet) {
        log.warn(`sceNpDrmEdataSetupKey: EDAT file but no licensee key set fd=${fd}`);
        regs.setGpr(2, 0x80550901); // SCE_NPDRM_ERROR_NO_K_LICENSEE_SET
        return;
      }

      // PPSSPP scePspNpDrm_user.cpp:108: __IoIoctl(fd, 0x04100002, 0x90, ...)
      file.pgdOffset = 0x90;

      // PPSSPP scePspNpDrm_user.cpp:115: __IoIoctl(fd, 0x04100001, ...)
      // Read PGD header and call pgd_open with KIRK crypto
      const off = file.pgdOffset;
      const pgdHeader = new Uint8Array(0x90);
      if (file.data.length >= off + 0x90) {
        pgdHeader.set(file.data.subarray(off, off + 0x90));
      }
      const pgdInfo = pgdOpen(kirk, pgdHeader, 0, 2, licenseeKeyForPgd);
      if (pgdInfo) {
        file.npdrm = true;
        pgdInfo.dataOffset += file.pgdOffset;
        file.pgdInfo = pgdInfo;
        log.info(`sceNpDrmEdataSetupKey: PGD active fd=${fd} path=${file.path} dataSize=${pgdInfo.dataSize}`);
      } else {
        file.npdrm = false;
        file.pgdOffset = 0;
        file.pgdInfo = null;
        // Check for PGD magic at pgd_offset
        if (pgdHeader[0] === 0x00 && pgdHeader[1] === 0x50 &&
            pgdHeader[2] === 0x47 && pgdHeader[3] === 0x44) {
          log.error(`sceNpDrmEdataSetupKey: PGD key mismatch fd=${fd} path=${file.path}`);
          regs.setGpr(2, 0x80510204); // SCE_ERROR_PGD_INVALID_HEADER
          return;
        }
        log.debug(`sceNpDrmEdataSetupKey: no PGD at offset 0x${off.toString(16)} fd=${fd}`);
        file.position = 0;
      }
    }
    log.info(`sceNpDrmEdataSetupKey: fd=${fd} isEdat=${isEdat} npdrm=${file.npdrm}`);
    regs.setGpr(2, 0);
  });

  // sceNpDrmEdataGetDataSize(fd) — PPSSPP scePspNpDrm_user.cpp:126-129
  // Returns pgdInfo->data_size if available, else file size.
  kernel.register(NP_DRM.sceNpDrmEdataGetDataSize, (regs) => {
    const fd = regs.getGpr(4);
    const file = openFiles.get(fd);
    if (!file) {
      regs.setGpr(2, -1);
      return;
    }
    const size = file.pgdInfo ? file.pgdInfo.dataSize : file.data.length;
    log.info(`sceNpDrmEdataGetDataSize: fd=${fd} size=${size}`);
    regs.setGpr(2, size);
  });

  // sceNpDrmOpen() — PPSSPP scePspNpDrm_user.cpp:131-133: unimplemented stub
  kernel.register(NP_DRM.sceNpDrmOpen, (regs) => {
    log.warn("sceNpDrmOpen: unimplemented");
    regs.setGpr(2, 0);
  });

  log.info("IO HLE handlers registered");
}
