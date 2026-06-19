/**
 * Audio transcoding for PSP media files.
 *
 * AT3 (ATRAC3) is a proprietary Sony codec not supported by libav.js pre-built
 * variants. We use @ffmpeg/ffmpeg (full FFmpeg WASM) as a fallback for audio.
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

    // The @ffmpeg/ffmpeg load() returns a Promise<boolean> but we want void.
    // Casting via unknown to satisfy the loadPromise: Promise<void> type.
    loadPromise = (ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    }) as unknown) as Promise<void>;
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
      // data.buffer might be SharedArrayBuffer which Blob constructor doesn't accept.
      // slice() creates a copy as a regular ArrayBuffer.
      return URL.createObjectURL(new Blob([data.slice().buffer], { type: "audio/mpeg" }));
    }

    ret = await ff.exec(["-i", "snd.at3", "-c:a", "pcm_s16le", "snd.wav"]);
    if (ret === 0) {
      const data = await ff.readFile("snd.wav") as Uint8Array;
      return URL.createObjectURL(new Blob([data.slice().buffer], { type: "audio/wav" }));
    }

    throw new Error(`FFmpeg could not decode AT3 (exit ${ret}). Logs:\n${logs.slice(-10).join("\n")}`);
  } finally {
    ff.off("log", logHandler);
  }
}

/**
 * Decode the audio track of a PSMF (.pmf) to raw PCM (44100 Hz, stereo, s16le
 * interleaved). Used by the in-game scePsmfPlayer so cutscene audio plays
 * through the normal sceAudio output path. Returns an empty array if the PMF
 * has no decodable audio track.
 */
export async function decodePmfAudioToPcm(pmfData: Uint8Array): Promise<Int16Array> {
  const ff = await ensureLoaded();
  await ff.writeFile("aud.pmf", pmfData);
  const ret = await ff.exec([
    "-i", "aud.pmf", "-vn",
    "-f", "s16le", "-acodec", "pcm_s16le",
    "-ar", "44100", "-ac", "2",
    "aud.pcm",
  ]);
  if (ret !== 0) return new Int16Array(0);
  const data = (await ff.readFile("aud.pcm")) as Uint8Array;
  // Copy out of the (possibly Shared)ArrayBuffer and reinterpret as s16.
  const copy = data.slice();
  return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength >> 1);
}

/** Extract and transcode the audio track from a PSMF (.pmf) file to a playable URL. */
export async function transcodePmfAudio(pmfData: Uint8Array): Promise<string> {
  const ff = await ensureLoaded();

  await ff.writeFile("video.pmf", pmfData);

  // Extract audio only, transcode to MP3
  let ret = await ff.exec(["-i", "video.pmf", "-vn", "-c:a", "libmp3lame", "-q:a", "4", "audio.mp3"]);
  if (ret === 0) {
    const data = await ff.readFile("audio.mp3") as Uint8Array;
    return URL.createObjectURL(new Blob([data.slice().buffer], { type: "audio/mpeg" }));
  }

  // Fallback to WAV
  ret = await ff.exec(["-i", "video.pmf", "-vn", "-c:a", "pcm_s16le", "audio.wav"]);
  if (ret === 0) {
    const data = await ff.readFile("audio.wav") as Uint8Array;
    return URL.createObjectURL(new Blob([data.slice().buffer], { type: "audio/wav" }));
  }

  throw new Error("FFmpeg could not extract audio from PMF");
}
