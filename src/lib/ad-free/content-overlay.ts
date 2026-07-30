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

/** html class + style for Always Ad-Free before #movie_player exists (0–1s gap). */
export const EARLY_HIDE_CLASS = "ytdl-af-early-hide";
const EARLY_STYLE_ID = "ytdl-ad-free-early-style";

const EARLY_HIDE_CSS = `
html.${EARLY_HIDE_CLASS} #movie_player,
html.${EARLY_HIDE_CLASS} .html5-video-player {
  background: #000 !important;
}
html.${EARLY_HIDE_CLASS} #movie_player video,
html.${EARLY_HIDE_CLASS} .html5-video-player video,
html.${EARLY_HIDE_CLASS} .html5-video-container,
html.${EARLY_HIDE_CLASS} .ytp-chrome-bottom,
html.${EARLY_HIDE_CLASS} .ytp-chrome-top,
html.${EARLY_HIDE_CLASS} .ytp-bezel,
html.${EARLY_HIDE_CLASS} .ytp-large-play-button {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
html.${EARLY_HIDE_CLASS} .ytp-ad-module,
html.${EARLY_HIDE_CLASS} .video-ads,
html.${EARLY_HIDE_CLASS} [class*="ytp-ad-"] {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;

/** Instant black-out of native video/ads (no host required). Pair with Always Ad-Free cache. */
export function installEarlyHideCss() {
  try {
    document.documentElement.classList.add(EARLY_HIDE_CLASS);
  } catch {
    // ignore
  }
  if (document.getElementById(EARLY_STYLE_ID)) {
    return;
  }
  const elStyle = document.createElement("style");
  elStyle.id = EARLY_STYLE_ID;
  elStyle.textContent = EARLY_HIDE_CSS;
  (document.documentElement ?? document.head).append(elStyle);
}

export function removeEarlyHideCss() {
  try {
    document.documentElement.classList.remove(EARLY_HIDE_CLASS);
  } catch {
    // ignore
  }
  document.getElementById(EARLY_STYLE_ID)?.remove();
}

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
 * Fixed shell on <html> (NOT inside #movie_player).
 * YT Polymer rebuilds #movie_player mid-load and was destroying in-host roots →
 * iframe pagehide + second player-init (visible flicker). Fixed overlay survives that.
 *
 * z-index strategy:
 * - Default 1990: BELOW #masthead-container (~2020). Video scrolls under the
 *   toolbar like native YT — no JS clip-path (that lagged and made black stripes).
 * - .is-miniplayer raises above page chrome so the corner player stays on top.
 * - Download panel iron-dropdown is 20000 (watch-button.css).
 * - .is-under-modal drops BELOW YT iron-overlay dialogs (share, settings, …).
 *
 * Scroll: CSS anchor positioning (Chrome) sticks shell to #movie_player on the
 * compositor — no 1-frame lag. JS translate3d is fallback only.
 */
#movie_player {
  anchor-name: --ytdl-af-player;
}
.html5-video-player:not(#movie_player) {
  anchor-name: --ytdl-af-player;
}
#${ROOT_ID} {
  position: fixed;
  top: 0;
  left: 0;
  inset: auto;
  /* Below masthead (~2020) so toolbar naturally covers scrolling video */
  z-index: 1990;
  margin: 0;
  padding: 0;
  border: 0;
  box-sizing: border-box;
  pointer-events: none;
  overflow: hidden;
  border-radius: 12px;
  /* JS fallback path sets translate3d each scroll */
  transform: translate3d(0, 0, 0);
  /* Avoid subpixel bleed / black fringe while scrolling under opaque masthead */
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}
/* Compositor-synced to player — eliminates scroll "slip" vs host */
@supports (top: anchor(top)) {
  #${ROOT_ID}.is-css-anchor {
    position-anchor: --ytdl-af-player;
    top: anchor(top);
    left: anchor(left);
    width: anchor-size(width);
    height: anchor-size(height);
    transform: none !important;
    will-change: auto;
  }
}
/* Miniplayer floats over page content (masthead no longer relevant) */
#${ROOT_ID}.is-miniplayer {
  z-index: 10000;
}
/* YT modals (share, paper-dialog) use iron-overlay ~2000+; sit under them */
#${ROOT_ID}.is-under-modal {
  z-index: 1000 !important;
}
/* True browser fullscreen: win over everything while FS is active */
#${ROOT_ID}.is-fullscreen {
  z-index: 2147483646 !important;
  border-radius: 0 !important;
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
/* Under modal: never intercept clicks meant for the dialog */
#${ROOT_ID}.is-under-modal #${OVERLAY_ID},
#${ROOT_ID}.is-under-modal #${BUTTON_ID} {
  pointer-events: none !important;
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

/*
 * Nuclear cover: while Ad-Free owns the host, hide EVERY direct child of the
 * player except our root. Selective class lists miss new YT ad DOM variants.
 */
#movie_player.${HOST_ACTIVE_CLASS},
.html5-video-player.${HOST_ACTIVE_CLASS} {
  background: #000 !important;
  isolation: isolate;
}
#movie_player.${HOST_ACTIVE_CLASS} > *:not(#${ROOT_ID}),
.html5-video-player.${HOST_ACTIVE_CLASS} > *:not(#${ROOT_ID}) {
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
/* Nested native surfaces (ads re-inject under hidden parents with own stacking) */
#movie_player.${HOST_ACTIVE_CLASS} video,
#movie_player.${HOST_ACTIVE_CLASS} .html5-main-video,
#movie_player.${HOST_ACTIVE_CLASS} .html5-video-container,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-chrome-bottom,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-chrome-top,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-bezel,
#movie_player.${HOST_ACTIVE_CLASS} .ytp-large-play-button,
.html5-video-player.${HOST_ACTIVE_CLASS} video {
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
/* Page-level ad chrome (sometimes portaled outside #movie_player) */
body:has(.${HOST_ACTIVE_CLASS}) .video-ads,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-ad-module,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-ad-player-overlay-layout,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-ad-player-overlay,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-ad-player-overlay-instream-info,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-ad-overlay-container,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-ad-skip-button-container,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-ad-skip-button,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-skip-ad-button,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-ad-preview-container,
body:has(.${HOST_ACTIVE_CLASS}) .ytp-ad-text,
body:has(.${HOST_ACTIVE_CLASS}) [class*="ytp-ad-"],
body:has(.${HOST_ACTIVE_CLASS}) [id^="ad-avatar"],
body:has(.${HOST_ACTIVE_CLASS}) [id^="ad-button"],
body:has(.${HOST_ACTIVE_CLASS}) [id^="ad-badge"],
body:has(.${HOST_ACTIVE_CLASS}) [id^="player-overlay-layout"] {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
  width: 0 !important;
  height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
  z-index: -1 !important;
}
/* Root lives on <html>; these rules only matter for legacy in-host mounts */
#movie_player.${HOST_ACTIVE_CLASS} #${ROOT_ID},
.html5-video-player.${HOST_ACTIVE_CLASS} #${ROOT_ID} {
  visibility: visible !important;
  opacity: 1 !important;
  z-index: 1990 !important;
  pointer-events: none !important;
}
#movie_player.${HOST_ACTIVE_CLASS} #${ROOT_ID}.is-miniplayer,
.html5-video-player.${HOST_ACTIVE_CLASS} #${ROOT_ID}.is-miniplayer {
  z-index: 10000 !important;
}
#movie_player.${HOST_ACTIVE_CLASS} #${ROOT_ID}.is-under-modal,
.html5-video-player.${HOST_ACTIVE_CLASS} #${ROOT_ID}.is-under-modal {
  z-index: 1000 !important;
}
#movie_player.${HOST_ACTIVE_CLASS} #${ROOT_ID}.${ROOT_ACTIVE_CLASS} #${OVERLAY_ID},
.html5-video-player.${HOST_ACTIVE_CLASS} #${ROOT_ID}.${ROOT_ACTIVE_CLASS} #${OVERLAY_ID} {
  pointer-events: auto !important;
}
#movie_player.${HOST_ACTIVE_CLASS} #${ROOT_ID} #${BUTTON_ID},
.html5-video-player.${HOST_ACTIVE_CLASS} #${ROOT_ID} #${BUTTON_ID} {
  pointer-events: auto !important;
  visibility: visible !important;
  opacity: 1 !important;
}
`;

let layoutRafId = 0;
let layoutListening = false;
let hostResizeObserver: ResizeObserver | null = null;
let observedHost: Element | null = null;
let modalListening = false;

/** Chrome 125+: position-anchor sticks fixed shell to player without main-thread lag. */
function supportsCssAnchor(): boolean {
  try {
    return typeof CSS !== "undefined"
      && typeof CSS.supports === "function"
      && CSS.supports("top", "anchor(top)")
      && CSS.supports("position-anchor", "--ytdl-af-player");
  } catch {
    return false;
  }
}

const USE_CSS_ANCHOR = supportsCssAnchor();

/**
 * True when a YT paper/iron modal should stack above our fixed player shell.
 * Share panel, confirm dialogs, hotkeys help, etc.
 *
 * Prefer backdrop.opened — paper-dialog nodes often stay mounted while closed.
 * Our download iron-dropdown is NOT included — it uses z-index 20000 instead.
 */
export function isYtModalOpen(): boolean {
  try {
    // Backdrop is the most reliable "modal is up" signal
    if (
      document.querySelector(
        "tp-yt-iron-overlay-backdrop.opened, iron-overlay-backdrop.opened"
      )
    ) {
      return true;
    }

    // Explicitly opened paper dialogs (attribute set by iron-overlay)
    const openedDialogs = document.querySelectorAll(
      "tp-yt-paper-dialog[opened], tp-yt-paper-dialog[aria-modal='true']"
    );
    for (const node of openedDialogs) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if (node.getAttribute("aria-hidden") === "true") {
        continue;
      }
      const r = node.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) {
        return true;
      }
    }

    // Share panel (may mount without backdrop.opened for a frame)
    const elShare = document.querySelector("yt-unified-share-panel-renderer");
    if (elShare instanceof HTMLElement && elShare.getAttribute("aria-hidden") !== "true") {
      const style = window.getComputedStyle(elShare);
      if (style.display !== "none" && style.visibility !== "hidden") {
        const r = elShare.getBoundingClientRect();
        if (r.width > 40 && r.height > 40) {
          return true;
        }
      }
    }

    // Confirm / hotkey help renderers
    for (const sel of [
      "yt-confirm-dialog-renderer",
      "ytd-hotkey-dialog-renderer"
    ] as const) {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement) || el.getAttribute("aria-hidden") === "true") {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/** Drop under YT modals; raise again when they close. */
export function syncModalStacking() {
  const elRoot = getRoot();
  if (!elRoot) {
    return;
  }
  const under = isYtModalOpen();
  elRoot.classList.toggle("is-under-modal", under);
  if (!under) {
    // Let CSS default (1990 / miniplayer / fullscreen) apply
    elRoot.style.zIndex = "";
    return;
  }
  // Sit just under the backdrop/dialog stack (iron-overlay assigns z dynamically)
  let z = 1000;
  const elBackdrop = document.querySelector(
    "tp-yt-iron-overlay-backdrop.opened, iron-overlay-backdrop.opened"
  );
  if (elBackdrop instanceof HTMLElement) {
    const bz = Number.parseInt(window.getComputedStyle(elBackdrop).zIndex, 10);
    if (Number.isFinite(bz) && bz > 2) {
      z = bz - 1;
    }
  } else {
    // No backdrop — peek at opened paper-dialog z-index
    const elDialog = document.querySelector(
      "tp-yt-paper-dialog[opened], tp-yt-paper-dialog[aria-modal='true']"
    );
    if (elDialog instanceof HTMLElement) {
      const dz = Number.parseInt(window.getComputedStyle(elDialog).zIndex, 10);
      if (Number.isFinite(dz) && dz > 2) {
        z = dz - 1;
      }
    }
  }
  elRoot.style.zIndex = String(z);
}

/**
 * Mirror #movie_player rect onto fixed root (always on documentElement).
 * Prefer CSS anchor positioning (no main-thread lag). JS translate3d fallback.
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

  ensureHostResizeObserver(elHost);

  const rect = elHost.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    elRoot.style.visibility = "hidden";
    return;
  }

  if (USE_CSS_ANCHOR) {
    // Position/size from CSS anchor — clear any leftover JS geometry
    elRoot.classList.add("is-css-anchor");
    elRoot.style.top = "";
    elRoot.style.left = "";
    elRoot.style.width = "";
    elRoot.style.height = "";
    elRoot.style.transform = "";
  } else {
    elRoot.classList.remove("is-css-anchor");
    // Subpixel floats + transform (fallback when anchor unsupported)
    elRoot.style.top = "0px";
    elRoot.style.left = "0px";
    elRoot.style.width = `${rect.width}px`;
    elRoot.style.height = `${rect.height}px`;
    elRoot.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
  }

  // Stacking flags before visibility (visibility reads is-fullscreen / miniplayer)
  const isFs = elHost.classList.contains("ytp-fullscreen")
    || elHost.hasAttribute("data-fullscreen")
    || Boolean(document.fullscreenElement);
  elRoot.style.borderRadius = isFs ? "0px" : "12px";
  elRoot.classList.toggle("is-fullscreen", isFs);
  elRoot.classList.toggle("is-miniplayer", isMiniplayerHost(elHost));

  // Never use clip-path under masthead — it lags vs anchors and paints black stripes.
  // Shell z-index is below masthead so the toolbar covers the video natively.
  elRoot.style.clipPath = "";
  applyViewportVisibility(elRoot, rect, elHost);

  // Keep modal stacking in sync (cheap when no dialog)
  syncModalStacking();
}

/** Host is (or lives inside) YT miniplayer. */
function isMiniplayerHost(elHost: Element): boolean {
  try {
    if (elHost.closest("ytd-miniplayer")) {
      return true;
    }
    const elMini = document.querySelector("ytd-miniplayer");
    if (!(elMini instanceof HTMLElement)) {
      return false;
    }
    // Active miniplayer surfaces
    if (
      elMini.hasAttribute("active")
      || elMini.getAttribute("enabled") === ""
      || elMini.classList.contains("active")
      || elMini.hasAttribute("expanded")
    ) {
      return elMini.contains(elHost) || elHost.id === "movie_player";
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Hide only when fully off-screen / fully under masthead.
 * Partial overlap: leave visible — masthead paints on top (z-index).
 */
function applyViewportVisibility(
  elRoot: HTMLElement,
  rect: DOMRect,
  elHost: Element
) {
  // Miniplayer / fullscreen always visible in their rect
  if (
    elRoot.classList.contains("is-fullscreen")
    || isMiniplayerHost(elHost)
  ) {
    elRoot.style.visibility = "visible";
    return;
  }

  const elMasthead = document.querySelector<HTMLElement>(
    "#masthead-container, ytd-masthead, #header"
  );
  const mastheadBottom = elMasthead
    ? Math.max(0, elMasthead.getBoundingClientRect().bottom)
    : 0;

  // Fully covered by toolbar or completely off viewport
  if (
    rect.bottom <= mastheadBottom + 0.5
    || rect.top >= window.innerHeight - 0.5
    || rect.right <= 0.5
    || rect.left >= window.innerWidth - 0.5
  ) {
    elRoot.style.visibility = "hidden";
    return;
  }

  elRoot.style.visibility = "visible";
}

/**
 * Lightweight scroll path when CSS anchors own geometry — visibility only.
 */
function syncRootClipOnScroll() {
  const elRoot = getRoot();
  const elHost = getPlayerHost();
  if (!elRoot || !elHost) {
    return;
  }
  const rect = elHost.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    elRoot.style.visibility = "hidden";
    return;
  }
  elRoot.classList.toggle("is-miniplayer", isMiniplayerHost(elHost));
  applyViewportVisibility(elRoot, rect, elHost);
}

/**
 * Always mount on documentElement (fixed). Never inside #movie_player —
 * YT rebuilds that node and was killing our iframe (second player-init flicker).
 */
function mountRoot(elRoot: HTMLElement) {
  if (elRoot.parentElement === document.documentElement) {
    return;
  }
  // If somehow left inside host from older builds, pull out without destroying iframe
  // only when not yet having iframe; with iframe, leave in place (reparent reloads).
  if (elRoot.querySelector(`#${IFRAME_ID}`) || getIframe()) {
    return;
  }
  document.documentElement.append(elRoot);
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

/**
 * Scroll: anchors → clip only; fallback → full geometry every frame (no rAF lag).
 */
function onScrollSync() {
  if (USE_CSS_ANCHOR) {
    syncRootClipOnScroll();
  } else {
    syncRootLayout();
  }
}

function ensureHostResizeObserver(elHost: Element) {
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  if (!hostResizeObserver) {
    hostResizeObserver = new ResizeObserver(() => {
      scheduleLayoutSync();
    });
  }
  if (observedHost === elHost) {
    return;
  }
  if (observedHost) {
    try {
      hostResizeObserver.unobserve(observedHost);
    } catch {
      // ignore
    }
  }
  observedHost = elHost;
  hostResizeObserver.observe(elHost);
}

let modalPollTimer = 0;

function startModalTracking() {
  if (modalListening) {
    return;
  }
  modalListening = true;
  // Polymer iron-overlay lifecycle (share, settings, confirms)
  document.addEventListener("iron-overlay-opened", onModalEvent, true);
  document.addEventListener("iron-overlay-closed", onModalEvent, true);
  document.addEventListener("iron-overlay-canceled", onModalEvent, true);
  // Share/open often follows a click; iron events may stay in shadow trees
  document.addEventListener("click", onPageClickMaybeModal, true);
  document.addEventListener("keydown", onKeyMaybeModal, true);
}

function stopModalTracking() {
  if (!modalListening) {
    return;
  }
  modalListening = false;
  document.removeEventListener("iron-overlay-opened", onModalEvent, true);
  document.removeEventListener("iron-overlay-closed", onModalEvent, true);
  document.removeEventListener("iron-overlay-canceled", onModalEvent, true);
  document.removeEventListener("click", onPageClickMaybeModal, true);
  document.removeEventListener("keydown", onKeyMaybeModal, true);
  if (modalPollTimer) {
    window.clearInterval(modalPollTimer);
    modalPollTimer = 0;
  }
}

function onModalEvent() {
  // Layout reflow may lag one tick after iron opens
  syncModalStacking();
  window.setTimeout(syncModalStacking, 0);
  window.setTimeout(syncModalStacking, 50);
  window.setTimeout(syncModalStacking, 200);
  armModalPoll();
}

/** Brief higher-frequency poll after UI actions that often open/close dialogs. */
function armModalPoll() {
  if (modalPollTimer) {
    window.clearInterval(modalPollTimer);
  }
  let ticks = 0;
  modalPollTimer = window.setInterval(() => {
    syncModalStacking();
    ticks += 1;
    // ~2s of 100ms checks after share / esc / click
    if (ticks >= 20) {
      window.clearInterval(modalPollTimer);
      modalPollTimer = 0;
    }
  }, 100);
}

function onPageClickMaybeModal() {
  window.setTimeout(syncModalStacking, 0);
  window.setTimeout(syncModalStacking, 80);
  window.setTimeout(syncModalStacking, 250);
  armModalPoll();
}

function onKeyMaybeModal(e: Event) {
  if (!(e instanceof KeyboardEvent)) {
    return;
  }
  // Esc closes dialogs; some hotkeys open them
  if (e.key === "Escape" || e.key === "Esc") {
    window.setTimeout(syncModalStacking, 0);
    window.setTimeout(syncModalStacking, 80);
    armModalPoll();
  }
}

export function startLayoutTracking() {
  if (layoutListening) {
    return;
  }
  layoutListening = true;
  window.addEventListener("resize", scheduleLayoutSync, true);
  // Capture + passive + immediate: stay glued while page scrolls
  window.addEventListener("scroll", onScrollSync, { capture: true, passive: true });
  document.addEventListener("yt-action", scheduleLayoutSync, true);
  document.addEventListener("fullscreenchange", scheduleLayoutSync, true);
  startModalTracking();
  // Initial modal / host observe
  scheduleLayoutSync();
}

export function stopLayoutTracking() {
  if (!layoutListening) {
    return;
  }
  layoutListening = false;
  window.removeEventListener("resize", scheduleLayoutSync, true);
  window.removeEventListener("scroll", onScrollSync, true);
  document.removeEventListener("yt-action", scheduleLayoutSync, true);
  document.removeEventListener("fullscreenchange", scheduleLayoutSync, true);
  stopModalTracking();
  if (layoutRafId) {
    window.cancelAnimationFrame(layoutRafId);
    layoutRafId = 0;
  }
  if (hostResizeObserver) {
    try {
      hostResizeObserver.disconnect();
    } catch {
      // ignore
    }
    hostResizeObserver = null;
    observedHost = null;
  }
  const elRoot = getRoot();
  if (elRoot) {
    elRoot.classList.remove(
      "is-under-modal",
      "is-fullscreen",
      "is-css-anchor",
      "is-miniplayer"
    );
    elRoot.style.zIndex = "";
    elRoot.style.transform = "";
    elRoot.style.clipPath = "";
  }
}

let coverEnforcerId = 0;

/**
 * Mark only the real player hosts. Avoid thrashing many ancestors on every tick
 * (that + MutationObserver froze the watch page during SPA load).
 */
function markPlayerHosts() {
  const elMovie = document.getElementById("movie_player");
  if (elMovie instanceof HTMLElement) {
    elMovie.classList.add(HOST_ACTIVE_CLASS);
  }
  const elHtml5 = document.querySelector(".html5-video-player");
  if (elHtml5 instanceof HTMLElement) {
    elHtml5.classList.add(HOST_ACTIVE_CLASS);
  }
  const elHost = getPlayerHost();
  if (elHost instanceof HTMLElement) {
    elHost.classList.add(HOST_ACTIVE_CLASS);
  }
}

export function setHostActive(isActive: boolean) {
  if (!isActive) {
    document.querySelectorAll(`.${HOST_ACTIVE_CLASS}`).forEach(element => {
      element.classList.remove(HOST_ACTIVE_CLASS);
    });
    stopCoverEnforcer();
    return;
  }
  // Only add — avoid remove+readd thrash (layout thrashing with nuclear CSS)
  markPlayerHosts();
  startCoverEnforcer();
}

/**
 * Black cover shell as soon as possible (before stream resolve / iframe).
 * Does not create the player iframe (avoids empty-session race).
 * Does NOT unload the original player — only CSS hide + park.
 * Idempotent when shell already active.
 */
export function showImmediateCover() {
  ensureStyles();
  startLayoutTracking();

  let elRoot = getRoot();
  // Iframe already running — only assert host classes; never remount
  if (elRoot?.querySelector(`#${IFRAME_ID}`) || getIframe()) {
    elRoot?.classList.add(ROOT_ACTIVE_CLASS);
    setHostActive(true);
    return;
  }

  const alreadyMounted = elRoot != null
    && elRoot.classList.contains(ROOT_ACTIVE_CLASS)
    && Boolean(document.getElementById(OVERLAY_ID));

  if (!elRoot) {
    elRoot = document.createElement("div");
    elRoot.id = ROOT_ID;
    mountRoot(elRoot);
  } else {
    mountRoot(elRoot);
  }

  let elOverlay = document.getElementById(OVERLAY_ID);
  if (!elOverlay) {
    elOverlay = document.createElement("div");
    elOverlay.id = OVERLAY_ID;
    elRoot.append(elOverlay);
  }

  elRoot.classList.add(ROOT_ACTIVE_CLASS);
  setHostActive(true);
  if (!alreadyMounted) {
    syncRootLayout();
  }
}

/**
 * Lightweight re-assert: YT sometimes strips classes on ad transitions.
 * No DOM scrubbing, no MutationObserver (those locked the page on load).
 */
function startCoverEnforcer() {
  if (coverEnforcerId) {
    return;
  }
  coverEnforcerId = window.setInterval(() => {
    const elMovie = document.getElementById("movie_player");
    if (elMovie && !elMovie.classList.contains(HOST_ACTIVE_CLASS)) {
      markPlayerHosts();
    }
    const elRoot = getRoot();
    if (elRoot && !elRoot.classList.contains(ROOT_ACTIVE_CLASS)) {
      elRoot.classList.add(ROOT_ACTIVE_CLASS);
    }
    // Share/dialog may open without iron events reaching us (shadow timing)
    syncModalStacking();
  }, 2_000);
}

function stopCoverEnforcer() {
  if (coverEnforcerId) {
    window.clearInterval(coverEnforcerId);
    coverEnforcerId = 0;
  }
}

export function ensureStyles() {
  const elExisting = document.getElementById(STYLE_ID);
  if (elExisting instanceof HTMLStyleElement) {
    // Always refresh so extension reloads pick up CSS fixes without a full YT hard refresh
    elExisting.textContent = BUTTON_CSS;
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
  },
  options?: {
    /** When false, iframe starts with wants-play (Always Ad-Free autoplay). Default true. */
    startPaused?: boolean;
  }
): boolean {
  ensureStyles();
  startLayoutTracking();
  const startPaused = options?.startPaused !== false;

  let elRoot = getRoot();
  let elIframe = getIframe();
  let elOverlay = document.getElementById(OVERLAY_ID);

  // Legacy in-host root (pre-fixed overlay): drop empty shell so we remount on <html>
  if (elRoot && !elIframe && elRoot.parentElement && elRoot.parentElement !== document.documentElement) {
    elRoot.remove();
    elRoot = null;
    elOverlay = null;
  }

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
    mountRoot(elRoot);
  } else if (!elIframe) {
    mountRoot(elRoot);
  }

  if (!elOverlay) {
    elOverlay = document.createElement("div");
    elOverlay.id = OVERLAY_ID;
    elRoot.append(elOverlay);
  }

  let didCreateIframe = false;
  if (!elIframe) {
    // Last chance to sit inside host before first iframe load
    mountRoot(elRoot);
    elIframe = document.createElement("iframe");
    elIframe.id = IFRAME_ID;
    elIframe.dataset.videoId = videoId;
    elIframe.allow = "autoplay; fullscreen; picture-in-picture";
    elIframe.allowFullscreen = true;
    const pausedFlag = startPaused ? "1" : "0";
    elIframe.src = browser.runtime.getURL(
      `/${AD_FREE_PLAYER_PATH}?v=${encodeURIComponent(videoId)}&embed=1&t=${encodeURIComponent(String(startAt))}&paused=${pausedFlag}` as `/ad-free-player.html${string}`
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
  stopCoverEnforcer();
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
