// PSP XMB-style clock for the top-right of the app bar. Shows "D/M HH:MM" in
// 24-hour form like the PSP home screen (e.g. "18/12 16:34"), updated each minute.
// The <app-bar> component renders the clock and ticks it itself using formatClock.

/** Format "now" as the PSP home-screen clock text, e.g. "18/12 16:34". */
export function formatClock(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${now.getDate()}/${now.getMonth() + 1} ${h}:${m}`;
}
