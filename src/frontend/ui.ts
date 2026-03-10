import type { IsoFile } from "../iso/iso9660.js";
import type { GameInfo } from "../iso/sfo.js";

const dropZoneEl    = document.getElementById("drop-zone")     as HTMLElement;
const gameViewEl    = document.getElementById("game-view")      as HTMLElement;
const errorBanner   = document.getElementById("error-banner")   as HTMLElement;
const errorMsg      = document.getElementById("error-message")!;
const gameplayViewEl = document.getElementById("gameplay-view") as HTMLElement;
const gameplayHudEl  = document.getElementById("gameplay-hud")  as HTMLElement;

export function setStatus(message: string): void {
  document.getElementById("status-bar")!.textContent = message;
}

export function showError(message: string): void {
  errorMsg.textContent = message;
  errorBanner.classList.add("visible");
}

export function clearError(): void {
  errorBanner.classList.remove("visible");
  errorMsg.textContent = "";
}

export function showDropZone(): void {
  gameViewEl.hidden = true;
  dropZoneEl.hidden = false;
}

// Unlock the audio element within the current user gesture so autoplay works
// when audio src is set later after async transcoding.
export function unlockAudio(): void {
  const audio = document.getElementById("game-audio") as HTMLAudioElement;
  audio.play().catch(() => { /* expected: no src yet */ });
  audio.pause();
}

export function showAudioLoading(): void {
  const btn = document.getElementById("audio-btn") as HTMLButtonElement;
  btn.textContent = "🔊…";
  btn.classList.add("audio-btn--loading");
  btn.disabled = true;
  btn.hidden   = false;
}

export function playGameAudio(audioUrl: string): void {
  const audio = document.getElementById("game-audio") as HTMLAudioElement;
  const btn   = document.getElementById("audio-btn")  as HTMLButtonElement;
  audio.src = audioUrl;
  audio.play().then(() => {
    btn.hidden = true;
  }).catch(() => {
    // Autoplay blocked — let user click to unmute
    btn.textContent = "🔊 Play audio";
    btn.classList.remove("audio-btn--loading");
    btn.disabled = false;
    btn.hidden   = false;
    btn.onclick  = () => { void audio.play(); btn.hidden = true; };
  });
}

export function showAudioError(): void {
  const btn = document.getElementById("audio-btn") as HTMLButtonElement;
  btn.textContent = "🔇 No audio";
  btn.classList.remove("audio-btn--loading");
  btn.disabled = true;
  btn.hidden   = false;
}

export function clearGameAudio(): void {
  const audio = document.getElementById("game-audio") as HTMLAudioElement;
  const btn   = document.getElementById("audio-btn")  as HTMLButtonElement;
  audio.pause();
  if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
  audio.src  = "";
  btn.hidden = true;
  btn.disabled = false;
}

// PSP parental level (1–11) → label. Level 0 means not set.
const PARENTAL_LABELS: Record<number, string> = {
  1: "Everyone",
  2: "Everyone 10+",
  3: "Teen",
  4: "Mature 14+",
  5: "Mature 16+",
  6: "Mature 17+",
  7: "Adults Only 18+",
  8: "Adults Only 18+",
  9: "Adults Only 18+",
};

export function showGameView(info: GameInfo, iconUrl?: string, bgUrl?: string, videoUrl?: string): void {
  document.getElementById("game-title")!.textContent    = info.title;
  document.getElementById("game-disc-id")!.textContent  = info.discId   || "—";
  document.getElementById("game-version")!.textContent  = info.version  || "—";
  document.getElementById("game-region")!.textContent   = info.region   || "—";
  document.getElementById("game-rating")!.textContent   =
    info.parentalLevel > 0 ? (PARENTAL_LABELS[info.parentalLevel] ?? `Level ${info.parentalLevel}`) : "—";

  const saveTitleEl = document.getElementById("game-save-title")  as HTMLElement;
  const saveLabelEl = document.getElementById("game-save-title-label") as HTMLElement;
  if (info.saveTitle) {
    saveTitleEl.textContent = info.saveDetail
      ? `${info.saveTitle} — ${info.saveDetail}`
      : info.saveTitle;
    saveTitleEl.hidden = false;
    saveLabelEl.hidden = false;
  } else {
    saveTitleEl.hidden = true;
    saveLabelEl.hidden = true;
  }

  const card = document.querySelector(".game-card") as HTMLElement;
  card.style.backgroundImage = bgUrl
    ? `linear-gradient(rgba(22,27,34,0.72), rgba(22,27,34,0.72)), url(${bgUrl})`
    : "";

  const video       = document.getElementById("game-video")       as HTMLVideoElement;
  const icon        = document.getElementById("game-icon")        as HTMLImageElement;
  const placeholder = document.getElementById("game-media-placeholder") as HTMLElement;

  video.hidden       = true;
  icon.hidden        = true;
  placeholder.hidden = false;

  if (videoUrl) {
    video.src    = videoUrl;
    video.hidden = false;
    placeholder.hidden = true;
  } else if (iconUrl) {
    icon.src    = iconUrl;
    icon.alt    = info.title;
    icon.hidden = false;
    placeholder.hidden = true;
  }

  dropZoneEl.hidden = true;
  gameViewEl.hidden = false;
}

export function clearGameVideo(): void {
  const video   = document.getElementById("game-video")        as HTMLVideoElement;
  const spinner = document.getElementById("game-media-spinner") as HTMLElement;
  if (video && video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
  if (video)   { video.src = ""; video.hidden = true; }
  if (spinner) spinner.hidden = true;
}

export function setMediaLoading(loading: boolean): void {
  const spinner = document.getElementById("game-media-spinner") as HTMLElement;
  spinner.hidden = !loading;
}

export function setGameVideo(videoUrl: string): void {
  const video       = document.getElementById("game-video")            as HTMLVideoElement;
  const icon        = document.getElementById("game-icon")             as HTMLImageElement;
  const placeholder = document.getElementById("game-media-placeholder") as HTMLElement;
  const spinner     = document.getElementById("game-media-spinner")    as HTMLElement;

  video.src    = videoUrl;
  video.hidden = false;
  icon.hidden        = true;
  placeholder.hidden = true;
  spinner.hidden     = true;
}

export function showFileTree(root: IsoFile): void {
  const treeDiv = document.getElementById("file-tree")!;
  treeDiv.innerHTML = "";
  renderTree(treeDiv, root.children ?? [], 0);
}

// ── Gameplay view ─────────────────────────────────────────────────────────

export function showGameplayView(): void {
  const audio = document.getElementById("game-audio") as HTMLAudioElement;
  if (!audio.paused) audio.pause();

  const canvas = document.getElementById("psp-canvas") as HTMLCanvasElement;
  const ctx    = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 480, 272);
    ctx.fillStyle = "#58a6ff";
    ctx.font      = "bold 18px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Emulation not yet implemented", 240, 130);
    ctx.fillStyle = "#8b949e";
    ctx.font      = "13px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("CPU execution pipeline is under construction", 240, 158);
  }

  gameViewEl.hidden      = true;
  gameplayViewEl.hidden  = false;
  setStatus("Gameplay mode  ·  Tab / H — controls overlay");
}

export function exitGameplayView(): void {
  const audio = document.getElementById("game-audio") as HTMLAudioElement;
  if (audio.src) void audio.play().catch(() => {});

  gameplayViewEl.hidden = true;
  gameViewEl.hidden     = false;
  setStatus("Returned to game info.");
}

export function toggleGameplayHud(): void {
  gameplayHudEl.hidden = !gameplayHudEl.hidden;
}

function renderTree(container: HTMLElement, files: IsoFile[], depth: number): void {
  for (const file of files) {
    const item = document.createElement("span");
    item.className = "file-tree__item " +
      (file.isDirectory ? "file-tree__item--dir" : "file-tree__item--file");
    const indent = "\u00a0\u00a0".repeat(depth * 2);
    const prefix = file.isDirectory ? "▶ " : "  ";
    item.textContent = indent + prefix + file.name;
    container.appendChild(item);
    if (file.isDirectory && file.children) renderTree(container, file.children, depth + 1);
  }
}
