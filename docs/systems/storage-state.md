# Storage & Save States

Two separate persistence systems: **storage** keeps a game's savedata and files across sessions; **save states** snapshot the whole machine.

## Storage (`src/storage/`)

| File | Contents |
| --- | --- |
| `savedata-store.ts` | `SavedataStore`, persistent save games (IndexedDB, memory fallback) |
| `file-store.ts` | `FileStore`, persistent raw file writes (memory-stick simulation) |

`SavedataStore` backs the `sceUtilitySavedata` dialogs. It stores `SaveEntry` records, where `SaveEntry` is `{ key: string; data: Uint8Array; dataSize: number; title: string; detail: string; timestamp: number }`.

`save(key: string, entry: SaveEntry): Promise<void>`

Write a save under `key`.

`load(key: string): Promise<SaveEntry | null>`

Read a save, or `null` if there is none.

`delete(key: string): Promise<boolean>`

Remove a save. Returns whether one existed.

`list(prefix: string): Promise<SaveEntry[]>`

All saves whose key starts with `prefix`.

`exists(key: string): Promise<boolean>`

Whether a save exists under `key`.

Each method has an optional synchronous variant (`saveSync`, `loadSync`, `deleteSync`, `listSync`, `existsSync`) for HLE handlers that cannot await.

`FileStore` backs raw `sceIo*` file writes, for games that manage their own files under `ms0:`. It is keyed by full file path:

`loadAll(): Promise<Map<string, Uint8Array>>`

Load every stored file (called at boot to populate the kernel's `fileData`).

`put(path: string, data: Uint8Array): Promise<void>`

Write or overwrite a file.

`remove(path: string): Promise<boolean>`

Delete a file. Returns whether it existed.

Both use IndexedDB in the browser and fall back to an in-memory map in Node or private browsing.

On boot the file store is loaded and its files populate the kernel's `fileData`, so a game sees its previous saves.

## Save states (`src/state/`)

A save state is a whole-machine snapshot written to a `.pspstate` file.

| File | Contents |
| --- | --- |
| `save-state.ts` | format version, section names, `SnapshotJson` |
| `state-container.ts` | `packContainer` / `unpackContainer` (binary container with `"PSPS"` magic, gzipped sections) |
| `savestate-pack.worker.ts` | off-main-thread compression |

### What's in it

- **Header**: game id, EBOOT content hash, format version, metadata.
- **Sections**: `ram` (gzipped), `vram` (gzipped), `scratchpad` (raw), `cpuregs` (raw), and `state` (a gzipped JSON object holding CPU/kernel/timing/GE state).

Each subsystem provides its own serialize/deserialize: `AllegrexCPU.serialize()`/`deserialize()`, `AllegrexRegisters.serializeScalars()`/`deserializeScalars()` (the raw register buffers go in the separate `cpuregs` section via `dumpRegBuffers()`/`loadRegBuffers()`), `CoreTiming.serialize()`/`deserialize()`, `HLEKernel.serialize()`/`deserialize()`, and `GEProcessor.serialize()`/`deserialize()`. The typed arrays are stored as plain number arrays so the JSON round-trips.

### Restore

`PSPEmulator.loadState(blob, opts?)` requires the caller to have already booted the matching game (so handlers, trampolines, and CoreTiming event types are wired), then overlays the saved data onto the running machine. The restore is **bound to the game**: it checks the game id and the EBOOT hash and refuses to load a state from a different game (unless `ignoreGameMismatch`) or, by default, a different build (unless `allowBuildMismatch`). After it returns, the caller drops the renderer's cached textures and GPU framebuffers (`invalidateTextures()` / `clearVFBs()`) so both rebuild from the restored VRAM before drawing again.

```bash
# Replay a browser-exported state headless (the most reliable repro path)
npx tsx tools/savestate.ts <state.pspstate> <iso> [extra-frames]
```

::: tip A debugging superpower
Because a save state captures in-game VRAM and machine state, restoring one headless lets the **software** rasterizer reproduce an in-game rendering bug offline, without having to navigate menus with no input. This is how several rendering bugs in this emulator were tracked down.
:::

### Gotchas

- States are game- and build-bound. Same game, different EBOOT (region/patch/rip) is blocked unless you pass `allowBuildMismatch`; a different game id is blocked unless you pass `ignoreGameMismatch`.
- `HLEKernel.snapshotBlockers()` reports reasons a snapshot isn't safe right now (e.g. pending async I/O).
- Bundled `flash0` fonts reload, but user-opened fonts and a mid-decode video frame may not survive cleanly.
- A subtle gotcha to watch for: a VFPU register stored as raw bits can carry a NaN bit pattern that must round-trip exactly.
