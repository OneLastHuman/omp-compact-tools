const terminal = document.querySelector("#demo");
const modeButtons = Array.from(document.querySelectorAll(".mode-switch [data-mode]"));
const modeLabel = document.querySelector("[data-mode-label]");
const modeStatus = document.querySelector("[data-mode-status]");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function setMode(mode, announce = true) {
  if (!terminal) return;
  terminal.dataset.view = mode;
  if (modeLabel) modeLabel.textContent = mode;
  for (const button of modeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  if (announce && modeStatus) modeStatus.textContent = `${mode} mode`;
}

for (const button of modeButtons) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

if (reduceMotion) {
  setMode("line", false);
} else {
  setMode("default", false);
  window.setTimeout(() => setMode("line"), 650);
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const command = button.closest("[data-command]")?.dataset.command;
    if (!command) return;
    const status = document.querySelector("[data-copy-status]");
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = "Copied";
      if (status) status.textContent = "Command copied.";
    } catch {
      button.textContent = "Select";
      if (status) status.textContent = "Copy failed. Select the command manually.";
    }
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 1600);
  });
}
