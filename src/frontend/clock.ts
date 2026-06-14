// PSP XMB-style clock for the top-right of the app bar. Shows "D/M HH:MM" in
// 24-hour form like the PSP home screen (e.g. "18/12 16:34"), updated each minute.

export function initClock(): void {
  const el = document.getElementById("app-clock");
  if (!el) return;

  const render = (): void => {
    const now = new Date();
    const m = String(now.getMinutes()).padStart(2, "0");
    el.textContent = `${now.getDate()}/${now.getMonth() + 1} ${now.getHours()}:${m}`;
  };

  render();
  // Line up the first tick with the next minute boundary, then tick each minute.
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    render();
    setInterval(render, 60000);
  }, msToNextMinute);
}
