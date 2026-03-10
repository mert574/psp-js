/**
 * Audio transcoding for PSP media files.
 *
 * AT3 (ATRAC3) is a proprietary Sony codec not supported by libav.js pre-built
 * variants. We use @ffmpeg/ffmpeg (full FFmpeg WASM) as a fallback for audio.
 *
 * TODO: Replace with libav.js custom build that includes ATRAC3 decoder,
 * or decode AT3 natively via a dedicated ATRAC3 WASM module.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<FFmpeg> {
  if (loadPromise === null) {
    ffmpeg = new FFmpeg();

    loadPromise = ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });
  }

  await loadPromise;
  return ffmpeg!;
}

export async function transcodeAt3(at3Data: Uint8Array): Promise<string> {
  const ff = await ensureLoaded();

  const logs: string[] = [];
  const logHandler = ({ message }: { message: string }) => logs.push(message);
  ff.on("log", logHandler);

  try {
    await ff.writeFile("snd.at3", at3Data);

    let ret = await ff.exec(["-i", "snd.at3", "-c:a", "libmp3lame", "-q:a", "4", "snd.mp3"]);

    if (ret === 0) {
      const data = await ff.readFile("snd.mp3") as Uint8Array;
      return URL.createObjectURL(new Blob([data.buffer], { type: "audio/mpeg" }));
    }

    ret = await ff.exec(["-i", "snd.at3", "-c:a", "pcm_s16le", "snd.wav"]);
    if (ret === 0) {
      const data = await ff.readFile("snd.wav") as Uint8Array;
      return URL.createObjectURL(new Blob([data.buffer], { type: "audio/wav" }));
    }

    throw new Error(`FFmpeg could not decode AT3 (exit ${ret}). Logs:\n${logs.slice(-10).join("\n")}`);
  } finally {
    ff.off("log", logHandler);
  }
}
