/**
 * Lightweight ephemeral overlays inside the Ad-Free player (seek flash, speed, download).
 */

export type PlayerToastController = {
  show: (text: string, options?: { durationMs?: number; kind?: "center" | "seek-left" | "seek-right" }) => void;
  showSeek: (deltaSeconds: number) => void;
  dispose: () => void;
  root: HTMLElement;
};

export function createPlayerToast(elMount: HTMLElement): PlayerToastController {
  const elRoot = document.createElement("div");
  elRoot.className = "ytdl-player-toast-layer";
  elRoot.setAttribute("aria-live", "polite");
  elMount.append(elRoot);

  let hideTimer = 0;

  function clearTimer() {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }

  function show(
    text: string,
    options?: { durationMs?: number; kind?: "center" | "seek-left" | "seek-right" }
  ) {
    const kind = options?.kind ?? "center";
    const durationMs = options?.durationMs ?? 700;
    clearTimer();
    elRoot.replaceChildren();

    const elToast = document.createElement("div");
    elToast.className = `ytdl-player-toast ytdl-player-toast--${kind}`;
    elToast.textContent = text;
    elRoot.append(elToast);
    // Force reflow so CSS transition runs
    void elToast.offsetWidth;
    elToast.classList.add("is-visible");

    hideTimer = window.setTimeout(() => {
      elToast.classList.remove("is-visible");
      hideTimer = window.setTimeout(() => {
        if (elToast.parentElement === elRoot) {
          elToast.remove();
        }
        hideTimer = 0;
      }, 180);
    }, durationMs);
  }

  function showSeek(deltaSeconds: number) {
    const abs = Math.abs(Math.round(deltaSeconds));
    if (deltaSeconds < 0) {
      show(`« ${abs}`, { kind: "seek-left", durationMs: 550 });
    } else if (deltaSeconds > 0) {
      show(`${abs} »`, { kind: "seek-right", durationMs: 550 });
    }
  }

  return {
    show,
    showSeek,
    root: elRoot,
    dispose() {
      clearTimer();
      elRoot.remove();
    }
  };
}
