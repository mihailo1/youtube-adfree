/**
 * Theater (wide) control matching YouTube's ytp-size-button icons.
 * Inserted before media-fullscreen-button in Vidstack chrome.
 */

const STYLE_ID = "ytdl-theater-btn-style";

/**
 * Default view icon — currently in theater; click → default (ytp-size-button).
 * Path from YT: "Режим просмотра по умолчанию".
 */
const ICON_DEFAULT_VIEW = (
  "<svg height=\"24\" viewBox=\"0 0 24 24\" width=\"24\" aria-hidden=\"true\">"
  + "<path d=\"M21.20 3.01L21 3H3L2.79 3.01C2.30 3.06 1.84 3.29 1.51 3.65C1.18 4.02 .99 4.50 1 5V19L1.01 19.20C1.05 19.66 1.26 20.08 1.58 20.41C1.91 20.73 2.33 20.94 2.79 20.99L3 21H21L21.20 20.98C21.66 20.94 22.08 20.73 22.41 20.41C22.73 20.08 22.94 19.66 22.99 19.20L23 19V5C23.00 4.50 22.81 4.02 22.48 3.65C22.15 3.29 21.69 3.06 21.20 3.01ZM3 15V5H21V15H3ZM16.87 6.72H16.86L16.79 6.79L13.58 10L16.79 13.20C16.88 13.30 16.99 13.37 17.11 13.43C17.23 13.48 17.37 13.51 17.50 13.51C17.63 13.51 17.76 13.48 17.89 13.43C18.01 13.38 18.12 13.31 18.21 13.21C18.31 13.12 18.38 13.01 18.43 12.89C18.48 12.76 18.51 12.63 18.51 12.50C18.51 12.37 18.48 12.23 18.43 12.11C18.37 11.99 18.30 11.88 18.20 11.79L16.41 10L18.20 8.20L18.27 8.13C18.42 7.93 18.50 7.69 18.49 7.45C18.47 7.20 18.37 6.97 18.20 6.79C18.02 6.62 17.79 6.52 17.55 6.50C17.30 6.49 17.06 6.57 16.87 6.72ZM5.79 6.79C5.60 6.98 5.50 7.23 5.50 7.5C5.50 7.76 5.60 8.01 5.79 8.20L7.58 10L5.79 11.79L5.72 11.86C5.57 12.06 5.49 12.30 5.50 12.54C5.51 12.79 5.62 13.02 5.79 13.20C5.97 13.37 6.20 13.48 6.45 13.49C6.69 13.50 6.93 13.42 7.13 13.27L7.20 13.20L10.41 10L7.20 6.79C7.01 6.60 6.76 6.50 6.5 6.50C6.23 6.50 5.98 6.60 5.79 6.79ZM3 19V17H21V19H3Z\" fill=\"currentColor\"></path>"
  + "</svg>"
);

/**
 * Theater / wide icon — currently default; click → theater (ytp-size-button).
 * Path from YT: "Широкий экран".
 */
const ICON_THEATER = (
  "<svg height=\"24\" viewBox=\"0 0 24 24\" width=\"24\" aria-hidden=\"true\">"
  + "<path d=\"M21.20 3.01L21 3H3L2.79 3.01C2.30 3.06 1.84 3.29 1.51 3.65C1.18 4.02 .99 4.50 1 5V19L1.01 19.20C1.05 19.66 1.26 20.08 1.58 20.41C1.91 20.73 2.33 20.94 2.79 20.99L3 21H21L21.20 20.98C21.66 20.94 22.08 20.73 22.41 20.41C22.73 20.08 22.94 19.66 22.99 19.20L23 19V5C23.00 4.50 22.81 4.02 22.48 3.65C22.15 3.29 21.69 3.06 21.20 3.01ZM3 15V5H21V15H3ZM7.87 6.72L7.79 6.79L4.58 10L7.79 13.20C7.88 13.30 7.99 13.37 8.11 13.43C8.23 13.48 8.37 13.51 8.50 13.51C8.63 13.51 8.76 13.48 8.89 13.43C9.01 13.38 9.12 13.31 9.21 13.21C9.31 13.12 9.38 13.01 9.43 12.89C9.48 12.76 9.51 12.63 9.51 12.50C9.51 12.37 9.48 12.23 9.43 12.11C9.37 11.99 9.30 11.88 9.20 11.79L7.41 10L9.20 8.20L9.27 8.13C9.42 7.93 9.50 7.69 9.48 7.45C9.47 7.20 9.36 6.97 9.19 6.80C9.02 6.63 8.79 6.52 8.54 6.51C8.30 6.49 8.06 6.57 7.87 6.72ZM14.79 6.79C14.60 6.98 14.50 7.23 14.50 7.5C14.50 7.76 14.60 8.01 14.79 8.20L16.58 10L14.79 11.79L14.72 11.86C14.57 12.06 14.49 12.30 14.50 12.54C14.51 12.79 14.62 13.02 14.79 13.20C14.97 13.37 15.20 13.48 15.45 13.49C15.69 13.50 15.93 13.42 16.13 13.27L16.20 13.20L19.41 10L16.20 6.79C16.01 6.60 15.76 6.50 15.5 6.50C15.23 6.50 14.98 6.60 14.79 6.79ZM3 19V17H21V19H3Z\" fill=\"currentColor\"></path>"
  + "</svg>"
);

const BUTTON_CSS = `
.ytdl-theater-button.vds-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  color: #fff;
  cursor: pointer;
  border-radius: 50%;
  flex-shrink: 0;
  opacity: 0.95;
}
.ytdl-theater-button.vds-button:hover {
  background: rgba(255, 255, 255, 0.1);
  opacity: 1;
}
.ytdl-theater-button.vds-button:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.55);
  outline-offset: 2px;
}
.ytdl-theater-button.vds-button svg {
  width: 24px;
  height: 24px;
  display: block;
  pointer-events: none;
}
/* Hide in true fullscreen — YT does the same with size button */
media-player[data-fullscreen] .ytdl-theater-button,
media-player:fullscreen .ytdl-theater-button,
:fullscreen .ytdl-theater-button {
  display: none !important;
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const elStyle = document.createElement("style");
  elStyle.id = STYLE_ID;
  elStyle.textContent = BUTTON_CSS;
  (document.head ?? document.documentElement).append(elStyle);
}

export type TheaterButtonHandle = {
  setTheater: (theater: boolean) => void;
  dispose: () => void;
};

export function installTheaterButton(
  elPlayer: HTMLElement,
  options: {
    onToggle: () => void;
    /** Initial state (parent may push later). */
    initialTheater?: boolean;
  }
): TheaterButtonHandle {
  ensureStyle();

  let isTheater = Boolean(options.initialTheater);
  const elButton = document.createElement("button");
  elButton.type = "button";
  elButton.className = "ytdl-theater-button vds-button";
  elButton.setAttribute("data-ytdl-theater", "1");
  elButton.setAttribute("aria-keyshortcuts", "t");

  function paint() {
    // When theater ON → icon = "default view"; when OFF → icon = "wide screen"
    elButton.innerHTML = isTheater ? ICON_DEFAULT_VIEW : ICON_THEATER;
    // Match YT tooltips: "Широкий экран (t)" / "Режим просмотра по умолчанию (t)"
    const title = isTheater
      ? "Default view (t)"
      : "Wide screen (t)";
    elButton.title = title;
    elButton.setAttribute("aria-label", title);
    elButton.setAttribute("aria-keyshortcuts", "t");
    elButton.setAttribute("aria-pressed", isTheater ? "true" : "false");
    elButton.dataset.theater = isTheater ? "1" : "0";
  }

  paint();

  elButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    options.onToggle();
  });

  function tryMount(): boolean {
    if (elButton.isConnected) {
      return true;
    }
    const elFs = elPlayer.querySelector(
      "media-fullscreen-button, .vds-fullscreen-button"
    );
    if (elFs?.parentElement) {
      elFs.parentElement.insertBefore(elButton, elFs);
      return true;
    }
    // Fallback: last controls group
    const groups = elPlayer.querySelectorAll(
      ".vds-controls-group, media-controls-group"
    );
    const last = groups[groups.length - 1];
    if (last) {
      last.append(elButton);
      return true;
    }
    return false;
  }

  tryMount();
  const mo = new MutationObserver(() => {
    if (tryMount()) {
      // keep observing in case layout rebuilds controls
    }
  });
  mo.observe(elPlayer, { childList: true, subtree: true });

  // Hotkey t (skip when typing)
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "t" && event.key !== "T") {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLElement
      && (target.isContentEditable
        || target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT")
    ) {
      return;
    }
    // Don't steal when fullscreen (size button is N/A)
    if (document.fullscreenElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    options.onToggle();
  }
  window.addEventListener("keydown", onKeydown, true);

  return {
    setTheater(theater: boolean) {
      if (isTheater === theater) {
        paint();
        return;
      }
      isTheater = theater;
      paint();
    },
    dispose() {
      mo.disconnect();
      window.removeEventListener("keydown", onKeydown, true);
      elButton.remove();
    }
  };
}
