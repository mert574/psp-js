import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBus } from "../memory/memory-bus.js";
import { AllegrexRegisters } from "../cpu/registers.js";
import { HLEKernel } from "./hle-kernel.js";
import { MemoryFileStore } from "../storage/file-store.js";
import { IO } from "./nids.js";

// Direct file IO write path: create a save file, write bytes, close, then
// reopen and read them back. Also checks persistence to the FileStore.
describe("HLE-IO — direct file write", () => {
  let bus: MemoryBus;
  let hle: HLEKernel;
  let regs: AllegrexRegisters;
  let store: MemoryFileStore;

  // Scratch addresses well past any program area
  const PATH_ADDR = 0x08901000;
  const DATA_ADDR = 0x08902000;
  const READ_ADDR = 0x08903000;

  const PSP_O_RDONLY = 0x0001;
  const PSP_O_WRONLY = 0x0002;
  const PSP_O_CREAT  = 0x0200;
  const PSP_O_TRUNC  = 0x0400;

  beforeEach(() => {
    bus = MemoryBus.create();
    hle = new HLEKernel(bus);
    regs = new AllegrexRegisters();
    store = new MemoryFileStore();
    hle.fileStore = store;
    hle.pspFs.setStartingDirectory("ms0:/");
  });

  function call(nid: number): void {
    const handler = (hle as unknown as { handlers: Map<number, (r: AllegrexRegisters, b: MemoryBus) => void> }).handlers.get(nid);
    if (!handler) throw new Error(`no handler for nid 0x${nid.toString(16)}`);
    handler(regs, bus);
  }

  function writeCString(addr: number, str: string): void {
    for (let i = 0; i < str.length; i++) bus.writeU8(addr + i, str.charCodeAt(i));
    bus.writeU8(addr + str.length, 0);
  }

  it("creates, writes, closes, then reads back the same bytes", () => {
    const path = "ms0:/PSP/SAVEDATA/TEST00001/DATA.BIN";
    const payload = [0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04];
    writeCString(PATH_ADDR, path);
    for (let i = 0; i < payload.length; i++) bus.writeU8(DATA_ADDR + i, payload[i]!);

    // open(path, O_WRONLY|O_CREAT|O_TRUNC, 0777)
    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_WRONLY | PSP_O_CREAT | PSP_O_TRUNC);
    regs.setGpr(6, 0o777);
    call(IO.sceIoOpen);
    const wfd = regs.getGpr(2);
    expect(wfd).toBeGreaterThan(2);

    // write(wfd, DATA_ADDR, len)
    regs.setGpr(4, wfd);
    regs.setGpr(5, DATA_ADDR);
    regs.setGpr(6, payload.length);
    call(IO.sceIoWrite);
    expect(regs.getGpr(2)).toBe(payload.length);

    // close(wfd) — triggers persistence
    regs.setGpr(4, wfd);
    call(IO.sceIoClose);

    // reopen for reading
    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_RDONLY);
    regs.setGpr(6, 0);
    call(IO.sceIoOpen);
    const rfd = regs.getGpr(2);
    expect(rfd).toBeGreaterThan(2);

    // read(rfd, READ_ADDR, len)
    regs.setGpr(4, rfd);
    regs.setGpr(5, READ_ADDR);
    regs.setGpr(6, payload.length);
    call(IO.sceIoRead);
    expect(regs.getGpr(2)).toBe(payload.length);

    for (let i = 0; i < payload.length; i++) {
      expect(bus.readU8(READ_ADDR + i)).toBe(payload[i]);
    }
  });

  it("persists the written file to the FileStore", async () => {
    const path = "ms0:/PSP/SAVEDATA/TEST00001/SAVE.DAT";
    writeCString(PATH_ADDR, path);
    bus.writeU8(DATA_ADDR, 0x42);

    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_WRONLY | PSP_O_CREAT);
    regs.setGpr(6, 0o777);
    call(IO.sceIoOpen);
    const fd = regs.getGpr(2);

    regs.setGpr(4, fd);
    regs.setGpr(5, DATA_ADDR);
    regs.setGpr(6, 1);
    call(IO.sceIoWrite);

    regs.setGpr(4, fd);
    call(IO.sceIoClose);

    // Let the fire-and-forget persist promise settle
    await Promise.resolve();
    const persisted = await store.loadAll();
    expect(persisted.has(path)).toBe(true);
    expect(persisted.get(path)![0]).toBe(0x42);
  });

  it("reads a file through the fatms0: alias", async () => {
    // Write via ms0:
    writeCString(PATH_ADDR, "ms0:/PSP/SAVEDATA/TEST00001/ALIAS.BIN");
    bus.writeU8(DATA_ADDR, 0xAB);
    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_WRONLY | PSP_O_CREAT);
    regs.setGpr(6, 0o777);
    call(IO.sceIoOpen);
    const wfd = regs.getGpr(2);
    regs.setGpr(4, wfd); regs.setGpr(5, DATA_ADDR); regs.setGpr(6, 1);
    call(IO.sceIoWrite);
    regs.setGpr(4, wfd);
    call(IO.sceIoClose);

    // Read back via fatms0:
    const ALIAS_PATH = 0x08906000;
    writeCString(ALIAS_PATH, "fatms0:/PSP/SAVEDATA/TEST00001/ALIAS.BIN");
    regs.setGpr(4, ALIAS_PATH);
    regs.setGpr(5, PSP_O_RDONLY);
    regs.setGpr(6, 0);
    call(IO.sceIoOpen);
    const rfd = regs.getGpr(2);
    expect(rfd).toBeGreaterThan(2);
    regs.setGpr(4, rfd); regs.setGpr(5, READ_ADDR); regs.setGpr(6, 1);
    call(IO.sceIoRead);
    expect(regs.getGpr(2)).toBe(1);
    expect(bus.readU8(READ_ADDR)).toBe(0xAB);
  });

  it("fires the async IO callback on completion", () => {
    // Register a callback the kernel can notify
    const CB_ID = 0x4001;
    hle.pspCallbacks.set(CB_ID, {
      id: CB_ID, name: "io_cb", threadId: 0, entrypoint: 0x08800000,
      commonArg: 0, notifyCount: 0, notifyArg: 0,
    });

    writeCString(PATH_ADDR, "ms0:/PSP/SAVEDATA/TEST00001/A.BIN");
    bus.writeU8(DATA_ADDR, 1);
    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_WRONLY | PSP_O_CREAT);
    regs.setGpr(6, 0o777);
    call(IO.sceIoOpen);
    const fd = regs.getGpr(2);

    // setAsyncCallback(fd, cbId, arg=0x1234)
    regs.setGpr(4, fd); regs.setGpr(5, CB_ID); regs.setGpr(6, 0x1234);
    call(IO.sceIoSetAsyncCallback);

    // writeAsync triggers completion → callback notified with arg
    regs.setGpr(4, fd); regs.setGpr(5, DATA_ADDR); regs.setGpr(6, 1);
    call(IO.sceIoWriteAsync);

    const cb = hle.pspCallbacks.get(CB_ID)!;
    expect(cb.notifyCount).toBe(1);
    expect(cb.notifyArg).toBe(0x1234);
  });

  it("changes and reads a thread's working directory", () => {
    const tid = 7;
    writeCString(PATH_ADDR, "ms0:/PSP/GAME/FOO");
    regs.setGpr(4, tid);
    regs.setGpr(5, PATH_ADDR);
    call(IO.sceIoChangeThreadCwd);
    expect(regs.getGpr(2)).toBe(0);

    regs.setGpr(4, tid);
    regs.setGpr(5, READ_ADDR);
    regs.setGpr(6, 64);
    call(IO.sceIoGetThreadCwd);
    expect(regs.getGpr(2)).toBe(0);
    // Read back the null-terminated string
    let s = "";
    for (let i = 0; i < 64; i++) {
      const c = bus.readU8(READ_ADDR + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    expect(s).toBe("ms0:/PSP/GAME/FOO");
  });

  it("accepts sceIoChstat on an existing file, ENOENT otherwise", () => {
    // Create a file first
    writeCString(PATH_ADDR, "ms0:/PSP/SAVEDATA/TEST00001/STAT.BIN");
    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_WRONLY | PSP_O_CREAT);
    regs.setGpr(6, 0o777);
    call(IO.sceIoOpen);
    const fd = regs.getGpr(2);
    regs.setGpr(4, fd);
    call(IO.sceIoClose);

    regs.setGpr(4, PATH_ADDR); regs.setGpr(5, 0); regs.setGpr(6, 0);
    call(IO.sceIoChstat);
    expect(regs.getGpr(2)).toBe(0);

    const MISS = 0x08907000;
    writeCString(MISS, "ms0:/PSP/SAVEDATA/TEST00001/MISSING.BIN");
    regs.setGpr(4, MISS); regs.setGpr(5, 0); regs.setGpr(6, 0);
    call(IO.sceIoChstat);
    expect(regs.getGpr(2) >>> 0).toBe(0x80010002);
  });

  it("returns ENOENT when opening a missing file without O_CREAT", () => {
    writeCString(PATH_ADDR, "ms0:/PSP/SAVEDATA/NOPE/X.BIN");
    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_RDONLY);
    regs.setGpr(6, 0);
    call(IO.sceIoOpen);
    expect(regs.getGpr(2) >>> 0).toBe(0x80010002);
  });

  // Atomic save idiom: write TEMP, then rename over the real file.
  it("renames a file, moving data and persistence", async () => {
    const tmp = "ms0:/PSP/SAVEDATA/TEST00001/DATA.BIN.TMP";
    const dst = "ms0:/PSP/SAVEDATA/TEST00001/DATA.BIN";
    const DST_ADDR = 0x08904000;
    writeCString(PATH_ADDR, tmp);
    writeCString(DST_ADDR, dst);
    bus.writeU8(DATA_ADDR, 0x77);

    // write temp file
    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_WRONLY | PSP_O_CREAT);
    regs.setGpr(6, 0o777);
    call(IO.sceIoOpen);
    const fd = regs.getGpr(2);
    regs.setGpr(4, fd); regs.setGpr(5, DATA_ADDR); regs.setGpr(6, 1);
    call(IO.sceIoWrite);
    regs.setGpr(4, fd);
    call(IO.sceIoClose);
    await Promise.resolve();

    // rename(temp, dst)
    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, DST_ADDR);
    call(IO.sceIoRename);
    expect(regs.getGpr(2)).toBe(0);
    await Promise.resolve();

    // dst now readable, temp gone
    expect(hle.pspFs.getFileData(dst, 0)?.[0]).toBe(0x77);
    expect(hle.pspFs.getFileData(tmp, 0)).toBeUndefined();
    const persisted = await store.loadAll();
    expect(persisted.has(dst)).toBe(true);
    expect(persisted.has(tmp)).toBe(false);
  });

  it("closes a file asynchronously and frees the fd after WaitAsync", async () => {
    const RES_ADDR = 0x08905000;
    writeCString(PATH_ADDR, "ms0:/PSP/SAVEDATA/TEST00001/ASYNC.BIN");
    bus.writeU8(DATA_ADDR, 0x55);
    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_WRONLY | PSP_O_CREAT);
    regs.setGpr(6, 0o777);
    call(IO.sceIoOpen);
    const fd = regs.getGpr(2);
    regs.setGpr(4, fd); regs.setGpr(5, DATA_ADDR); regs.setGpr(6, 1);
    call(IO.sceIoWrite);

    // closeAsync then waitAsync
    regs.setGpr(4, fd);
    call(IO.sceIoCloseAsync);
    expect(regs.getGpr(2)).toBe(0);
    regs.setGpr(4, fd);
    regs.setGpr(5, RES_ADDR);
    call(IO.sceIoWaitAsync);
    expect(regs.getGpr(2)).toBe(0);

    // fd is now freed: a second WaitAsync reports a bad fd
    regs.setGpr(4, fd);
    regs.setGpr(5, RES_ADDR);
    call(IO.sceIoWaitAsync);
    expect(regs.getGpr(2) >>> 0).toBe(0x80010009);

    await Promise.resolve();
    expect((await store.loadAll()).has("ms0:/PSP/SAVEDATA/TEST00001/ASYNC.BIN")).toBe(true);
  });

  it("removes a file and un-persists it", async () => {
    const path = "ms0:/PSP/SAVEDATA/TEST00001/DEL.BIN";
    writeCString(PATH_ADDR, path);
    bus.writeU8(DATA_ADDR, 0x99);

    regs.setGpr(4, PATH_ADDR);
    regs.setGpr(5, PSP_O_WRONLY | PSP_O_CREAT);
    regs.setGpr(6, 0o777);
    call(IO.sceIoOpen);
    const fd = regs.getGpr(2);
    regs.setGpr(4, fd); regs.setGpr(5, DATA_ADDR); regs.setGpr(6, 1);
    call(IO.sceIoWrite);
    regs.setGpr(4, fd);
    call(IO.sceIoClose);
    await Promise.resolve();

    // remove(path)
    regs.setGpr(4, PATH_ADDR);
    call(IO.sceIoRemove);
    expect(regs.getGpr(2)).toBe(0);
    await Promise.resolve();

    const persisted = await store.loadAll();
    expect(persisted.has(path)).toBe(false);
  });
});
