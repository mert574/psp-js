# ISO & SFO

`src/iso/` reads the disc container and the game metadata inside it.

| File | Contents |
| --- | --- |
| `iso9660.ts` | `parseIso`, `parseIsoFromFile`, `readFile`, ISO 9660 reader |
| `sfo.ts` | `parseSfo`, `extractGameInfo`, the `PARAM.SFO` parser |
| `iso-metadata.ts` | disc metadata extraction |

## ISO9660

`parseIso(buffer: ArrayBuffer): IsoVolume`

Parse an ISO image into an `IsoVolume` (`{ volumeId, root }`): a directory tree of `IsoFile` entries (`name`, `isDirectory`, `lba` start sector, `size`, and `children` for directories).

`parseIsoFromFile(file: File): Promise<IsoVolume>`

The same, but reads from a browser `File` lazily instead of an in-memory buffer.

`readFile(buffer: ArrayBuffer, file: IsoFile): Uint8Array`

Read an entry's bytes from an in-memory ISO buffer.

`readFileFromIso(file: File, entry: IsoFile): Promise<Uint8Array>`

Read an entry's bytes straight from a browser `File`.

Path resolution is case-insensitive (PSP filesystems are).

When a game boots, the ISO's files are mounted into the kernel's in-memory filesystem (`fileData`) so `sceIo*` calls can read them.

## PARAM.SFO

`parseSfo(buffer)` parses the System File Object into key/value pairs; `extractGameInfo` wraps the common fields:

| Key | Meaning |
| --- | --- |
| `TITLE` | Game title |
| `DISC_ID` | Region + serial (e.g. `ULUS12345`) |
| `APP_VER` | Version string (what `extractGameInfo` reads for `version`) |
| `CATEGORY` | `UG` = UMD game, `MG` = memory-stick game, etc. |
| `MEMSIZE` | `0` = 32 MB, `1` = 64 MB |
| `SAVEDATA_*` | Savedata title/detail/size |

Two of these drive emulator behaviour:

- **`DISC_ID`** is the game id used to bind [save states](/systems/storage-state) (falling back to a sanitized slug of the file name for homebrew with no disc id).
- **`MEMSIZE`** decides whether the game gets 32 MB or 64 MB of RAM. See [the memory model](/systems/memory#the-psp-memory-model).

The region is derived from the `DISC_ID` prefix (`UCUS`/`ULUS` = North America, `UCES`/`ULES` = Europe, `UCJS`/`ULJS` = Japan, …).
