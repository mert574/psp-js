import "./style.css";
import { Logger } from "../utils/logger.js";
import { parseIso, readFile, type IsoVolume, type IsoFile } from "../iso/iso9660.js";
import { extractFromBuffer } from "../iso/iso-metadata.js";
import { setStatus, showError, clearError, showGameView, showFilePicker, showFileTree, clearGameVideo, clearGameAudio, playGameAudio, showAudioLoading, showAudioError, setMediaLoading, setGameCanvas, unlockAudio, showGameplayView, exitGameplayView, toggleGameplayHud, showAt3Loading, hideAt3Loading } from "./ui.js";
import { InputHandler } from "./input.js";
import { transcodeAt3, transcodePmfAudio } from "./pmf.js";
import { warmupAtracDecode, getDecodeConcurrency } from "../audio/atrac-decoder.js";
import { decodePmfNative, type PmfPlayer } from "./pmf-native.js";
import { PSPEmulator } from "../emulator.js";
import { FramebufferRenderer } from "../gpu/framebuffer-renderer.js";
import { DebugPanel } from "./debug-panel.js";
import { SavedataOverlay } from "./savedata-overlay.js";
import { SavedataList } from "./savedata-list.js";
import "./game-library.js";

declare global {
  interface Window {
    _dbgEmu?: PSPEmulator;
    _dbgLogger?: typeof Logger;
  }
}

const log = Logger.get("MAIN");

const fileInputIso    = document.getElementById("file-input-iso")   as HTMLInputElement | null;
const fileInputDir    = document.getElementById("file-input-dir")   as HTMLInputElement | null;
const fileInputEboot  = document.getElementById("file-input-eboot") as HTMLInputElement | null;
const bootBtn    = document.getElementById("boot-btn")!;
const backToLibBtn = document.getElementById("back-to-library-btn")!;
const errorClose = document.getElementById("error-close")!;

/** flash0 font data fetched from bundled assets at startup */
const flash0Fonts = new Map<string, Uint8Array>();

// ── Game library event ────────────────────────────────────────────────────────
document.getElementById("game-library")?.addEventListener("game-select", (e: Event) => {
  const file = (e as CustomEvent).detail.file as File;
  void handleIso(file);
});

// Load bundled PPSSPP open-source replacement PGF fonts eagerly
void (async () => {
  const names = [
    "ltn0","ltn1","ltn2","ltn3","ltn4","ltn5","ltn6","ltn7",
    "ltn8","ltn9","ltn10","ltn11","ltn12","ltn13","ltn14","ltn15",
  ];
  const results = await Promise.allSettled(
    names.map(n => fetch(`/flash0/font/${n}.pgf`).then(r => r.arrayBuffer()).then(b => ({ n, b })))
  );
  for (const r of results) {
    if (r.status === "fulfilled") {
      flash0Fonts.set(`flash0:/font/${r.value.n}.pgf`, new Uint8Array(r.value.b));
    }
  }
  log.info(`Bundled PGF fonts loaded: ${flash0Fonts.size}`);
})();

function isAudioDisabled(): boolean {
  return (document.getElementById("disable-audio-chk") as HTMLInputElement | null)?.checked ?? false;
}

// ── Hash-based router ─────────────────────────────────────────────────────────
// Routes: #library (default), #game/<id>, #play/<id>
// <id> is discId if available, else filename (sanitized).

let currentGameSlug = "";

function gameSlug(discId: string, fileName: string): string {
  return (discId || fileName.replace(/\.[^.]+$/, "")).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function navTo(route: string, replace = false): void {
  const hash = `#${route}`;
  if (replace) {
    history.replaceState({ route }, "", hash);
  } else {
    history.pushState({ route }, "", hash);
  }
}

let inputHandler: InputHandler | null = null;
let emulator: PSPEmulator | null = null;
let renderer: FramebufferRenderer | null = null;
let debugPanel: DebugPanel | null = null;
let rafHandle: number = 0;
let ebootBytes: Uint8Array | null = null;
let mediaAbort: AbortController | null = null;
let pmfPlayer: PmfPlayer | null = null;
let lastIsoBuffer: ArrayBuffer | null = null;
let lastIsoVolume: IsoVolume | null = null;
let pendingDirFiles: Map<string, Uint8Array> | null = null;


fileInputIso?.addEventListener("change", () => {
  const file = fileInputIso?.files?.[0];
  if (file) void handleIso(file);
});

fileInputDir?.addEventListener("change", () => {
  const files = fileInputDir?.files;
  if (files && files.length > 0) void handleDirectory(files);
});

fileInputEboot?.addEventListener("change", () => {
  const file = fileInputEboot?.files?.[0];
  if (file) void handleEboot(file);
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
  if (pmfPlayer) { pmfPlayer.stop(); pmfPlayer = null; }
  clearGameVideo();
  clearGameAudio();

  clearError();
  showGameplayView();
  navTo(`play/${currentGameSlug}`);
  inputHandler = new InputHandler();
  window.addEventListener("keydown", onHudToggle);

  const canvas = document.getElementById("psp-canvas") as HTMLCanvasElement;
  renderer = new FramebufferRenderer(canvas);
  debugPanel = new DebugPanel();

  emulator = new PSPEmulator();
  window._dbgEmu = emulator; // debug: expose for console inspection
  window._dbgLogger = Logger;  // debug: window._dbgLogger.minLevel = "debug"
  emulator.hle.inputSnapshot = () => inputHandler!.snapshot();

  // Wire savedata overlay + list selection (wait for custom element upgrades)
  void Promise.all([
    customElements.whenDefined("savedata-overlay"),
    customElements.whenDefined("savedata-list"),
  ]).then(() => {
    const overlay = document.querySelector<SavedataOverlay>("savedata-overlay");
    const list = document.querySelector<SavedataList>("savedata-list");
    if (overlay && emulator) {
      emulator.hle.onSavedataEvent = (action, _game, save, done, error) => {
        if (!done) overlay.show(action, _game, save);
        else overlay.complete(error);
      };
    }
    if (list && emulator) {
      emulator.hle.onSavedataListSelect = (action, slots) => list.show(action, slots);
    }
  });

  // Register ISO filesystem for lazy file access by HLE
  if (lastIsoVolume && lastIsoBuffer) {
    registerIsoFileSystem(emulator.hle.fileData, lastIsoVolume.root, lastIsoBuffer);
  }

  // Register directory files loaded via "Open Directory"
  if (pendingDirFiles) {
    for (const [key, val] of pendingDirFiles) {
      emulator.hle.fileData.set(key, val);
    }
    log.info(`Registered ${pendingDirFiles.size} directory files for HLE`);
  }

  // Register any PSP flash0 font files the user loaded
  for (const [key, val] of flash0Fonts) {
    emulator.hle.fileData.set(key, val);
  }

  void (async () => {
    if (!isAudioDisabled()) {
      // Unlock the Web Audio engine before starting the ELF so the AudioWorklet
      // is ready before the game's audio thread calls sceAudioOutputBlocking.
      // We are inside a click handler so AudioContext creation is allowed.
      try {
        await emulator!.hle.audioEngine.init();
      } catch (err: unknown) {
        log.warn(`AudioEngine init failed: ${err}`);
      }

      // Pre-warm ATRAC decode cache — largest files first so BGM starts decoding
      // immediately while smaller SFX files fill remaining pool slots.
      const at3Files: Uint8Array[] = [];
      for (const [path, data] of emulator!.hle.fileData) {
        if (path.toLowerCase().endsWith('.at3') || path.toLowerCase().endsWith('.at3p')) {
          at3Files.push(data);
        }
      }
      at3Files.sort((a, b) => b.byteLength - a.byteLength);
      if (at3Files.length > 0) {
        log.info(`Pre-decoding ${at3Files.length} AT3 file(s) with pooled FFmpeg...`);
        showAt3Loading(0, at3Files.length);
        let done = 0;
        let idx = 0;
        // Feed files to the pool incrementally: keep `concurrency` in-flight at a time.
        // This avoids holding all 100+ data buffers in memory simultaneously.
        const concurrency = getDecodeConcurrency();
        const next = (): Promise<void> => {
          if (idx >= at3Files.length) return Promise.resolve();
          const d = at3Files[idx++]!;
          return warmupAtracDecode(d)
            .then(() => { showAt3Loading(++done, at3Files.length); debugPanel?.updatePreBoot(); })
            .then(next);
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, at3Files.length) }, () => next()));
        hideAt3Loading();
        log.info(`AT3 pre-decode complete`);
      }
    } else {
      log.info("Audio disabled — skipping AudioEngine init and AT3 pre-decode");
    }

    try {
      await emulator!.loadElfBinary(ebootBytes!);
      debugPanel?.markEmulationStarted();
    } catch (err) {
      showError(`Failed to load EBOOT.BIN: ${String(err)}`, err);
      teardownGameplay();
      exitGameplayView();
      return;
    }

    await emulator!.initWorker();
    startRafLoop();
  })();
});
backToLibBtn.addEventListener("click", () => {
  mediaAbort?.abort(); mediaAbort = null;
  if (pmfPlayer) { pmfPlayer.stop(); pmfPlayer = null; }
  showFilePicker();
  pendingDirFiles = null;
  clearError(); setStatus(""); clearGameVideo(); clearGameAudio();
  navTo("library");
});
errorClose.addEventListener("click", () => clearError());

const exitBtn = document.getElementById("exit-btn")!;
exitBtn.addEventListener("click", () => {
  exitGameplayView();
  teardownGameplay();
  navTo(`game/${currentGameSlug}`);
});

// ── Canvas scale buttons ─────────────────────────────────────────────────────
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-scale]")) {
  btn.addEventListener("click", () => {
    const scale = Number(btn.dataset.scale);
    const primary = document.querySelector<HTMLElement>(".gameplay-primary");
    if (primary) primary.style.setProperty("--psp-scale", String(scale));
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-scale]")) {
      b.classList.toggle("perf-bar__btn--active", b === btn);
    }
  });
}

// ── Browser back/forward navigation ──────────────────────────────────────────
window.addEventListener("popstate", () => {
  const route = location.hash.replace(/^#/, "") || "library";

  if (route === "library" || route === "") {
    // Back to library: stop gameplay if running, hide preview
    if (emulator) { teardownGameplay(); }
    if (pmfPlayer) { pmfPlayer.stop(); pmfPlayer = null; }
    mediaAbort?.abort(); mediaAbort = null;
    clearGameVideo(); clearGameAudio();
    exitGameplayView();
    showFilePicker();
  } else if (route.startsWith("game/")) {
    // Back to preview from gameplay: stop emulator but keep preview visible
    if (emulator) {
      exitGameplayView();
      teardownGameplay();
    }
  } else if (route.startsWith("play/")) {
    // Forward into gameplay — can't re-enter without re-booting, redirect to preview
    if (!emulator && currentGameSlug) {
      navTo(`game/${currentGameSlug}`, true);
    }
  }
});

// Set initial route
if (!location.hash || location.hash === "#" || location.hash === "#library") {
  navTo("library", true);
}

function onHudToggle(e: KeyboardEvent): void {
  if (e.code === "Tab" || e.code === "KeyH") {
    e.preventDefault();
    toggleGameplayHud();
  }
}

function teardownGameplay(): void {
  stopRafLoop();
  renderer?.destroy();
  renderer = null;
  debugPanel?.destroy();
  debugPanel = null;
  emulator?.hle.audioEngine.destroy();
  emulator?.hle.terminateGeWorker();
  emulator = null;
  inputHandler?.destroy();
  inputHandler = null;
  window.removeEventListener("keydown", onHudToggle);
}


let _frameCount = 0;
let _fpsLastTime = 0;
let _fpsFrames = 0;
let _fpsValue = 0;
let _lastFrameTime = 0;
let _paused = false;
const FRAME_INTERVAL = 1000 / 60; // ~16.67ms for 60fps

function togglePause(): void {
  _paused = !_paused;
  const pauseBtn = document.getElementById("pause-btn");
  const stepBtn = document.getElementById("step-btn") as HTMLButtonElement | null;
  if (pauseBtn) pauseBtn.textContent = _paused ? "▶" : "⏸";
  if (stepBtn) stepBtn.disabled = !_paused;
  if (!_paused && rafHandle === 0) {
    _lastFrameTime = performance.now();
    rafHandle = requestAnimationFrame(frameLoop);
  }
}

function doSingleFrame(): void {
  if (!emulator || !_paused) return;
  runOneFrame();
}

/** Run one frame and render (shared between frame loop and step). */
function runOneFrame(): void {
  if (!emulator) return;
  _frameCount++;
  if (_frameCount >= 1_000_000_000) _frameCount = 0;

  let cpuMs = 0;
  try {
    const cpuStart = performance.now();
    emulator.runFrame();
    cpuMs = performance.now() - cpuStart;
  } catch (err) {
    stopRafLoop();
    if (emulator && debugPanel) debugPanel.dumpStubsToConsole(emulator);
    showError(`CPU error: ${String(err)}`, err);
    return;
  }

  const hle = emulator.hle;
  const fbAddr = hle.framebufAddr !== 0 ? hle.framebufAddr : hle.geFbAddr;
  if (fbAddr !== 0 && renderer) {
    renderer.render(emulator.bus.vramBuffer, fbAddr, hle.framebufWidth, hle.framebufFormat);
  }
  // One-time VRAM diagnostic
  if (_frameCount === 60) {
    const vram = emulator.bus.vramBuffer;
    const isShared = vram.buffer instanceof SharedArrayBuffer;
    const off = fbAddr !== 0 ? (fbAddr & 0x1FFFFFFF) - 0x04000000 : -1;
    let nz = 0;
    if (off >= 0) for (let i = 0; i < Math.min(480*272*4, vram.length - off); i++) { if (vram[off+i] !== 0) nz++; }
    console.log(`[VRAM-CHECK] shared=${isShared} fbAddr=0x${fbAddr.toString(16)} off=${off} nonZero=${nz}/${480*272*4} vramLen=${vram.length}`);
  }

  // Debug VRAM canvas: raw 2D pixel dump from VRAM at the framebuffer address
  if (fbAddr !== 0) {
    let dbgCanvas = document.getElementById("debug-vram") as HTMLCanvasElement | null;
    if (!dbgCanvas) {
      dbgCanvas = document.createElement("canvas");
      dbgCanvas.id = "debug-vram";
      dbgCanvas.width = 480;
      dbgCanvas.height = 272;
      dbgCanvas.style.cssText = "position:fixed;bottom:10px;right:10px;width:240px;height:136px;border:1px solid #0f0;z-index:9999;image-rendering:pixelated;background:#000;";
      document.body.appendChild(dbgCanvas);
    }
    const ctx = dbgCanvas.getContext("2d")!;
    const imgData = ctx.createImageData(480, 272);
    const vram = emulator.bus.vramBuffer;
    const offset = (fbAddr & 0x1FFFFFFF) - 0x04000000;
    const stride = hle.framebufWidth || 512;
    const fmt = hle.framebufFormat;
    if (offset >= 0 && offset + stride * 272 * 4 <= vram.length) {
      for (let y = 0; y < 272; y++) {
        for (let x = 0; x < 480; x++) {
          const dst = (y * 480 + x) * 4;
          if (fmt === 3) {
            // ABGR8888
            const src = offset + (y * stride + x) * 4;
            imgData.data[dst]     = vram[src + 2]!; // R from B
            imgData.data[dst + 1] = vram[src + 1]!; // G
            imgData.data[dst + 2] = vram[src]!;     // B from R
            imgData.data[dst + 3] = 255;
          } else if (fmt === 0) {
            // BGR5650
            const src = offset + (y * stride + x) * 2;
            const px = vram[src]! | (vram[src + 1]! << 8);
            imgData.data[dst]     = ((px >> 11) & 0x1F) << 3;
            imgData.data[dst + 1] = ((px >> 5) & 0x3F) << 2;
            imgData.data[dst + 2] = (px & 0x1F) << 3;
            imgData.data[dst + 3] = 255;
          } else {
            // Fallback: read as ABGR8888
            const src = offset + (y * stride + x) * 4;
            imgData.data[dst]     = vram[src + 2]!;
            imgData.data[dst + 1] = vram[src + 1]!;
            imgData.data[dst + 2] = vram[src]!;
            imgData.data[dst + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  const hudFps = document.getElementById("hud-fps");
  const hudFrame = document.getElementById("hud-frame");
  const hudTid = document.getElementById("hud-tid");
  const hudPc = document.getElementById("hud-pc");
  if (hudFps) hudFps.textContent = String(_fpsValue);
  if (hudFrame) hudFrame.textContent = String(_frameCount);
  if (hudTid) hudTid.textContent = String(emulator.hle.currentThreadId);
  if (hudPc) hudPc.textContent = emulator.cpu.regs.pc.toString(16);

  debugPanel?.update(emulator, cpuMs);

  if (emulator.halted) {
    stopRafLoop();
    if (debugPanel) debugPanel.dumpStubsToConsole(emulator);
    setStatus("Game exited.");
  }
}

function startRafLoop(): void {
  if (rafHandle !== 0) return;

  // Wire pause/step buttons
  document.getElementById("pause-btn")?.addEventListener("click", togglePause);
  document.getElementById("step-btn")?.addEventListener("click", doSingleFrame);
  _frameCount = 0;
  _fpsLastTime = performance.now();
  _lastFrameTime = performance.now();
  _fpsFrames = 0;
  _fpsValue = 0;
  _paused = false;

  rafHandle = requestAnimationFrame(frameLoop);
}

function frameLoop(): void {
  if (!emulator || _paused) return;

  // Throttle to ~60fps
  const now = performance.now();
  const elapsed = now - _lastFrameTime;
  if (elapsed < FRAME_INTERVAL) {
    rafHandle = requestAnimationFrame(frameLoop);
    return;
  }
  _lastFrameTime = now - (elapsed % FRAME_INTERVAL);
  _fpsFrames++;

  // FPS counter
  if (now - _fpsLastTime >= 1000) {
    _fpsValue = _fpsFrames;
    _fpsFrames = 0;
    _fpsLastTime = now;
  }

  runOneFrame();

  if (!emulator?.halted && !_paused) {
    rafHandle = requestAnimationFrame(frameLoop);
  }
}

function stopRafLoop(): void {
  if (rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

// ── ISO → HLE filesystem bridge ───────────────────────────────────────────────

/** Walk the ISO tree and register all files as disc0:/ paths for HLE access. */
function registerIsoFileSystem(
  fileData: Map<string, Uint8Array>,
  root: IsoFile,
  isoBuffer: ArrayBuffer,
): void {
  fileData.clear();
  function walk(entry: IsoFile, prefix: string): void {
    if (entry.isDirectory) {
      for (const child of entry.children ?? []) {
        walk(child, `${prefix}/${entry.name}`);
      }
    } else {
      // Lazily read on first access? No — just register the path.
      // readFile is cheap (subarray), actual copy only when needed.
      const pspPath = `disc0:${prefix}/${entry.name}`;
      const data = readFile(isoBuffer, entry);
      fileData.set(pspPath, new Uint8Array(data));
    }
  }
  for (const child of root.children ?? []) {
    walk(child, "");
  }
  log.info(`Registered ${fileData.size} ISO files for HLE`);
}

// ── ISO loading ───────────────────────────────────────────────────────────────
async function handleIso(file: File): Promise<void> {
  clearError();
  clearGameVideo();
  clearGameAudio();
  unlockAudio(); // unlock within user gesture so later async play() works
  pendingDirFiles = null;
  setStatus(`Reading ${file.name}…`);

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    showError(`Could not read file: ${String(err)}`, err);
    setStatus("");
    return;
  }

  let volume: IsoVolume;
  try {
    volume = parseIso(buffer);
  } catch (err) {
    showError(`Not a valid PSP ISO: ${String(err)}`, err);
    setStatus("");
    return;
  }
  lastIsoBuffer = buffer;
  lastIsoVolume = volume;

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
        log.info(`EBOOT.BIN extracted: ${ebootBytes.byteLength} bytes`);
      } catch (err) {
        log.warn(`Could not read EBOOT.BIN: ${err}`);
      }
    }
  }

  const meta = extractFromBuffer(buffer, volume);

  const pmfEntry   = pspGame.children?.find((f) => !f.isDirectory && f.name.toUpperCase() === "ICON1.PMF");
  const at3Entry   = pspGame.children?.find((f) => !f.isDirectory && f.name.toUpperCase() === "SND0.AT3");

  const gameInfo = {
    title: meta.title,
    discId: meta.discId,
    category: meta.category,
    version: meta.version,
    region: meta.region,
    parentalLevel: meta.parentalLevel,
    saveTitle: meta.saveTitle,
    saveDetail: meta.saveDetail,
  };

  // Show card immediately with static assets
  currentGameSlug = gameSlug(gameInfo.discId, file.name);
  showGameView(gameInfo, meta.iconUrl ?? undefined, meta.bgUrl ?? undefined, meta.logoUrl ?? undefined);
  showFileTree(volume.root);
  setStatus(`Loaded: ${gameInfo.title}${gameInfo.discId ? ` · ${gameInfo.discId}` : ""}`);
  navTo(`game/${currentGameSlug}`);

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
        // Stop any previous player
        if (pmfPlayer) { pmfPlayer.stop(); pmfPlayer = null; }
        const player = await decodePmfNative(pmfData);
        if (abort.signal.aborted) { player.stop(); return; }
        pmfPlayer = player;
        setGameCanvas(player.canvas);
        player.play();
      } catch (err) {
        if (abort.signal.aborted) return;
        log.warn("PMF decode failed:", err);
        setMediaLoading(false);
      }

      // Extract and play audio from PMF (runs in parallel with video)
      if (!at3Data && !isAudioDisabled()) {
        try {
          const audioUrl = await transcodePmfAudio(pmfData);
          if (abort.signal.aborted) { URL.revokeObjectURL(audioUrl); return; }
          playGameAudio(audioUrl);
        } catch (err) {
          if (abort.signal.aborted) return;
          log.warn("PMF audio extract failed:", err);
        }
      }
    }

    if (at3Data && !isAudioDisabled()) {
      if (abort.signal.aborted) return;
      showAudioLoading();
      try {
        const url = await transcodeAt3(at3Data);
        if (abort.signal.aborted) { URL.revokeObjectURL(url); return; }
        playGameAudio(url);
      } catch (err) {
        if (abort.signal.aborted) return;
        log.warn("AT3 transcode failed:", err);
        showAudioError();
      }
    }
  })();
}

// ── Directory loading ─────────────────────────────────────────────────────────
async function handleDirectory(files: FileList): Promise<void> {
  clearError();
  clearGameVideo();
  clearGameAudio();
  unlockAudio();
  lastIsoBuffer = null;
  lastIsoVolume = null;
  setStatus("Reading directory... (large directories may take a moment)");

  // Build a map of webkitRelativePath → Uint8Array, stripping the top directory component
  const dirMap = new Map<string, Uint8Array>();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f) continue;
    // webkitRelativePath is like "GameDir/PSP_GAME/SYSDIR/EBOOT.BIN"
    const rel = (f as any).webkitRelativePath as string || f.name;
    const slash = rel.indexOf("/");
    const stripped = slash >= 0 ? rel.slice(slash + 1) : rel; // strip top dir
    try {
      const buf = await f.arrayBuffer();
      dirMap.set(stripped, new Uint8Array(buf));
    } catch (err) {
      log.warn(`Could not read directory file ${rel}: ${err}`);
    }
  }
  pendingDirFiles = dirMap;

  // Determine EBOOT.BIN
  ebootBytes = null;

  // Check for EBOOT.PBP at first depth (e.g. "EBOOT.PBP")
  const ebootPbp = dirMap.get("EBOOT.PBP") ?? dirMap.get("eboot.pbp");
  if (ebootPbp) {
    ebootBytes = ebootPbp;
    log.info(`Found EBOOT.PBP in directory root: ${ebootBytes.byteLength} bytes`);
  } else {
    // Look for PSP_GAME/SYSDIR/EBOOT.BIN (case-insensitive)
    for (const [key] of dirMap) {
      if (key.toUpperCase() === "PSP_GAME/SYSDIR/EBOOT.BIN") {
        ebootBytes = dirMap.get(key)!;
        log.info(`Found EBOOT.BIN at ${key}: ${ebootBytes.byteLength} bytes`);
        break;
      }
    }
  }

  // Try to find PARAM.SFO for metadata
  let gameInfo = {
    title: files[0] ? (files[0] as any).webkitRelativePath?.split("/")?.[0] ?? "Unknown" : "Unknown",
    discId: "",
    category: "",
    version: "",
    region: "",
    parentalLevel: 0,
    saveTitle: "",
    saveDetail: ""
  };

  let sfoData: Uint8Array | undefined;
  for (const [key] of dirMap) {
    if (key.toUpperCase() === "PSP_GAME/PARAM.SFO") {
      sfoData = dirMap.get(key);
      break;
    }
  }
  if (sfoData) {
    try {
      const { parseSfo: pSfo, extractGameInfo: eInfo } = await import("../iso/sfo.js");
      const parsed = pSfo(sfoData.buffer as ArrayBuffer);
      gameInfo = eInfo(parsed);
    } catch (err) {
      log.warn(`Could not parse PARAM.SFO: ${err}`);
    }
  }

  showGameView(gameInfo, undefined, undefined, undefined);
  setStatus(`Loaded directory: ${gameInfo.title}${gameInfo.discId ? ` · ${gameInfo.discId}` : ""}`);
}

// ── Direct EBOOT / PBP loading ────────────────────────────────────────────────
async function handleEboot(file: File): Promise<void> {
  clearError();
  clearGameVideo();
  clearGameAudio();
  unlockAudio();
  lastIsoBuffer = null;
  lastIsoVolume = null;
  pendingDirFiles = null;
  setStatus(`Reading ${file.name}…`);

  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch (err) {
    showError(`Could not read file: ${String(err)}`, err);
    setStatus("");
    return;
  }

  ebootBytes = new Uint8Array(buf);

  const gameInfo = {
    title: file.name,
    discId: "",
    category: "",
    version: "",
    region: "",
    parentalLevel: 0,
    saveTitle: "",
    saveDetail: ""
  };

  showGameView(gameInfo, undefined, undefined, undefined);
  setStatus("Direct ELF boot — disc filesystem not available");
}
