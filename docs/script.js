const terminal = document.querySelector("#demo");
const modeButtons = Array.from(document.querySelectorAll(".mode-switch [data-mode]"));
const modeLabel = document.querySelector("[data-mode-label]");
const modeStatus = document.querySelector("[data-mode-status]");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const zh = document.documentElement.lang.toLowerCase().startsWith("zh");

function setMode(mode, announce = true) {
  if (!terminal) return;
  terminal.dataset.view = mode;
  if (modeLabel) modeLabel.textContent = mode;
  for (const button of modeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  if (announce && modeStatus) modeStatus.textContent = zh ? `已切换到 ${mode} 模式` : `${mode} mode`;
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
      button.textContent = zh ? "已复制" : "Copied";
      if (status) status.textContent = zh ? "命令已复制。" : "Command copied.";
    } catch {
      button.textContent = zh ? "手动复制" : "Select";
      if (status) status.textContent = zh ? "复制失败，请手动选择命令。" : "Copy failed. Select the command manually.";
    }
    window.setTimeout(() => {
      button.textContent = zh ? "复制" : "Copy";
    }, 1600);
  });
}
