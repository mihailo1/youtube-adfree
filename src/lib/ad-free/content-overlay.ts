import { AD_FREE_PLAYER_PATH } from "@/lib/ad-free/constants";
import {
  BUTTON_ID,
  STYLE_ID,
  ROOT_ID,
  OVERLAY_ID,
  IFRAME_ID,
  HOST_ACTIVE_CLASS,
  ROOT_ACTIVE_CLASS,
  getPlayerHost,
  getIframe,
  getRoot
} from "@/lib/ad-free/content-dom";

const BUTTON_CSS = `
/* Shared chip language with in-player quality menu */
#${BUTTON_ID} {
  --ytdl-chip-bg: rgba(15, 15, 15, 0.82);
  --ytdl-chip-bg-hover: rgba(40, 40, 40, 0.94);
  --ytdl-chip-border: rgba(255, 255, 255, 0.14);
  --ytdl-chip-active: #ff0033;
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  background: var(--ytdl-chip-bg);
  color: #fff;
  border: 1px solid var(--ytdl-chip-border);
  border-radius: 999px;
  padding: 0 12px 0 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  cursor: pointer;
  font-family: "YouTube Sans", Roboto, Arial, sans-serif;
  line-height: 1;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    opacity 0.2s ease,
    visibility 0.2s ease;
  pointer-events: auto;
  user-select: none;
}
#${BUTTON_ID}:hover {
  background: var(--ytdl-chip-bg-hover);
  border-color: rgba(255, 255, 255, 0.22);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
}

/*
 * Hide top chrome with player UI idle:
 * - Original YT: host has .ytp-autohide while controls fade
 * - Ad-Free active: root gets .is-controls-hidden from iframe controls-change bridge
 */
#movie_player.ytp-autohide:not(.${HOST_ACTIVE_CLASS}) #${BUTTON_ID},
.html5-video-player.ytp-autohide:not(.${HOST_ACTIVE_CLASS}) #${BUTTON_ID},
#${ROOT_ID}.${ROOT_ACTIVE_CLASS}.is-controls-hidden #${BUTTON_ID} {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}
#${BUTTON_ID}:active {
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}
#${BUTTON_ID}:disabled {
  opacity: 0.72;
  cursor: wait;
}
#${BUTTON_ID}.is-active {
  background: rgba(255, 0, 51, 0.18);
  border-color: rgba(255, 0, 51, 0.55);
  box-shadow: 0 4px 16px rgba(255, 0, 51, 0.18);
}
#${BUTTON_ID}.is-active:hover {
  background: rgba(255, 0, 51, 0.28);
  border-color: rgba(255, 0, 51, 0.7);
}
#${BUTTON_ID} .ytdl-ad-free-icon {
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  color: #ff4d6a;
}
#${BUTTON_ID}.is-active .ytdl-ad-free-icon {
  color: #fff;
}
#${BUTTON_ID} .ytdl-ad-free-label {
  white-space: nowrap;
}
#${BUTTON_ID} .ytdl-ad-free-meta {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}
#${BUTTON_ID}.is-active .ytdl-ad-free-meta {
  color: #fff;
  background: rgba(255, 0, 51, 0.45);
}
#${BUTTON_ID}.is-busy .ytdl-ad-free-icon {
  animation: ytdl-ad-free-spin 0.7s linear infinite;
}
@keyframes ytdl-ad-free-spin {
  to { transform: rotate(360deg); }
}

/*
 * In-host shell: absolute fill of #movie_player so scroll/stacking match native YT.
 * Never reparent after iframe exists (Chromium reloads iframe document on move).
 * Fallback: html > #root uses fixed + layout sync when host is missing at create time.
 */
#${ROOT_ID} {
  position: absolute;
  inset: 0;
  z-index: 45;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  box-sizing: border-box;
  pointer-events: none;
  overflow: hidden;
  /* Match modern YouTube player corner radius */
  border-radius: 12px;
}
/* Fallback mount on <html> — track host rect (fixed); clip under masthead */
html > #${ROOT_ID} {
  position: fixed;
  inset: auto;
  z-index: 39;
  border-radius: 12px;
}
#${ROOT_ID} #${BUTTON_ID} {
  pointer-events: auto;
}
#${OVERLAY_ID} {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: #000;
  display: flex;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  border-radius: inherit;
  overflow: hidden;
}
#${ROOT_ID}.${ROOT_ACTIVE_CLASS} #${OVERLAY_ID} {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}
#${IFRAME_ID} {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #000;
  border-radius: inherit;
}
/* Fullscreen / theater-like: square corners when host is full viewport */
#movie_player.ytp-fullscreen #${ROOT_ID},
#movie_player[data-fullscreen] #${ROOT_ID},
.html5-video-player.ytp-fullscreen #${ROOT_ID} {
  border-radius: 0;
}

/* Positioning context for in-host absolute root (YT already positions, reinforce) */
#movie_player:has(#${ROOT_ID}),
.html5-video-player:has(#${ROOT_ID}) {
  /* keep existing YT position; ensure children can fill */
  transform: translateZ(0);
}

#movie_player.${HOST_ACTIVE_CLASS} .html5-video-container,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-chrome-bottom,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-chrome-top,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-gradient-bottom,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-gradient-top,
.html5-video-player.${HOST_ACTIVE_CLASS} .html5-video-container {
  visibility: hidden !important;
  pointer-events: none !important;
}
#movie_player.${HOST_ACTIVE_CLASS} .video-ads,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-module,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-player-overlay-layout,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-player-overlay,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-player-overlay-instream-info,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-overlay-container,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-overlay-slot,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-image-overlay,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-text-overlay,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-progress-list,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-ad-progress,
#movie_player.${HOST_ACTIVE_CLASS} [class*="ytp-ad-player-overlay"],
#movie_player.${HOST_ACTIVE_CLASS} [id^="player-overlay-layout"],
#movie_player.${HOST_ACTIVE_CLASS} [id^="ad-avatar"],
#movie_player.${HOST_ACTIVE_CLASS} [id^="ad-button"],
#movie_player.${HOST_ACTIVE_CLASS} [id^="ad-badge"],
.html5-video-player.${HOST_ACTIVE_CLASS} .video-ads,
.html5-video-player.${HOST_ACTIVE_CLASS} .ytp-ad-module {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
  width: 0 !important;
  height: 0 !important;
  overflow: hidden !important;
}
`;

let layoutRafId = 0;
let layoutListening = false;

/**
 * When root is mounted inside the player host → only ensure visibility.
 * When root is on documentElement (fallback fixed) → mirror host rect + clip under masthead.
 */
export function syncRootLayout() {
  const elRoot = getRoot();
  const elHost = getPlayerHost();
  if (!elRoot) {
    return;
  }
  if (!elHost) {
    elRoot.style.visibility = "hidden";
    return;
  }

  const rect = elHost.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    elRoot.style.visibility = "hidden";
    return;
  }

  elRoot.style.visibility = "visible";

  // In-host absolute: no top/left tracking — scrolls with YouTube naturally
  if (elRoot.parentElement === elHost) {
    elRoot.style.top = "";
    elRoot.style.left = "";
    elRoot.style.width = "";
    elRoot.style.height = "";
    elRoot.style.clipPath = "";
    return;
  }

  // Fixed fallback: track host + clip under sticky masthead (don't float over chrome)
  elRoot.style.top = `${Math.round(rect.top)}px`;
  elRoot.style.left = `${Math.round(rect.left)}px`;
  elRoot.style.width = `${Math.round(rect.width)}px`;
  elRoot.style.height = `${Math.round(rect.height)}px`;

  const elMasthead = document.querySelector<HTMLElement>(
    "#masthead-container, ytd-masthead, #header"
  );
  const mastheadBottom = elMasthead
    ? Math.max(0, elMasthead.getBoundingClientRect().bottom)
    : 0;
  const clipTop = Math.max(0, Math.round(mastheadBottom - rect.top));
  const clipBottom = Math.max(0, Math.round(rect.bottom - window.innerHeight));
  const clipLeft = Math.max(0, Math.round(-rect.left));
  const clipRight = Math.max(0, Math.round(rect.right - window.innerWidth));

  if (rect.bottom <= mastheadBottom + 1 || rect.top >= window.innerHeight - 1) {
    elRoot.style.visibility = "hidden";
    elRoot.style.clipPath = "";
    return;
  }

  if (clipTop > 0 || clipBottom > 0 || clipLeft > 0 || clipRight > 0) {
    elRoot.style.clipPath = `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)`;
  } else {
    elRoot.style.clipPath = "";
  }
}

/** Prefer mounting inside #movie_player so overlay scrolls/stacks like native video. */
function mountRoot(elRoot: HTMLElement) {
  const elHost = getPlayerHost();
  if (!elHost) {
    if (elRoot.parentElement !== document.documentElement) {
      document.documentElement.append(elRoot);
    }
    return;
  }
  // Never reparent after iframe exists — Chromium reloads iframe document
  if (getIframe() && elRoot.parentElement && elRoot.parentElement !== elHost) {
    return;
  }
  if (elRoot.parentElement !== elHost) {
    elHost.append(elRoot);
  }
}

function scheduleLayoutSync() {
  if (layoutRafId) {
    return;
  }
  layoutRafId = window.requestAnimationFrame(() => {
    layoutRafId = 0;
    syncRootLayout();
  });
}

export function startLayoutTracking() {
  if (layoutListening) {
    return;
  }
  layoutListening = true;
  window.addEventListener("resize", scheduleLayoutSync, true);
  window.addEventListener("scroll", scheduleLayoutSync, true);
  document.addEventListener("yt-action", scheduleLayoutSync, true);
  document.addEventListener("fullscreenchange", scheduleLayoutSync, true);
}

export function stopLayoutTracking() {
  if (!layoutListening) {
    return;
  }
  layoutListening = false;
  window.removeEventListener("resize", scheduleLayoutSync, true);
  window.removeEventListener("scroll", scheduleLayoutSync, true);
  document.removeEventListener("yt-action", scheduleLayoutSync, true);
  document.removeEventListener("fullscreenchange", scheduleLayoutSync, true);
  if (layoutRafId) {
    window.cancelAnimationFrame(layoutRafId);
    layoutRafId = 0;
  }
}

export function setHostActive(isActive: boolean) {
  document.querySelectorAll(`.${HOST_ACTIVE_CLASS}`).forEach(element => {
    element.classList.remove(HOST_ACTIVE_CLASS);
  });
  if (!isActive) {
    return;
  }
  const elHost = getPlayerHost();
  elHost?.classList.add(HOST_ACTIVE_CLASS);
}

export function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const elStyle = document.createElement("style");
  elStyle.id = STYLE_ID;
  elStyle.textContent = BUTTON_CSS;
  (document.head ?? document.documentElement).append(elStyle);
}

const ICON_BOLT = (
  "<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\">"
  + "<path d=\"M13 2 4 14h7l-1 8 9-12h-7l1-8z\"/>"
  + "</svg>"
);

const ICON_YT = (
  "<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\">"
  + "<path d=\"M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.5 31.5 0 0 0 0 12a31.5 31.5 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.5 31.5 0 0 0 24 12a31.5 31.5 0 0 0-.5-5.8zM9.75 15.5v-7l6.5 3.5-6.5 3.5z\"/>"
  + "</svg>"
);

const ICON_SPINNER = (
  "<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\">"
  + "<circle cx=\"12\" cy=\"12\" r=\"9\" stroke=\"currentColor\" stroke-opacity=\"0.25\" stroke-width=\"2.5\"/>"
  + "<path d=\"M21 12a9 9 0 0 0-9-9\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\"/>"
  + "</svg>"
);

/**
 * Chip-style toggle: Ad-Free (off) ↔ YouTube (on = custom player active).
 * `withDot` kept for API compat; ignored in favor of mode icons.
 */
export function setButtonContents(
  elButton: HTMLButtonElement,
  label: string,
  options: { withDot?: boolean; isActive?: boolean } = {}
) {
  const { isActive = false } = options;
  const isBusy = /loading|switching|retry|failed/i.test(label);

  elButton.replaceChildren();
  elButton.classList.toggle("is-active", isActive);
  elButton.classList.toggle("is-busy", isBusy);

  const elIcon = document.createElement("span");
  elIcon.className = "ytdl-ad-free-icon";
  elIcon.setAttribute("aria-hidden", "true");
  if (isBusy) {
    elIcon.innerHTML = ICON_SPINNER;
  } else if (isActive) {
    elIcon.innerHTML = ICON_YT;
  } else {
    elIcon.innerHTML = ICON_BOLT;
  }

  const elText = document.createElement("span");
  elText.className = "ytdl-ad-free-label";
  elText.textContent = label;

  elButton.append(elIcon, elText);

  // Compact mode chip when in a stable state
  if (!isBusy) {
    const elMeta = document.createElement("span");
    elMeta.className = "ytdl-ad-free-meta";
    elMeta.textContent = isActive ? "ON" : "OFF";
    elButton.append(elMeta);
  }

  elButton.title = isActive ? "Switch back to YouTube player" : "Switch to Ad-Free player";
  elButton.setAttribute(
    "aria-label",
    isActive ? "Switch back to YouTube player" : "Switch to Ad-Free player"
  );
  elButton.setAttribute("aria-pressed", isActive ? "true" : "false");
}

export function createButton(onToggle: () => void): HTMLButtonElement {
  const elButton = document.createElement("button");
  elButton.id = BUTTON_ID;
  elButton.type = "button";
  setButtonContents(elButton, "Ad-Free", { isActive: false });

  function stopPlayerClick(e: Event) {
    e.stopPropagation();
  }

  elButton.addEventListener("mousedown", stopPlayerClick);
  elButton.addEventListener("mouseup", stopPlayerClick);
  elButton.addEventListener("pointerdown", stopPlayerClick);
  elButton.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    onToggle();
  });

  return elButton;
}

/**
 * Ensure stable root + iframe exist. Returns true only on first iframe create.
 * Never reparents the iframe after creation.
 */
export function ensureOverlay(
  videoId: string,
  startAt: number,
  callbacks: {
    onDestroy: () => void;
    onIframeCreated: () => void;
  }
): boolean {
  ensureStyles();
  startLayoutTracking();

  let elRoot = getRoot();
  let elIframe = getIframe();
  let elOverlay = document.getElementById(OVERLAY_ID);

  if (elRoot && elIframe?.dataset.videoId === videoId && elOverlay) {
    if (!document.getElementById(BUTTON_ID)) {
      elRoot.append(createButton(() => callbacks.onDestroy()));
    }
    syncRootLayout();
    return false;
  }

  if (elRoot && elIframe && elIframe.dataset.videoId !== videoId) {
    destroyOverlay();
    callbacks.onDestroy();
    elRoot = null;
    elIframe = null;
    elOverlay = null;
  }

  if (!elRoot) {
    elRoot = document.createElement("div");
    elRoot.id = ROOT_ID;
    // Mount inside host before iframe so we never need to reparent
    mountRoot(elRoot);
  } else {
    mountRoot(elRoot);
  }

  if (!elOverlay) {
    elOverlay = document.createElement("div");
    elOverlay.id = OVERLAY_ID;
    elRoot.append(elOverlay);
  }

  let didCreateIframe = false;
  if (!elIframe) {
    // Ensure in-host mount before first iframe load
    mountRoot(elRoot);
    elIframe = document.createElement("iframe");
    elIframe.id = IFRAME_ID;
    elIframe.dataset.videoId = videoId;
    elIframe.allow = "autoplay; fullscreen; picture-in-picture";
    elIframe.allowFullscreen = true;
    elIframe.src = browser.runtime.getURL(
      `/${AD_FREE_PLAYER_PATH}?v=${encodeURIComponent(videoId)}&embed=1&t=${encodeURIComponent(String(startAt))}&paused=1` as `/ad-free-player.html${string}`
    );
    elOverlay.append(elIframe);
    callbacks.onIframeCreated();
    didCreateIframe = true;
  }

  if (!document.getElementById(BUTTON_ID)) {
    elRoot.append(createButton(() => callbacks.onDestroy()));
  }

  syncRootLayout();
  return didCreateIframe;
}

export function destroyOverlay() {
  stopLayoutTracking();
  document.getElementById(ROOT_ID)?.remove();
  setHostActive(false);
}

export function hideOverlayKeepAlive() {
  const elRoot = getRoot();
  elRoot?.classList.remove(ROOT_ACTIVE_CLASS);
  setHostActive(false);
  syncRootLayout();
}

export function showOverlayActive() {
  const elRoot = getRoot();
  if (!elRoot) {
    return;
  }
  elRoot.classList.add(ROOT_ACTIVE_CLASS);
  setHostActive(true);
  syncRootLayout();
}
