import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<FFmpeg> {
  if (loadPromise === null) {
    ffmpeg = new FFmpeg();

    if (import.meta.env.DEV) {
      ffmpeg.on("log", ({ message }) => console.debug("[ffmpeg]", message));
    }

    loadPromise = ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });
  }

  // Always await loadPromise — concurrent callers must wait for load to finish
  await loadPromise;
  return ffmpeg!;
}

export async function transcodeAt3(at3Data: Uint8Array): Promise<string> {
  const ff = await ensureLoaded();

  // Collect FFmpeg log for diagnostics
  const logs: string[] = [];
  const logHandler = ({ message }: { message: string }) => logs.push(message);
  ff.on("log", logHandler);

  try {
    await ff.writeFile("snd.at3", at3Data);

    // ATRAC3 (.at3) is in a RIFF/WAV container; FFmpeg can demux it but
    // the atrac3 decoder may not be in the WASM build. We try MP3 output
    // and fall back to PCM (WAV) if the codec is unavailable.
    let ret = await ff.exec(["-i", "snd.at3", "-c:a", "libmp3lame", "-q:a", "4", "snd.mp3"]);

    if (ret === 0) {
      const data = await ff.readFile("snd.mp3") as Uint8Array;
      return URL.createObjectURL(new Blob([data.buffer], { type: "audio/mpeg" }));
    }

    // libmp3lame failed — try raw PCM WAV (no re-encode needed, just demux)
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

export async function transcodepmf(pmfData: Uint8Array): Promise<string> {
  const ff = await ensureLoaded();

  await ff.writeFile("icon.pmf", pmfData);

  const ret = await ff.exec([
    "-i", "icon.pmf",
    "-c:v", "libvpx",
    "-b:v", "512k",
    "-an",
    "-vf", "scale=144:80",
    "icon.webm",
  ]);

  if (ret !== 0) {
    throw new Error(`FFmpeg exited with code ${ret}`);
  }

  const data = await ff.readFile("icon.webm") as Uint8Array;
  const blob = new Blob([data.buffer], { type: "video/webm" });
  return URL.createObjectURL(blob);
}
