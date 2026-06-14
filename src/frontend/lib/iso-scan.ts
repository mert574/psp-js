/** Recursively scan a chosen directory for PSP game images (.iso / .pbp),
 *  keeping each file's handle and parent dir so they can be re-acquired later. */

const ISO_EXTENSIONS = new Set([".iso", ".pbp"]);

export interface ScannedFile {
  file: File;
  handle: FileSystemFileHandle;
  parentDir: FileSystemDirectoryHandle;
}

export async function scanDirectory(dirHandle: FileSystemDirectoryHandle): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];

  async function walk(handle: FileSystemDirectoryHandle): Promise<void> {
    for await (const entry of handle.values()) {
      if (entry.kind === "file") {
        const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
        if (ISO_EXTENSIONS.has(ext)) {
          try {
            const file = await (entry as FileSystemFileHandle).getFile();
            results.push({ file, handle: entry as FileSystemFileHandle, parentDir: handle });
          } catch { /* permission denied — skip */ }
        }
      } else if (entry.kind === "directory") {
        try {
          await walk(entry);
        } catch { /* permission denied — skip */ }
      }
    }
  }

  await walk(dirHandle);
  return results;
}
