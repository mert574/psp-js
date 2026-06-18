# File I/O (`hle-io.ts`)

Implements `sceIo*` file and directory access, asynchronous I/O, kernel stdio, and NPDRM (PGD) decryption for encrypted savedata.

Reads come from the mounted ISO files; writes go to the persistent `FileStore` and are flushed on close. Async ops do not finish at call time: they complete on a delayed `CoreTiming` event (matching PPSSPP `__IoSchedAsync`), so a game can set up its completion handler between issuing the call and the result arriving.

## Files and directories

| Signature | What it does |
| --- | --- |
| `sceIoOpen(filename: const char*, flags: int, mode: int): u32` | Resolves the path against the mounted filesystem (or a raw `sce_lbn` sector path), allocates an fd, and stores an open handle. `PSP_O_CREAT` makes a missing file, `PSP_O_TRUNC` empties it on a writable open, `PSP_O_APPEND` starts at the end. Returns the fd, or `ENOENT` when the file is missing and not being created. |
| `sceIoClose(fd: int): u32` | Persists the file if it was written to, then drops the fd. Returns 0. |
| `sceIoRead(fd: int, buf: u32, size: int): u32` | Copies up to `size` bytes from the file into guest memory, advancing the position, and returns the bytes read. For a disc-backed fd it delays the thread by `max(100, size/100)` microseconds (PPSSPP `hleDelayResult`). NPDRM files read through block-by-block PGD decryption. |
| `sceIoWrite(fd: int, data: u32, size: int): u32` | Writes `size` bytes from guest memory into the file buffer (grown as needed) and into the in-memory filesystem, and returns the bytes written. Writes to stdout/stderr fds are captured into the kernel's stdout buffer instead. |
| `sceIoLseek(fd: int, offset: s64, whence: int): s64` | Moves the file position and returns the new position (s64 in `v0:v1`). NPDRM files seek within the decrypted data size. |
| `sceIoLseek32(fd: int, offset: int, whence: int): u32` | 32-bit variant of `sceIoLseek`, returning the position in `v0` only. |
| `sceIoRemove(filename: const char*): u32` | Deletes the file from the filesystem and removes its persisted copy on the memory stick. Returns 0, or `ENOENT`. |
| `sceIoRename(from: const char*, to: const char*): u32` | Renames a file (the atomic save idiom of writing a temp then renaming over the real file), updating the persisted store for any moved memory-stick paths. Returns 0, or `ENOENT`. |
| `sceIoMkdir(dirname: const char*, mode: int): u32` | Creates a directory in the filesystem. |
| `sceIoRmdir(dirname: const char*): u32` | Removes an empty directory. Returns 0, or `ENOENT`. |
| `sceIoChdir(dirname: const char*): u32` | Sets the current thread's working directory. |
| `sceIoGetstat(filename: const char*, addr: u32): u32` | Writes the 88-byte `SceIoStat` (mode, attr, size, fixed timestamps, and `st_private[0]` = start sector) for the path. Returns 0, or `ENOENT`. |
| `sceIoChstat(filename: const char*, iostatptr: u32, changebits: u32): u32` | We do not model real stat, so this accepts the call if the file exists and is otherwise a no-op (PPSSPP logs and returns 0 too). Returns 0, or `ENOENT`. |
| `sceIoGetDevType(fd: int): u32` | Returns `FILE` (0x10) for stdin/stdout/stderr and `BLOCK` (0x04) for disc-backed files. |
| `sceIoDopen(path: const char*): u32` | Opens a directory listing handle with a cursor at the first entry. Returns the dir fd, or `ENOENT`. |
| `sceIoDread(fd: int, dirent_addr: u32): u32` | Writes the next `SceIoDirEnt` (an `SceIoStat` plus a 256-byte name) and advances the cursor. Returns 1 when an entry was written, 0 at end. |
| `sceIoDclose(fd: int): u32` | Closes a directory listing handle. Returns 0. |

## Asynchronous I/O

| Signature | What it does |
| --- | --- |
| `sceIoOpenAsync(filename: const char*, flags: int, mode: int): u32` | Opens the file right away, returns the fd, and delivers the open result (the fd, or `ENOENT`) as the async result. Even a failed open allocates an fd so the game can read the error back through `sceIoWaitAsync`. |
| `sceIoReadAsync(fd: int, buf: u32, size: int): u32` | Schedules a read whose body runs at completion time (PPSSPP runs it on the async thread, so guest memory is written then, not at issue). Returns 0, or `ASYNC_BUSY` if an op is already in flight. |
| `sceIoWriteAsync(fd: int, data: u32, size: int): u32` | Writes immediately into the file buffer (or stdout), stores the byte count as the async result, and schedules completion. Returns 0, or `ASYNC_BUSY`. |
| `sceIoLseekAsync(fd: int, offset: s64, whence: int): u32` | Seeks immediately, stores the new position as the async result, and schedules completion (100 microsecond latency). Returns 0. |
| `sceIoCloseAsync(fd: int): int` | Persists and flags the fd for close; the handle stays alive until `sceIoWaitAsync`/`sceIoPollAsync` reads the result, then it is freed. Returns 0, or `BADF`. |
| `sceIoWaitAsync(fd: int, address: u32): int` | Blocks the thread until the op completes, then writes the s64 result to `address`. Returns 0, or `NOASYNC` when nothing is pending or ready. |
| `sceIoWaitAsyncCB(fd: int, address: u32): int` | Same as `sceIoWaitAsync`, but the wait is allowed to run pending callbacks. |
| `sceIoPollAsync(fd: int, address: u32): u32` | Non-blocking check: writes the result if ready (returns 0), returns 1 while still in flight, or `NOASYNC`. |
| `sceIoGetAsyncStat(fd: int, poll: u32, address: u32): u32` | Behaves like `sceIoPollAsync` when `poll` is set, otherwise like `sceIoWaitAsync`. |
| `sceIoSetAsyncCallback(fd: int, clbckId: u32, clbckArg: u32): u32` | Registers the callback fired when the fd's async op completes; notifies right away if a result is already waiting. Returns 0, or `BADF`. |
| `sceIoChangeAsyncPriority(fd: int, priority: int): int` | No-op. We do not run real async threads, so there is no priority to change. Returns 0. |

## Devices and stdio

| Signature | What it does |
| --- | --- |
| `sceIoDevctl(name: const char*, cmd: int, argAddr: u32, argLen: int, outPtr: u32, outLen: int): u32` | Handles device control commands, mainly memory-stick queries: register/unregister an insert/eject callback (and notify "inserted"), report the device as ready, and report capacity and free space (faked at 1.5 GB). Unhandled commands log and return 0. |
| `sceIoIoctl(id: u32, cmd: u32, indataPtr: u32, inlen: u32, outdataPtr: u32, outlen: u32): u32` | Handles UMD ioctls (sector size 2048, file offset, file size, seek, raw read) and the three NPDRM ioctls: set PGD offset (`0x04100002`), open PGD with KIRK crypto (`0x04100001`), and get decrypted data size (`0x04100010`). |
| `sceKernelStdin(): u32` | Returns the stdin fd (0). |
| `sceKernelStdout(): u32` | Returns the stdout fd (1). Writes to it are captured into the kernel's stdout buffer, which is how the pspautotests suite reads program output. |
| `sceKernelStderr(): u32` | Returns the stderr fd (2). |
| `sceIoChangeThreadCwd(threadId: int, path: const char*): int` | PPSSPP leaves this unimplemented (no prototype in its tables). We make a best-effort change of the given thread's working directory. |
| `sceIoGetThreadCwd(threadId: int, buf: u32, length: int): int` | Also unimplemented in PPSSPP. We write the given thread's working directory string into `buf`, truncated to `length`. Returns 0. |
| `sceIoSync(devicename: const char*, flag: int): u32` | Flushes all open writable files to the persistent store. Returns 0. |

## NPDRM / PGD

| Signature | What it does |
| --- | --- |
| `sceNpDrmSetLicenseeKey(npDrmKeyAddr: u32): int` | Reads a 16-byte licensee key from guest memory and stores it for later PGD opens. Returns 0, or an error when the address is null. |
| `sceNpDrmClearLicenseeKey(): int` | Clears the stored licensee key. Returns 0. |
| `sceNpDrmRenameCheck(filename: const char*): int` | Stub that always succeeds (PPSSPP does the same). Returns 0. |
| `sceNpDrmEdataSetupKey(edataFd: u32): int` | Checks for the EDAT magic, sets the PGD offset to 0x90, reads the PGD header, and opens PGD decryption with KIRK. Returns 0, or an error when an EDAT file is seen with no licensee key set, or on a PGD key mismatch. |
| `sceNpDrmEdataGetDataSize(edataFd: u32): int` | Returns the PGD decrypted data size if decryption is active, otherwise the raw file size, or -1. |
| `sceNpDrmOpen(): int` | Unimplemented in PPSSPP; we log and return 0. |

When an encrypted file is opened, reads are decrypted block by block through the KIRK and AMCTRL (PGD) crypto. See [Loader & Crypto](/systems/loader-crypto).

## Stubs

Beyond the handlers above, this module no-ops a number of less-common calls via `kernel.stub`: kernel stdio reopen/read/write helpers (`sceKernelStdioOpen`, `sceKernelStdioRead`, `sceKernelStdioWrite`, and friends), IO driver and fd-list management (`sceIoAddDrv`, `sceIoDelDrv`, `sceIoGetFdList`, `sceIoCancel`, `sceIoReopen`, `sceIoCloseAll`, `sceIoUnassign`, `sceIoIoctlAsync`, `sceIoLseek32Async`), `printf`/`puts`/`fdprintf`, and the full USB, USB accessory, USB GPS, and USB microphone groups (around 40 calls).
