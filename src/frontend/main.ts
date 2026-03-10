import "./style.css";
import { parseIso, readFile } from "../iso/iso9660.js";
import { parseSfo, extractGameInfo } from "../iso/sfo.js";
import { setStatus, showError, clearError, showGameView, showDropZone, showFileTree, clearGameVideo, clearGameAudio, playGameAudio, showAudioLoading, showAudioError, setMediaLoading, setGameVideo, unlockAudio, showGameplayView, exitGameplayView, toggleGameplayHud } from "./ui.js";
import { InputHandler } from "./input.js";
import { transcodepmf, transcodeAt3 } from "./pmf.js";
import { PSPEmulator } from "../emulator.js";

const dropZone   = document.getElementById("drop-zone")   as HTMLElement;
const fileInput  = document.getElementById("file-input")  as HTMLInputElement;
const bootBtn    = document.getElementById("boot-btn")!;
const changeBtn  = document.getElementById("change-btn")!;
const errorClose = document.getElementById("error-close")!;

let inputHandler: InputHandler | null = null;
let emulator: PSPEmulator | null = null;
let rafHandle: number = 0;
let ebootBytes: Uint8Array | null = null;
let mediaAbort: AbortController | null = null;

// ── Drop zone ─────────────────────────────────────────────────────────────────
// The <label for="file-input"> handles click-to-browse natively.
// We also open the picker when clicking the zone background directly.
dropZone.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).tagName !== "LABEL") fileInput.click();
});

dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("drop-zone--drag-over"); });
dropZone.addEventListener("dragleave", ()  => dropZone.classList.remove("drop-zone--drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drop-zone--drag-over");
  const file = e.dataTransfer?.files[0];
  if (file) void handleFile(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void handleFile(file);
});

// ── Buttons ───────────────────────────────────────────────────────────────────
bootBtn.addEventListener("click", () => {
  if (!ebootBytes) {
    showError("No EBOOT.BIN found in this ISO — cannot boot.");
    return;
  }

  // Cancel any in-progress media transcoding
  mediaAbort?.abort();
  mediaAbort = null;
  clearGameVideo();
  clearGameAudio();

  clearError();
  showGameplayView();
  inputHandler = new InputHandler();
  window.addEventListener("keydown", onHudToggle);

  emulator = new PSPEmulator();
  emulator.hle.inputSnapshot = () => inputHandler!.snapshot();

  void (async () => {
    try {
      await emulator!.loadElfBinary(ebootBytes!);
    } catch (err) {
      showError(`Failed to load EBOOT.BIN: ${String(err)}`);
      teardownGameplay();
      exitGameplayView();
      return;
    }

    startRafLoop();
  })();
});
changeBtn.addEventListener("click",  () => { mediaAbort?.abort(); mediaAbort = null; showDropZone(); fileInput.value = ""; clearError(); setStatus(""); clearGameVideo(); clearGameAudio(); });
errorClose.addEventListener("click", () => clearError());

const exitBtn = document.getElementById("exit-btn")!;
exitBtn.addEventListener("click", () => {
  exitGameplayView();
  teardownGameplay();
});

function onHudToggle(e: KeyboardEvent): void {
  if (e.code === "Tab" || e.code === "KeyH") {
    e.preventDefault();
    toggleGameplayHud();
  }
}

function teardownGameplay(): void {
  stopRafLoop();
  emulator = null;
  inputHandler?.destroy();
  inputHandler = null;
  window.removeEventListener("keydown", onHudToggle);
}

const STEPS_PER_FRAME = 2000;

function startRafLoop(): void {
  if (rafHandle !== 0) return;

  function frame(): void {
    if (!emulator) return;

    try {
      emulator.run(STEPS_PER_FRAME);
    } catch (err) {
      stopRafLoop();
      showError(`CPU error: ${String(err)}`);
      return;
    }

    if (emulator.halted) {
      stopRafLoop();
      setStatus("Game exited.");
      return;
    }

    rafHandle = requestAnimationFrame(frame);
  }

  rafHandle = requestAnimationFrame(frame);
}

function stopRafLoop(): void {
  if (rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

// ── ISO loading ───────────────────────────────────────────────────────────────
async function handleFile(file: File): Promise<void> {
  clearError();
  clearGameVideo();
  clearGameAudio();
  unlockAudio(); // unlock within user gesture so later async play() works
  setStatus(`Reading ${file.name}…`);

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    showError(`Could not read file: ${String(err)}`);
    setStatus("");
    return;
  }

  let volume;
  try {
    volume = parseIso(buffer);
  } catch (err) {
    showError(`Not a valid PSP ISO: ${String(err)}`);
    setStatus("");
    return;
  }

  const pspGame = volume.root.children?.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME"
  );

  if (!pspGame) {
    showError("No PSP_GAME directory found — this may not be a PSP disc image.");
    setStatus("");
    return;
  }

  // Locate SYSDIR/EBOOT.BIN for the emulator
  ebootBytes = null;
  const sysdirEntry = pspGame.children?.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "SYSDIR"
  );
  if (sysdirEntry) {
    const ebootEntry = sysdirEntry.children?.find(
      (f) => !f.isDirectory && f.name.toUpperCase() === "EBOOT.BIN"
    );
    if (ebootEntry) {
      try {
        ebootBytes = readFile(buffer, ebootEntry).slice();
        console.log(`[MAIN] EBOOT.BIN extracted: ${ebootBytes.byteLength} bytes`);
      } catch (err) {
        console.warn(`[MAIN] Could not read EBOOT.BIN: ${err}`);
      }
    }
  }

  const sfoEntry  = pspGame.children?.find((f) => !f.isDirectory && f.name.toUpperCase() === "PARAM.SFO");
  const bgEntry   = pspGame.children?.find((f) => !f.isDirectory && f.name.toUpperCase() === "PIC1.PNG");
  const iconEntry = pspGame.children?.find((f) => !f.isDirectory && f.name.toUpperCase() === "ICON0.PNG");
  const pmfEntry  = pspGame.children?.find((f) => !f.isDirectory && f.name.toUpperCase() === "ICON1.PMF");
  const at3Entry  = pspGame.children?.find((f) => !f.isDirectory && f.name.toUpperCase() === "SND0.AT3");

  let bgUrl:   string | undefined;
  let iconUrl: string | undefined;

  if (bgEntry) {
    try {
      bgUrl = URL.createObjectURL(new Blob([readFile(buffer, bgEntry)], { type: "image/png" }));
    } catch { /* non-fatal */ }
  }
  if (iconEntry) {
    try {
      iconUrl = URL.createObjectURL(new Blob([readFile(buffer, iconEntry)], { type: "image/png" }));
    } catch { /* non-fatal */ }
  }

  let gameInfo = { title: volume.volumeId, discId: "", category: "", version: "" };
  if (sfoEntry) {
    try {
      const sfoData = parseSfo(readFile(buffer, sfoEntry).slice().buffer);
      gameInfo = extractGameInfo(sfoData);
    } catch (err) {
      showError(`Could not parse PARAM.SFO: ${String(err)}`);
    }
  }

  // Show card immediately with static assets
  showGameView(gameInfo, iconUrl, bgUrl);
  showFileTree(volume.root);
  setStatus(`Loaded: ${gameInfo.title}${gameInfo.discId ? ` · ${gameInfo.discId}` : ""}`);

  // Pre-read media data as independent copies before any transcoding starts.
  // readFile() returns a view into the ISO ArrayBuffer; FFmpeg's writeFile()
  // may transfer (detach) that buffer, making later views invalid.
  const pmfData = pmfEntry ? readFile(buffer, pmfEntry).slice() : undefined;
  const at3Data = at3Entry ? readFile(buffer, at3Entry).slice() : undefined;

  // Transcode PMF then AT3 sequentially (FFmpeg can only run one exec at a time)
  // Use AbortController so boot/change can cancel stale results
  mediaAbort?.abort();
  const abort = new AbortController();
  mediaAbort = abort;

  void (async () => {
    if (pmfData) {
      setMediaLoading(true);
      try {
        const url = await transcodepmf(pmfData);
        if (abort.signal.aborted) { URL.revokeObjectURL(url); return; }
        setGameVideo(url);
      } catch (err) {
        if (abort.signal.aborted) return;
        console.warn("PMF transcode failed:", err);
        setMediaLoading(false);
      }
    }

    if (at3Data) {
      if (abort.signal.aborted) return;
      showAudioLoading();
      try {
        const url = await transcodeAt3(at3Data);
        if (abort.signal.aborted) { URL.revokeObjectURL(url); return; }
        playGameAudio(url);
      } catch (err) {
        if (abort.signal.aborted) return;
        console.warn("AT3 transcode failed:", err);
        showAudioError();
      }
    }
  })();
}
