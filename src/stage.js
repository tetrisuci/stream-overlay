// Shared scene helpers: URL params, the header clock, and the ?preview=1 stage scaling.

const params = new URLSearchParams(location.search);

// Ticks the LCD clock in the header (expects .system-clock-time > .system-clock-digits).
function startClock() {
  const clock = document.getElementById("system-clock-time");
  const display = clock.querySelector(".system-clock-digits");
  function tick() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    display.textContent = `${hours}:${minutes}:${seconds}`;
    clock.setAttribute("aria-label", `System time ${hours}:${minutes}:${seconds}`);
    clock.dateTime = now.toISOString();
    setTimeout(tick, 1000 - (Date.now() % 1000));
  }
  tick();
}

// Publishes the header height (the clock's height) so the header icon can size itself. Returns it.
function publishHeaderHeight() {
  const height = document.querySelector(".system-clock").offsetHeight;
  document.documentElement.style.setProperty("--header-height", `${height}px`);
  return height;
}

// With ?preview=1: checkerboard background and the 1920x1080 stage scaled to fit the window.
function startPreview() {
  if (params.get("preview") !== "1") return false;
  document.body.classList.add("preview");
  const stage = document.querySelector(".overlay");
  function fit() {
    const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
    stage.style.position = "absolute";
    stage.style.left = `${(innerWidth - 1920 * scale) / 2}px`;
    stage.style.top = `${(innerHeight - 1080 * scale) / 2}px`;
    stage.style.transform = `scale(${scale})`;
  }
  addEventListener("resize", fit);
  fit();
  return true;
}
