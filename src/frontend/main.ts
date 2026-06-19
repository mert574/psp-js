import { Logger } from "../utils/logger.js";
import { parseIso, parseIsoFromFile, readFile, readFileFromIso, type IsoVolume, type IsoFile } from "../iso/iso9660.js";
import type { PspFileSystem } from "../kernel/psp-filesystem.js";
import { setStatus, showError, clearError, showGameView, showFilePicker, showFileTree, clearGameVideo, clearGameAudio, playGameAudio, showAudioLoading, showAudioError, setMediaLoading, setGameCanvas, unlockAudio, showGameplayView, exitGameplayView, toggleGameplayHud, showAt3Loading, hideAt3Loading, gameAudioTimeUs } from "./ui.js";
import { InputHandler } from "./input.js";
import { transcodeAt3, transcodePmfAudio } from "./pmf.js";
import { warmupAtracDecode, getDecodeConcurrency } from "../audio/atrac-decoder.js";
import { decodePmfNative, type PmfPlayer } from "./pmf-native.js";
import { PSPEmulator } from "../emulator.js";
import { CpuProfiler } from "../cpu/cpu-profiler.js";
import { isPbp, parsePbp, type PbpContents } from "../loader/pbp.js";
import { parseSfo, extractGameInfo } from "../iso/sfo.js";
import { FramebufferRenderer } from "../gpu/framebuffer-renderer.js";
import { WebGLGERenderer } from "../gpu/ge-webgl-renderer.js";
import "./debug-panel.js"; // registers the <debug-panel> custom element
import type { DebugPanel } from "./debug-panel.js";
import "./savedata-overlay.js"; // registers <savedata-overlay>
import type { SavedataOverlay } from "./savedata-overlay.js";
import "./savedata-list.js"; // registers <savedata-list>
import type { SavedataList } from "./savedata-list.js";
import "./game-library.js";
import "./app-bar.js"; // registers the <app-bar> custom element
import { initWaveBackground } from "./wave-background.js";
import { FRAMESKIP_AUTO, FRAMESKIP_OFF, type FrameSkipMode } from "./frameskip.js";

initWaveBackground();

declare global {
  interface Window {
    _dbgEmu?: PSPEmulator;
    _dbgLogger?: typeof Logger;
    /** Auto-pause the play loop once it reaches this displayed-frame count.
     *  Set live from the console (`_dbgPauseAt(30)`) or via `?pauseAt=30` in the
     *  URL. 0 disables. Pausing stops the rAF loop entirely, which is what frees
     *  the machine — leaving the play page running is the real cost. */
    _dbgPauseAt?: (frame: number) => void;
    /** Per-frame profiler: splits each displayed frame into CPU (runFrame =
     *  interpreter + inline GE) vs present (GPU submit) vs idle, so you can see
     *  where the frame time actually goes. Enable with ?perf in the URL (it then
     *  auto-prints a frames 11..pauseAt-1 summary at the ?pauseAt frame), or drive
     *  it live: _dbgPerf.start(), let it run, _dbgPerf.report(from, to). */
    _dbgPerf?: { start(): void; stop(): void; report(from?: number, to?: number): void };
    /** Interpreter profiler: instruction-mix histogram + hot-PC sampling, to find
     *  where the MIPS interpreter time goes. Separate from _dbgPerf so it doesn't
     *  skew the frame-timing run (counting adds a little per-instruction cost).
     *  Drive it: _dbgCpuProf.start(), let it run a few seconds, _dbgCpuProf.report(). */
    _dbgCpuProf?: { start(sampleEvery?: number): void; stop(): void; report(topN?: number): void };
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
// mode "boot" (default for a card click) loads the game and jumps straight into
// gameplay. mode "options" (the gear) opens the info/boot-options screen instead.
document.getElementById("game-library")?.addEventListener("game-select", (e: Event) => {
  const detail = (e as CustomEvent).detail as {
    file: File; parentDir: FileSystemDirectoryHandle | null; mode?: "boot" | "options" | "details";
  };
  const mode = detail.mode ?? "boot";
  // "details" opens the details page (#details); "options" the boot screen
  // (#game); only "boot" goes straight into gameplay. The details intent is
  // passed through, not left as sticky module state.
  void handleIso(detail.file, detail.parentDir ?? undefined, mode === "boot", mode === "details");
});

// ── Debug: ?iso=/name.iso fetches an ISO served from public/ and boots it ────
// Lets scripted browser sessions load a game without the folder picker.
void (async () => {
  const isoParam = new URLSearchParams(location.search).get("iso");
  if (!isoParam) return;
  try {
    const resp = await fetch(isoParam);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const name = isoParam.split("/").pop() ?? "game.iso";
    await handleIso(new File([blob], name));
  } catch (err) {
    log.error(`?iso= autoload failed: ${err}`);
  }
})();

// Load bundled PPSSPP open-source replacement PGF fonts eagerly
void (async () => {
  const names = [
    "ltn0","ltn1","ltn2","ltn3","ltn4","ltn5","ltn6","ltn7",
    "ltn8","ltn9","ltn10","ltn11","ltn12","ltn13","ltn14","ltn15",
  ];
  const results = await Promise.allSettled(
    names.map(n => fetch(`${import.meta.env.BASE_URL}flash0/font/${n}.pgf`).then(r => r.arrayBuffer()).then(b => ({ n, b })))
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

function isSoftwareRenderer(): boolean {
  return (document.getElementById("renderer-select") as HTMLSelectElement | null)?.value === "software";
}

function isProfilerEnabled(): boolean {
  return (document.getElementById("profiler-chk") as HTMLInputElement | null)?.checked ?? false;
}

function resolutionScale(): number {
  const v = (document.getElementById("resolution-select") as HTMLSelectElement | null)?.value;
  const n = v ? parseInt(v, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

// ── Boot-option persistence ───────────────────────────────────────────────────
// The "Boot options" fieldset is global (not per-game), so we store each control
// by id under one localStorage key and restore it on load. Checkboxes save their
// checked state, selects save their value. Runs at module load (the options screen
// is in the DOM from the start, just hidden), then re-saves whenever one changes.
const BOOT_OPTIONS_KEY = "psp-js:boot-options";
const BOOT_OPTION_CHECKBOXES = ["disable-audio-chk", "profiler-chk"];
const BOOT_OPTION_SELECTS = ["renderer-select", "resolution-select"];

function saveBootOptions(): void {
  const state: Record<string, boolean | string> = {};
  for (const id of BOOT_OPTION_CHECKBOXES) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) state[id] = el.checked;
  }
  for (const id of BOOT_OPTION_SELECTS) {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (el) state[id] = el.value;
  }
  try {
    localStorage.setItem(BOOT_OPTIONS_KEY, JSON.stringify(state));
  } catch { /* persistence best-effort */ }
}

function restoreBootOptions(): void {
  let state: Record<string, boolean | string>;
  try {
    const raw = localStorage.getItem(BOOT_OPTIONS_KEY);
    if (!raw) return;
    state = JSON.parse(raw) as Record<string, boolean | string>;
  } catch { return; /* missing or corrupt — keep the HTML defaults */ }

  for (const id of BOOT_OPTION_CHECKBOXES) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el && typeof state[id] === "boolean") el.checked = state[id];
  }
  for (const id of BOOT_OPTION_SELECTS) {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    // Only apply a stored value that still matches one of the options.
    if (el && typeof state[id] === "string" && [...el.options].some(o => o.value === state[id])) {
      el.value = state[id];
    }
  }
}

restoreBootOptions();
for (const id of [...BOOT_OPTION_CHECKBOXES, ...BOOT_OPTION_SELECTS]) {
  document.getElementById(id)?.addEventListener("change", saveBootOptions);
}

// ── Hash-based router ─────────────────────────────────────────────────────────
// Routes: #library (default), #game/<id> (options; deep-link boots),
// #details/<id> (details page; deep-links without booting), #play/<id>
// <id> is discId if available, else filename (sanitized).

let currentGameSlug = "";
/** Set by the game-select handler: true when the next options-screen load was
 *  requested as a details view (#details) rather than the boot screen (#game). */
let pendingDetailsView = false;

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

/** The details screen routes to #details when the selection asked for the details
 *  view (card click / #details deep-link), otherwise the #game boot screen. */
function gameOrDetailsRoute(slug: string): string {
  return pendingDetailsView ? `details/${slug}` : `game/${slug}`;
}

let inputHandler: InputHandler | null = null;
let emulator: PSPEmulator | null = null;
let renderer: FramebufferRenderer | null = null;
let geRenderer: WebGLGERenderer | null = null;
let debugPanel: DebugPanel | null = null;
let rafHandle: number = 0;
let ebootBytes: Uint8Array | null = null;
let mediaAbort: AbortController | null = null;
let pmfPlayer: PmfPlayer | null = null;
let lastIsoVolume: IsoVolume | null = null;
let lastIsoFile: File | null = null;
// True when the current game was opened via the options screen (gear), false when
// booted straight from the library. Decides where "← Back" returns to.
let optionsScreenReady = false;
let pendingDirFiles: Map<string, Uint8Array> | null = null;
let pendingStartDir: string | null = null;

/** Build the renderer for the current dropdown choice. Each renderer sizes the
 *  canvas backing store itself (WebGL to scale×, software to native), so the
 *  store stays correct when switching between them. Sets the module-level
 *  `renderer` (software) or `geRenderer` (WebGL); assumes both are already null. */
function setupRenderer(canvas: HTMLCanvasElement): void {
  if (isSoftwareRenderer()) {
    renderer = new FramebufferRenderer(canvas);
  } else {
    geRenderer = new WebGLGERenderer(canvas);
    geRenderer.setResolutionScale(resolutionScale());
    (window as unknown as { _dbgGeRenderer?: WebGLGERenderer })._dbgGeRenderer = geRenderer; // debug
  }
}

/** Wire the freshly-built WebGL renderer into the running GE. No-op for software
 *  (geRenderer null), GE draws fall back to the software rasterizer. */
function attachActiveRenderer(): void {
  if (!emulator || !geRenderer) return;
  emulator.hle.ensureGeProcessor().webglRenderer = geRenderer;
  geRenderer.setVRAM(emulator.bus.vramBuffer);
}

/** Switch the active renderer live, without rebooting the game. Runs from the
 *  dropdown's change handler (between frames, so never mid-present). The renderers
 *  keep pixels in different places (WebGL in FBOs, software in VRAM), so expect a
 *  couple of frames of stale content while the game redraws into the new target. */
function switchRenderer(): void {
  if (!emulator) return; // only meaningful while a game is running
  const canvas = document.getElementById("psp-canvas") as HTMLCanvasElement;
  geRenderer?.destroy();
  geRenderer = null;
  renderer?.destroy();
  renderer = null;
  // Detach from the GE before swapping; GE draws fall back to the software
  // rasterizer whenever webglRenderer is null.
  const ge = emulator.hle.geProcessor;
  if (ge) ge.webglRenderer = null;
  setupRenderer(canvas);
  attachActiveRenderer();
}

// ── Debug: ?homebrew=<dir> loads a served directory-homebrew from public/ ────
// Mirrors the library flow (loadCompanionFiles → disc0:/ + start dir) without
// the native directory picker, so scripted sessions can boot homebrew like Duke3D.
void (async () => {
  const hb = new URLSearchParams(location.search).get("homebrew");
  if (!hb) return;
  try {
    const manifest = await (await fetch(`${import.meta.env.BASE_URL}${hb}/_manifest.json`)).json() as string[];
    const dirFiles = new Map<string, Uint8Array>();
    let ebootBuf: Uint8Array<ArrayBuffer> | null = null;
    for (const rel of manifest) {
      const resp = await fetch(`${import.meta.env.BASE_URL}${hb}/${rel}`);
      if (!resp.ok) { log.warn(`?homebrew: skip ${rel} (HTTP ${resp.status})`); continue; }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      dirFiles.set(`disc0:/${rel}`, bytes);
      if (/(^|\/)EBOOT\.PBP$/i.test(rel)) ebootBuf = bytes;
    }
    if (!ebootBuf) throw new Error("no EBOOT.PBP in manifest");
    pendingDirFiles = dirFiles;
    pendingStartDir = "disc0:/";
    await handleEboot(new File([ebootBuf], "EBOOT.PBP"));
    document.getElementById("boot-btn")?.click();
  } catch (err) {
    log.error(`?homebrew= autoload failed: ${err}`);
  }
})();


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
bootBtn.addEventListener("click", () => bootGame());

// Live renderer switch: the options dropdown applies immediately while a game
// runs (no reboot). Before boot it's a no-op, setupRenderer reads the value then.
document.getElementById("renderer-select")?.addEventListener("change", () => switchRenderer());
// The options screen is hidden in-game, so the debug panel offers the same switch.
// It flips the dropdown (the source of truth) so the choice sticks across reboots.
document.getElementById("debug-panel")?.addEventListener("renderer-toggle", () => {
  const sel = document.getElementById("renderer-select") as HTMLSelectElement | null;
  if (sel) sel.value = sel.value === "software" ? "webgl" : "software";
  switchRenderer();
  // Programmatic value changes don't fire "change", so persist the flip directly.
  saveBootOptions();
});
// The draw-call scrubber re-renders one frame so its new limit shows immediately
// while the rAF loop is paused (doSingleFrame is a no-op when running).
document.getElementById("debug-panel")?.addEventListener("debug-rerender", () => {
  // Step twice: some games submit GE draws only every other displayed frame, so
  // a single step can land on an empty frame where the new limit has no effect.
  doSingleFrame();
  doSingleFrame();
});

function bootGame(): void {
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

  // WebGL draws GE primitives on the GPU; software rasterizes into VRAM and we
  // present VRAM bytes each frame. Switchable live via the dropdown (see below).
  setupRenderer(canvas);
  // <debug-panel> is a persistent custom element in the DOM; grab it and reset
  // its per-game state rather than constructing a new (unattached) instance.
  debugPanel = document.querySelector<DebugPanel>("debug-panel");
  debugPanel?.reset();

  emulator = new PSPEmulator();
  window._dbgEmu = emulator; // debug: expose for console inspection
  window._dbgLogger = Logger;  // debug: window._dbgLogger.minLevel = "debug"
  // debug: run+present N displayed frames synchronously (the preview/background tab
  // throttles rAF, so the play loop stalls; this drives runOneFrame directly).
  // framesPerStep>1 simulates a frame-skip batch (run that many PSP frames, draw the
  // last) so the skip path can be exercised without the rAF timer. Returns vblanks.
  // skipN>0 applies the fixed-skip render schedule (render 1 of every skipN+1) so the
  // integrated skip path can be exercised without the rAF timer.
  (window as unknown as { _dbgStep?: (n?: number, framesPerStep?: number, skipN?: number) => number })._dbgStep = (n = 1, framesPerStep = 1, skipN = 0) => {
    for (let i = 0; i < n; i++) runOneFrame(framesPerStep, skipN <= 0 || i % (skipN + 1) === 0);
    return emulator ? emulator.hle.vblankCount : -1;
  };
  window._dbgPauseAt = (frame: number) => { _pauseAtFrame = frame > 0 ? Math.floor(frame) : 0; }; // debug: auto-pause at a frame
  window._dbgPerf = { // debug: per-frame CPU-vs-present profiler
    start: () => { _perfEnabled = true; _perfFrames.clear(); },
    stop:  () => { _perfEnabled = false; },
    report: (from, to) => dbgPerfReport(from, to),
  };
  window._dbgCpuProf = { // debug: interpreter instruction-mix + hot-PC profiler
    start: (sampleEvery = 64) => { if (emulator) emulator.cpu.profiler = new CpuProfiler(sampleEvery); },
    stop:  () => { if (emulator) emulator.cpu.profiler = null; },
    report: (topN = 20) => {
      const p = emulator?.cpu.profiler;
      if (p) p.report(topN);
      else console.log("[CPUPROF] not started — call _dbgCpuProf.start() first");
    },
  };
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
      emulator.hle.onSavedataListSelect = (action, gameTitle, slots) => list.show(action, gameTitle, slots);
    }
  });

  void (async () => {
    // Register ISO filesystem for lazy file access by HLE
    if (lastIsoVolume && lastIsoFile) {
      await registerIsoFileSystem(emulator!.hle.pspFs, emulator!.hle.fileData, lastIsoFile);
    }

    // Register directory files loaded via "Open Directory" or PBP companion files.
    // "Open Directory" gives bare relative keys ("DUKE3D.GRP", "mini/x.pat"); the
    // game opens them as "disc0:/duke3d.grp", so register under disc0:/ or they
    // won't be found and the game jumps through uninitialized pointers (Duke3D
    // crashed this way). Keys that already carry a device prefix pass through.
    if (pendingDirFiles) {
      const sample: string[] = [];
      for (const [key, val] of pendingDirFiles) {
        const hasDevice = /^[a-z0-9_]+:/i.test(key);
        const finalKey = hasDevice ? key : `disc0:/${key}`;
        emulator!.hle.fileData.set(finalKey, val);
        if (sample.length < 8) sample.push(finalKey);
      }
      log.info(`Registered ${pendingDirFiles.size} directory files for HLE; sample keys: ${sample.join(", ")}`);
    }

    // Set starting directory for homebrew PBP (ms0:/PSP/GAME/<dir>)
    if (pendingStartDir) {
      emulator!.hle.pspFs.setStartingDirectory(pendingStartDir);
      log.info(`Starting directory: ${pendingStartDir}`);
    }

    // Register any PSP flash0 font files the user loaded
    for (const [key, val] of flash0Fonts) {
      emulator!.hle.fileData.set(key, val);
    }

    if (!isAudioDisabled()) {
      // Unlock the Web Audio engine before starting the ELF so the AudioWorklet
      // is ready before the game's audio thread calls sceAudioOutputBlocking.
      // We are inside a click handler so AudioContext creation is allowed.
      try {
        await emulator!.hle.audioEngine.init();
        emulator!.hle.audioEngine.setSpeed(_speed); // apply any pre-set speed
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
      // argv[0] = the exec path. Homebrew PBPs sit at disc0:/EBOOT.PBP and the
      // game derives its base dir by stripping this; passing the ISO default
      // (PSP_GAME/SYSDIR/EBOOT.BIN) leaves it with a prefix-less "/" base, so it
      // builds paths like "/duke3d.grp" with no drive — a drive-prefix parse
      // then returns -1 and the game writes buffer[-1], smashing a saved $ra.
      const bootPath = isPbp(ebootBytes!) ? "disc0:/EBOOT.PBP" : "disc0:/PSP_GAME/SYSDIR/EBOOT.BIN";
      await emulator!.loadElfBinary(ebootBytes!, bootPath);
      debugPanel?.markEmulationStarted();
    } catch (err) {
      showError(`Failed to load EBOOT.BIN: ${String(err)}`, err);
      teardownGameplay();
      exitGameplayView();
      return;
    }

    await emulator!.initWorker();

    // Attach WebGL renderer to the GE processor for GPU-accelerated rendering
    attachActiveRenderer();

    startRafLoop();
  })();
}
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
  teardownGameplay();
  if (optionsScreenReady) {
    // The game screen is still rendered, so return to it as the details page
    // (#details, which won't re-boot on refresh) rather than the boot screen.
    exitGameplayView();
    navTo(`details/${currentGameSlug}`);
  } else {
    // Booted straight from the library → go back to the library.
    exitGameplayView();
    showFilePicker();
    setStatus("");
    navTo("library");
  }
});

// ── Canvas scale buttons ─────────────────────────────────────────────────────
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-scale]")) {
  btn.addEventListener("click", () => {
    const scale = Number(btn.dataset.scale);
    const primary = document.querySelector<HTMLElement>(".gameplay-primary");
    if (primary) primary.style.setProperty("--psp-scale", String(scale));
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-scale]")) {
      b.classList.toggle("seg__btn--active", b === btn);
    }
  });
}

// ── Fullscreen button ─────────────────────────────────────────────────────────
// Fullscreens the game screen (canvas scales to fit with letterboxing via CSS).
document.getElementById("fullscreen-btn")?.addEventListener("click", () => {
  const screen = document.querySelector<HTMLElement>(".gameplay-screen");
  if (!document.fullscreenElement) void screen?.requestFullscreen?.();
  else void document.exitFullscreen?.();
});

// ── Debug drawer toggle ───────────────────────────────────────────────────────
// Slides the debug drawer in/out over the screen. Open by default.
function setDebugOpen(open: boolean): void {
  const panel = document.getElementById("debug-panel");
  const btn   = document.getElementById("toggle-debug-btn");
  if (!panel || !btn) return;
  panel.classList.toggle("debug-sidebar--open", open);
  btn.textContent = open ? "Hide debug" : "Debug ▸";
  btn.setAttribute("aria-pressed", String(open));
}
document.getElementById("toggle-debug-btn")?.addEventListener("click", () => {
  const isOpen = document.getElementById("debug-panel")?.classList.contains("debug-sidebar--open");
  setDebugOpen(!isOpen);
});
// The <debug-panel> close button lives in its shadow DOM and bubbles this event.
document.getElementById("debug-panel")?.addEventListener("close-debug", () => setDebugOpen(false));
// Open by default.
setDebugOpen(true);

// ── Emulation speed buttons ───────────────────────────────────────────────────
// Run N PSP frames per displayed frame (presenting once). Only helps games with
// CPU headroom; audio plays in real time so it distorts above 1×.
let _speed = 1;
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-speed]")) {
  btn.addEventListener("click", () => {
    _speed = Number(btn.dataset.speed) || 1;
    emulator?.hle.audioEngine.setSpeed(_speed); // fast-forward audio in step
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-speed]")) {
      b.classList.toggle("seg__btn--active", b === btn);
    }
  });
}

// ── Frame-skip buttons ────────────────────────────────────────────────────────
// Off renders every frame. Auto lets the accumulator decide how many frames to
// skip to hold 1× real time. 1/2/3 always skip that many between renders. Unlike
// the speed buttons this keeps audio at 1× — it is not fast-forward.
let _frameSkipMode: FrameSkipMode = FRAMESKIP_AUTO; // default: Auto (per-session)
let _lastSkipCount = 0;
let _displayedFrames = 0; // counts displayed-frame ticks; drives the fixed-skip render schedule
let _renderedLastFrame = true; // Auto: don't skip two renders in a row
let _lastFrameMs = 0; // cost of the last RENDERED frame; Auto uses it to detect render-bound
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-frameskip]")) {
  btn.addEventListener("click", () => {
    const v = btn.dataset.frameskip;
    _frameSkipMode = v === "auto" ? FRAMESKIP_AUTO : Number(v) || FRAMESKIP_OFF;
    _displayedFrames = 0; _renderedLastFrame = true; // reset the render schedule
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-frameskip]")) {
      b.classList.toggle("seg__btn--active", b === btn);
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
  } else if (route.startsWith("game/") || route.startsWith("details/")) {
    // Back to the options/details screen from gameplay: stop the emulator. If the
    // game was booted straight from the library (no options screen), fall back to it.
    if (emulator) {
      teardownGameplay();
      if (optionsScreenReady) {
        exitGameplayView();
      } else {
        exitGameplayView();
        showFilePicker();
        navTo("library", true);
      }
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
  geRenderer?.destroy();
  geRenderer = null;
  renderer?.destroy();
  renderer = null;
  debugPanel?.reset();
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
// Auto-pause target: when _frameCount reaches this, the play loop pauses and
// stops scheduling rAF. 0 = disabled. Set via ?pauseAt=N (read at boot) or the
// console helper window._dbgPauseAt(n). For debugging/measurement.
let _pauseAtFrame = 0;
// ── Frame profiler (debug) ───────────────────────────────────────────────────
// Records, per displayed frame, the CPU time (the runFrame batch = interpreter +
// inline GE) and the present time (GPU submit). Enable with ?perf (or
// _dbgPerf.start()). Cheap: two extra performance.now() reads per frame. The
// report splits the full frame period into CPU vs present vs idle so you can see
// where the ms actually go.
// cpuMs is the whole runFrame (interpreter + inline GE); geMs is the inline-GE
// slice of it (hle.geTimeMs delta), so interpreter = cpuMs - geMs.
interface PerfFrame { frame: number; startTs: number; cpuMs: number; geMs: number; presentMs: number }

/** Ring buffer of per-frame profiler samples backed by parallel typed arrays:
 *  O(1) push with zero allocation (no object per frame), packed and cache-
 *  friendly. Capacity is rounded up to a power of two so the wrap is a bitmask,
 *  not a modulo. Keeps the most recent samples, evicting the oldest, so recording
 *  runs indefinitely with fixed memory. */
class PerfRing {
  readonly #frame: Int32Array;
  readonly #startTs: Float64Array;
  readonly #cpuMs: Float64Array;
  readonly #geMs: Float64Array;
  readonly #presentMs: Float64Array;
  readonly #cap: number;
  readonly #mask: number;
  #head = 0; // next write index
  #len = 0;  // samples held, capped at #cap
  constructor(minCap: number) {
    let cap = 1;
    while (cap < minCap) cap <<= 1; // round up to a power of two
    this.#cap = cap;
    this.#mask = cap - 1;
    this.#frame = new Int32Array(cap);
    this.#startTs = new Float64Array(cap);
    this.#cpuMs = new Float64Array(cap);
    this.#geMs = new Float64Array(cap);
    this.#presentMs = new Float64Array(cap);
  }
  get length(): number { return this.#len; }
  push(frame: number, startTs: number, cpuMs: number, geMs: number, presentMs: number): void {
    const i = this.#head;
    this.#frame[i] = frame;
    this.#startTs[i] = startTs;
    this.#cpuMs[i] = cpuMs;
    this.#geMs[i] = geMs;
    this.#presentMs[i] = presentMs;
    this.#head = (i + 1) & this.#mask;
    if (this.#len < this.#cap) this.#len++;
  }
  clear(): void { this.#head = 0; this.#len = 0; }
  /** Samples oldest-to-newest. Allocates objects, so call only for the occasional
   *  report — never on the per-frame push path. */
  toArray(): PerfFrame[] {
    const out: PerfFrame[] = new Array(this.#len);
    const start = (this.#head - this.#len + this.#cap) & this.#mask;
    for (let i = 0; i < this.#len; i++) {
      const j = (start + i) & this.#mask;
      out[i] = { frame: this.#frame[j]!, startTs: this.#startTs[j]!, cpuMs: this.#cpuMs[j]!, geMs: this.#geMs[j]!, presentMs: this.#presentMs[j]! };
    }
    return out;
  }
}

let _perfEnabled = false;
// Keep the most recent ~PERF_RING_CAP frames (~34s at 60fps; rounded up to a
// power of two internally); older ones are evicted so recording never stops and
// never grows. The auto-report range (11..pauseAt) is tiny, so it's always still
// in the ring when it fires.
const PERF_RING_CAP = 2048;
const _perfFrames = new PerfRing(PERF_RING_CAP);
const FRAME_INTERVAL = 1000 / 60; // ~16.67ms for 60fps

// Cached perf-HUD element refs (looked up once per boot, not per frame).
let _hudFps: HTMLElement | null = null;
let _hudFrame: HTMLElement | null = null;
let _hudTid: HTMLElement | null = null;
let _hudPc: HTMLElement | null = null;
let _hudSkip: HTMLElement | null = null;
let _lastHudUpdate = 0;
const HUD_UPDATE_MS = 200;

function setPaused(paused: boolean): void {
  _paused = paused;
  const pauseBtn = document.getElementById("pause-btn");
  const stepBtn = document.getElementById("step-btn") as HTMLButtonElement | null;
  if (pauseBtn) pauseBtn.textContent = _paused ? "Resume" : "Pause";
  if (stepBtn) stepBtn.disabled = !_paused;
  if (!_paused && rafHandle === 0) {
    _lastFrameTime = performance.now();
    rafHandle = requestAnimationFrame(frameLoop);
  }
}

function togglePause(): void {
  setPaused(!_paused);
}

function doSingleFrame(): void {
  if (!emulator || !_paused) return;
  runOneFrame();
}

/** Run one displayed frame (shared between frame loop and step).
 *  framesToRun > 1 means the host fell behind: run that many PSP frames, draw only
 *  the last. render=false (fixed-skip non-render tick) advances game time but draws
 *  nothing and skips the present, so the last presented frame stays on screen. */
function runOneFrame(framesToRun = 1, render = true): void {
  if (!emulator) return;
  // Auto-pause once we've run _pauseAtFrame frames (debug/measurement). Checked
  // before running more, so exactly _pauseAtFrame frames execute, then the loop
  // stops scheduling rAF. Skipped while already paused so single-stepping works.
  if (_pauseAtFrame > 0 && _frameCount >= _pauseAtFrame && !_paused) {
    setPaused(true);
    setStatus(`Auto-paused at frame ${_frameCount}.`);
    if (_perfEnabled) dbgPerfReport(11, _pauseAtFrame - 1);
    return;
  }
  _frameCount++;
  if (_frameCount >= 1_000_000_000) _frameCount = 0;

  let cpuMs = 0;
  let geMs = 0;
  let presentMs = 0;
  const frameStart = performance.now();
  // Inline-GE time is tracked in hle.geTimeMs (the _scanGeListHeadless wrap); the
  // delta over this frame is the GE slice of cpuMs, so interpreter = cpuMs - geMs.
  const geBefore = emulator.hle.geTimeMs;
  try {
    // framesToRun is the frame-skip batch: run that many PSP frames but draw only
    // the last (skipDraw suppresses the GE draws on the earlier ones). _speed nests
    // inside it for 2×/4× fast-forward. Stop early if the game halts mid-batch.
    for (let f = 0; f < framesToRun; f++) {
      const isLast = f === framesToRun - 1;
      const ge = emulator.hle.geProcessor;
      // Skip the GE draws on every frame we won't present (all of them on a
      // non-render tick; all but the last of a catch-up batch).
      if (ge) ge.skipDraw = !render || !isLast;
      // Invalidate textures modified in RAM since last frame. Run each iteration so
      // VFB decimation tracking stays correct across skipped frames.
      geRenderer?.onFrameStart();
      for (let i = 0; i < _speed; i++) {
        emulator.runFrame();
        if (emulator.halted) break;
      }
      if (emulator.halted) break;
    }
    const ge = emulator.hle.geProcessor;
    if (ge) ge.skipDraw = false; // always clear before present / next frame
    cpuMs = performance.now() - frameStart;
    geMs = emulator.hle.geTimeMs - geBefore;
  } catch (err) {
    const ge = emulator.hle.geProcessor;
    if (ge) ge.skipDraw = false; // never leave the screen stuck on a skipped frame
    stopRafLoop();
    if (emulator && debugPanel) debugPanel.dumpStubsToConsole(emulator);
    showError(`CPU error: ${String(err)}`, err);
    return;
  }
  // HUD "Skip": the configured count in fixed mode, else 1 when Auto dropped this draw.
  _lastSkipCount = _frameSkipMode > 0 ? _frameSkipMode : (render ? 0 : 1);

  const hle = emulator.hle;
  const fbAddr = hle.framebufAddr !== 0 ? hle.framebufAddr : hle.geFbAddr;

  // Present: WebGL GE renderer → screen (GPU-accelerated path). Skipped on a
  // non-render frame-skip tick — the game advanced but we leave the last frame up.
  const presentStart = performance.now();
  if (render && geRenderer) {
    geRenderer.setDisplayFramebuf(fbAddr, hle.framebufWidth, hle.framebufFormat);
    // With frame-skip on, the game flips the display to the back buffer at frame end,
    // so the current display address often points at a buffer whose draw we skipped
    // (stale or black). Present the buffer we actually drew this tick instead. When
    // skip is Off every buffer is drawn every frame, so the plain display addr is fine.
    geRenderer.presentToScreen(_frameSkipMode !== FRAMESKIP_OFF);
    // Profiler: stall on the GPU so present/GPU captures the host-GPU render time
    // (WebGL draws are async, otherwise hidden in the idle/vsync gap).
    if (_perfEnabled) geRenderer.finishGpu();
  } else if (render && fbAddr !== 0 && renderer) {
    // Fallback: upload VRAM bytes as texture
    renderer.render(emulator.bus.vramBuffer, fbAddr, hle.framebufWidth, hle.framebufFormat);
  }
  presentMs = performance.now() - presentStart;
  // Track the cost of a RENDERED frame so Auto can tell when rendering is the
  // bottleneck (interpreter-only frames are cheaper and shouldn't trigger a skip).
  if (render) _lastFrameMs = cpuMs + presentMs;
  if (_perfEnabled) {
    _perfFrames.push(_frameCount, frameStart, cpuMs, geMs, presentMs);
  }
  // Update the perf HUD text at ~5Hz, not every frame — the counters are read by
  // a human, so 60 text reflows/sec is wasted layout work. Force an update when
  // paused so single-stepping shows fresh values immediately.
  const hudNow = performance.now();
  if (_paused || hudNow - _lastHudUpdate >= HUD_UPDATE_MS) {
    _lastHudUpdate = hudNow;
    if (_hudFps)   _hudFps.textContent   = String(_fpsValue);
    if (_hudFrame) _hudFrame.textContent = String(_frameCount);
    if (_hudTid)   _hudTid.textContent   = String(emulator.hle.currentThreadId);
    if (_hudPc)    _hudPc.textContent    = emulator.cpu.regs.pc.toString(16);
    if (_hudSkip)  _hudSkip.textContent  = String(_lastSkipCount);
  }

  debugPanel?.tick(emulator, cpuMs, presentMs);

  if (emulator.halted) {
    stopRafLoop();
    if (debugPanel) debugPanel.dumpStubsToConsole(emulator);
    setStatus("Game exited.");
  }
}

/** Print a per-frame profiler summary for displayed frames [from, to]. Splits the
 *  full frame period into CPU (runFrame = interpreter + inline GE), present (GPU
 *  submit), and idle (vsync/overhead). A frame's period needs the next frame's
 *  start, so the last frame in range contributes to CPU/present but not the period
 *  average. Enable recording first via ?perf or _dbgPerf.start(). */
function dbgPerfReport(from = 11, to = Number.MAX_SAFE_INTEGER): void {
  const byFrame = new Map(_perfFrames.toArray().map((r): [number, PerfFrame] => [r.frame, r]));
  const rows: { frame: number; cpuMs: number; geMs: number; interpMs: number; presentMs: number; periodMs: number }[] = [];
  for (let n = from; n <= to; n++) {
    const r = byFrame.get(n); if (!r) continue;
    const next = byFrame.get(n + 1);
    rows.push({
      frame: n, cpuMs: r.cpuMs, geMs: r.geMs, interpMs: Math.max(0, r.cpuMs - r.geMs),
      presentMs: r.presentMs, periodMs: next ? next.startTs - r.startTs : NaN,
    });
  }
  if (rows.length === 0) {
    console.log(`[PERF] no recorded frames in ${from}..${to} — enable with ?perf or _dbgPerf.start()`);
    return;
  }
  const withPeriod = rows.filter(r => !Number.isNaN(r.periodMs));
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const cpu = mean(rows.map(r => r.cpuMs));
  const ge = mean(rows.map(r => r.geMs));
  const interp = mean(rows.map(r => r.interpMs));
  const present = mean(rows.map(r => r.presentMs));
  const period = mean(withPeriod.map(r => r.periodMs));
  const idle = period - cpu - present;
  const pct = (x: number) => (Number.isFinite(period) && period > 0 ? `${(100 * x / period).toFixed(0)}%` : "?");
  console.log(`[PERF] displayed frames ${rows[0]!.frame}-${rows[rows.length - 1]!.frame} (${rows.length} frames, ${withPeriod.length} with period)`);
  console.log(`[PERF]   CPU runFrame: ${cpu.toFixed(1)} ms (${pct(cpu)})`);
  console.log(`[PERF]     interpreter: ${interp.toFixed(1)} ms (${pct(interp)})  = MIPS game code`);
  console.log(`[PERF]     inline GE:   ${ge.toFixed(1)} ms (${pct(ge)})  = GE cmds + vertex xform + GL submit`);
  console.log(`[PERF]   present/GPU:  ${present.toFixed(1)} ms (${pct(present)})  = host GPU`);
  console.log(`[PERF]   idle/vsync:   ${idle.toFixed(1)} ms (${pct(idle)})`);
  console.log(`[PERF]   frame total:  ${period.toFixed(1)} ms  ->  ${(1000 / period).toFixed(1)} fps`);
  console.table(rows.map(r => ({
    frame: r.frame,
    interpMs: +r.interpMs.toFixed(1), geMs: +r.geMs.toFixed(1), cpuMs: +r.cpuMs.toFixed(1),
    presentMs: +r.presentMs.toFixed(1), periodMs: Number.isNaN(r.periodMs) ? null : +r.periodMs.toFixed(1),
  })));
}

function startRafLoop(): void {
  if (rafHandle !== 0) return;

  // Wire pause/step buttons
  document.getElementById("pause-btn")?.addEventListener("click", togglePause);
  document.getElementById("step-btn")?.addEventListener("click", doSingleFrame);

  // Cache HUD refs so the frame loop doesn't query the DOM every frame
  _hudFps   = document.getElementById("hud-fps");
  _hudFrame = document.getElementById("hud-frame");
  _hudTid   = document.getElementById("hud-tid");
  _hudPc    = document.getElementById("hud-pc");
  _hudSkip  = document.getElementById("hud-skip");
  _lastHudUpdate = 0;

  _frameCount = 0;
  _fpsLastTime = performance.now();
  _lastFrameTime = performance.now();
  _displayedFrames = 0;
  _renderedLastFrame = true;
  _lastSkipCount = 0;
  _fpsFrames = 0;
  _fpsValue = 0;
  _paused = false;
  // Auto-pause target from ?pauseAt=N (a live _dbgPauseAt() call after boot wins).
  _pauseAtFrame = 0;
  const pauseAt = Number(new URLSearchParams(location.search).get("pauseAt"));
  if (Number.isFinite(pauseAt) && pauseAt > 0) _pauseAtFrame = Math.floor(pauseAt);
  // Frame profiler: the Profiler boot option (or ?perf) records per-frame CPU vs
  // present time, shown live in the debug panel and auto-printed (frames
  // 11..pauseAt-1) when the auto-pause fires. Reset the buffer each boot.
  _perfFrames.clear();
  _perfEnabled = isProfilerEnabled() || new URLSearchParams(location.search).has("perf");
  if (debugPanel) debugPanel.profilerEnabled = _perfEnabled;

  rafHandle = requestAnimationFrame(frameLoop);
}

function frameLoop(): void {
  if (!emulator || _paused) return;

  const now = performance.now();

  // Throttle to ~60fps in EVERY mode (also caps high-refresh displays). The game
  // advances exactly one PSP frame per displayed frame regardless of frame-skip, so
  // frame-skip never changes game speed — it only changes how often we render.
  const elapsed = now - _lastFrameTime;
  if (elapsed < FRAME_INTERVAL) {
    rafHandle = requestAnimationFrame(frameLoop);
    return;
  }
  _lastFrameTime = now - (elapsed % FRAME_INTERVAL);

  // Decide whether to draw this frame. The game runs one frame either way; skipping
  // a draw just makes the tick cheaper (helps a render-bound game stay near 60fps).
  let render = true;
  if (_frameSkipMode > 0) {
    // Fixed N: render 1 of every N+1 displayed frames.
    render = (_displayedFrames % (_frameSkipMode + 1)) === 0;
  } else if (_frameSkipMode === FRAMESKIP_AUTO) {
    // Auto: when the last drawn frame overran the 60fps budget we're render-bound,
    // so drop this draw to recover — but never two in a row, so the screen still
    // updates at least every other frame.
    render = !(_lastFrameMs > FRAME_INTERVAL && _renderedLastFrame);
  }
  _displayedFrames++;
  _renderedLastFrame = render;

  _fpsFrames++;
  if (now - _fpsLastTime >= 1000) {
    _fpsValue = _fpsFrames;
    _fpsFrames = 0;
    _fpsLastTime = now;
  }

  runOneFrame(1, render);

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

/** Walk the ISO tree and register lazy file readers for disc0:/ paths.
 *  Files are read on-demand from the ISO File using slice(), avoiding loading the entire ISO into memory. */
async function registerIsoFileSystem(
  pspFs: PspFileSystem,
  fileData: Map<string, Uint8Array>,
  isoFile: File,
): Promise<void> {
  fileData.clear();
  // Load the whole image once and serve files as views into it. This is
  // actually less memory than slicing each file out, and it lets raw
  // "sce_lbn<N>_size<M>" opens (GTA's disc catalog reader) work — those need
  // synchronous sector access that a File can't provide.
  const buffer = await isoFile.arrayBuffer();
  const volume = parseIso(buffer);
  function walk(entry: IsoFile, prefix: string): void {
    if (entry.isDirectory) {
      pspFs.setDirExtent(`disc0:${prefix}/${entry.name}`, entry.lba, entry.size);
      for (const child of entry.children ?? []) {
        walk(child, `${prefix}/${entry.name}`);
      }
    } else {
      const path = `disc0:${prefix}/${entry.name}`;
      try {
        fileData.set(path, readFile(buffer, entry));
        pspFs.setFileSector(path, entry.lba);
      } catch {
        // Skip files that can't be read (may be beyond file bounds)
      }
    }
  }
  for (const child of volume.root.children ?? []) {
    walk(child, "");
  }
  const bytes = new Uint8Array(buffer);
  pspFs.setDiscReader((lbn, size) => {
    const start = lbn * 2048;
    if (start < 0 || start >= bytes.length) return null;
    return bytes.subarray(start, Math.min(start + size, bytes.length));
  });
  log.info(`Registered ${fileData.size} ISO files for HLE`);
}

interface GameMetadata {
  title: string;
  discId: string;
  region: string;
  version: string;
  parentalLevel: number;
  category: string;
  saveTitle: string;
  saveDetail: string;
  iconUrl: string | null;
  bgUrl: string | null;
  logoUrl: string | null;
}

/** Extract game metadata (title, icons, etc.) from an ISO File using lazy reads. */
async function extractMetadataFromIso(isoFile: File, volume: IsoVolume, pspGame: IsoFile): Promise<GameMetadata> {
  const { parseSfo, extractGameInfo } = await import("../iso/sfo.js");
  const meta: GameMetadata = {
    title: volume.volumeId, discId: "", region: "", version: "",
    parentalLevel: 0, category: "", saveTitle: "", saveDetail: "",
    iconUrl: null, bgUrl: null, logoUrl: null,
  };

  const sfoEntry = pspGame.children?.find(f => !f.isDirectory && f.name.toUpperCase() === "PARAM.SFO");
  if (sfoEntry) {
    try {
      const sfoData = await readFileFromIso(isoFile, sfoEntry);
      const parsed = parseSfo(sfoData.slice().buffer);
      const info = extractGameInfo(parsed);
      meta.title = info.title || meta.title;
      meta.discId = info.discId;
      meta.region = info.region;
      meta.version = info.version;
      meta.parentalLevel = info.parentalLevel;
      meta.category = info.category;
      meta.saveTitle = info.saveTitle;
      meta.saveDetail = info.saveDetail;
    } catch { /* non-fatal */ }
  }

  meta.iconUrl = await readImageFromIso(isoFile, pspGame, "ICON0.PNG");
  meta.bgUrl = await readImageFromIso(isoFile, pspGame, "PIC1.PNG");
  meta.logoUrl = await readImageFromIso(isoFile, pspGame, "PIC0.PNG");

  return meta;
}

async function readImageFromIso(isoFile: File, dir: IsoFile, name: string): Promise<string | null> {
  const entry = dir.children?.find(f => !f.isDirectory && f.name.toUpperCase() === name);
  if (!entry) return null;
  try {
    const data = await readFileFromIso(isoFile, entry);
    return URL.createObjectURL(new Blob([data.slice().buffer], { type: "image/png" }));
  } catch {
    return null;
  }
}

/** Read all files from a directory for HLE filesystem registration.
 *  Registers under the given device prefix (e.g. "ms0:/PSP/GAME/Duke3D"). */
async function loadCompanionFiles(
  dir: FileSystemDirectoryHandle,
  devicePrefix: string,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  async function walk(handle: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const entry of handle.values()) {
      if (entry.kind === "file") {
        try {
          const fh = entry as FileSystemFileHandle;
          const file = await fh.getFile();
          const buf = await file.arrayBuffer();
          files.set(`${prefix}/${entry.name}`, new Uint8Array(buf));
        } catch { /* skip unreadable files */ }
      } else if (entry.kind === "directory") {
        try {
          await walk(entry as FileSystemDirectoryHandle, `${prefix}/${entry.name}`);
        } catch { /* skip unreadable dirs */ }
      }
    }
  }

  await walk(dir, devicePrefix);
  return files;
}

/** Build an object URL for a PBP image section (icon/logo/background). */
function pbpImageUrl(bytes: Uint8Array | null | undefined): string | undefined {
  return bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })) : undefined;
}

/** Decode and play a game's preview media on the details screen: the animated
 *  PMF icon (video) plus AT3 audio. Shared by the ISO and PBP/homebrew paths.
 *  A stale run is cancelled via the shared mediaAbort controller. */
function playGameMedia(pmfData?: Uint8Array, at3Data?: Uint8Array): void {
  mediaAbort?.abort();
  const abort = new AbortController();
  mediaAbort = abort;

  void (async () => {
    if (pmfData) {
      setMediaLoading(true);
      try {
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

      if (!at3Data && !isAudioDisabled()) {
        try {
          const audioUrl = await transcodePmfAudio(pmfData);
          if (abort.signal.aborted) { URL.revokeObjectURL(audioUrl); return; }
          playGameAudio(audioUrl);
          // Lock the video to the audio clock so they don't drift / loop apart.
          pmfPlayer?.setClock(gameAudioTimeUs);
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

// ── ISO loading ───────────────────────────────────────────────────────────────
async function handleIso(file: File, parentDir?: FileSystemDirectoryHandle, autoBoot = false, detailsView = false): Promise<void> {
  pendingDetailsView = detailsView;
  clearError();
  clearGameVideo();
  clearGameAudio();
  unlockAudio(); // unlock within user gesture so later async play() works
  pendingDirFiles = null;
  setStatus(`Reading ${file.name}…`);

  // Free previous ISO data
  lastIsoVolume = null;
  lastIsoFile = null;

  // PBP/EBOOT files are not ISOs — treat as direct EBOOT with companion files.
  // PPSSPP mounts the game directory as the device root (umd0:/), so /file.grp
  // resolves to the game's directory. We register files under disc0:/ to match,
  // since that's the default device and the starting directory.
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (ext === ".pbp" || ext === ".bin" || ext === ".elf") {
    if (parentDir) {
      pendingDirFiles = await loadCompanionFiles(parentDir, "disc0:");
      pendingStartDir = "disc0:/";
    }
    await handleEboot(file, autoBoot, detailsView);
    return;
  }

  // Parse ISO structure using lazy reads (only directory metadata, not file content).
  // This avoids loading the entire ISO into memory (critical for 1+ GB games).
  let volume: IsoVolume;
  try {
    volume = await parseIsoFromFile(file);
  } catch (err) {
    showError(`Not a valid PSP ISO: ${String(err)}`, err);
    setStatus("");
    return;
  }
  lastIsoVolume = volume;
  lastIsoFile = file;

  const pspGame = volume.root.children?.find(
    (f) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME"
  );

  if (!pspGame) {
    showError("No PSP_GAME directory found — this may not be a PSP disc image.");
    setStatus("");
    return;
  }

  // Read only EBOOT.BIN (typically ~10-50MB, not the whole ISO)
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
        ebootBytes = await readFileFromIso(file, ebootEntry);
        log.info(`EBOOT.BIN extracted: ${ebootBytes.byteLength} bytes`);
      } catch (err) {
        log.warn(`Could not read EBOOT.BIN: ${err}`);
      }
    }
  }

  // Read PARAM.SFO + icons for metadata (small files)
  const meta = await extractMetadataFromIso(file, volume, pspGame);

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

  currentGameSlug = gameSlug(gameInfo.discId, file.name);

  // Instant boot: skip the options screen and the icon/audio preview, go straight
  // into the game. The ISO filesystem + EBOOT are already loaded above.
  if (autoBoot) {
    optionsScreenReady = false;
    // The options screen (and its preview images) is skipped, so the metadata's
    // icon/bg/logo object URLs are never shown; revoke them so they don't leak.
    for (const u of [meta.iconUrl, meta.bgUrl, meta.logoUrl]) {
      if (u?.startsWith("blob:")) URL.revokeObjectURL(u);
    }
    setStatus(`Booting ${gameInfo.title}…`);
    bootGame();
    return;
  }

  // Show options screen with static assets
  optionsScreenReady = true;
  showGameView(gameInfo, meta.iconUrl ?? undefined, meta.bgUrl ?? undefined, meta.logoUrl ?? undefined);
  showFileTree(volume.root);
  setStatus(`Loaded: ${gameInfo.title}${gameInfo.discId ? ` · ${gameInfo.discId}` : ""}`);
  navTo(gameOrDetailsRoute(currentGameSlug));

  // Read media files on demand from ISO (small files, read lazily)
  const pmfData = pmfEntry ? await readFileFromIso(file, pmfEntry) : undefined;
  const at3Data = at3Entry ? await readFileFromIso(file, at3Entry) : undefined;
  playGameMedia(pmfData, at3Data);
}

// ── Directory loading ─────────────────────────────────────────────────────────
async function handleDirectory(files: FileList): Promise<void> {
  pendingDetailsView = false; // directory load always opens the boot/options screen
  clearError();
  clearGameVideo();
  clearGameAudio();
  unlockAudio();
  lastIsoFile = null;
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
  // Homebrew opens files relative to disc0:/ (where we register the dir below).
  pendingStartDir = "disc0:/";

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
async function handleEboot(file: File, autoBoot = false, detailsView = false): Promise<void> {
  pendingDetailsView = detailsView;
  clearError();
  clearGameVideo();
  clearGameAudio();
  unlockAudio();
  lastIsoFile = null;
  lastIsoVolume = null;
  // Don't clear pendingDirFiles — handleIso may have set companion files before calling us
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

  let gameInfo = {
    title: file.name,
    discId: "",
    category: "",
    version: "",
    region: "",
    parentalLevel: 0,
    saveTitle: "",
    saveDetail: ""
  };
  // PBP games carry their PARAM.SFO and preview media (icon/pic/PMF/audio) inside
  // the container; read them so homebrew shows its real title and media instead
  // of the filename and a placeholder.
  let pbp: PbpContents | null = null;
  if (isPbp(ebootBytes)) {
    try {
      pbp = parsePbp(ebootBytes);
      if (pbp.paramSfo) gameInfo = extractGameInfo(parseSfo(pbp.paramSfo.slice().buffer as ArrayBuffer));
    } catch { /* keep the filename fallback */ }
  }

  currentGameSlug = gameSlug(gameInfo.discId, file.name);

  if (autoBoot) {
    optionsScreenReady = false;
    setStatus(`Booting ${gameInfo.title}…`);
    bootGame();
    return;
  }

  optionsScreenReady = true;
  showGameView(gameInfo, pbpImageUrl(pbp?.icon0), pbpImageUrl(pbp?.pic1), pbpImageUrl(pbp?.pic0));
  playGameMedia(pbp?.icon1Pmf ?? undefined, pbp?.snd0 ?? undefined);
  setStatus(`Loaded: ${gameInfo.title}${gameInfo.discId ? ` · ${gameInfo.discId}` : ""}`);
  navTo(gameOrDetailsRoute(currentGameSlug));
}
