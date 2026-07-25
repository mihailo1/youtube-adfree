import {
  AD_FREE_BRIDGE_TYPE,
  type AdFreeBridgeFromPlayer,
  type AdFreeBridgeToPlayer,
  type AdFreePlaybackSnapshot,
  isBridgeMessage,
  isValidSnapshot
} from "@/lib/ad-free/bridge";
import { extractCaptionsFromDocument } from "@/lib/ad-free/captions";
import { AD_FREE_PLAYER_PATH, AD_FREE_VISITOR_DATA_KEY } from "@/lib/ad-free/constants";
import {
  type AdFreeStreamPayload,
  adFreeStreamStorageKey
} from "@/lib/ad-free/resolve-stream";
import { extractVisitorDataFromDocument } from "@/lib/ad-free/visitor-data";
import { MessageType, sendMessage } from "@/lib/messaging/messaging";

const BUTTON_ID = "ytdl-ad-free-btn";
const STYLE_ID = "ytdl-ad-free-btn-style";
const OVERLAY_ID = "ytdl-ad-free-overlay";
const IFRAME_ID = "ytdl-ad-free-iframe";
const PARK_ID = "ytdl-ad-free-park";
const HOST_ACTIVE_CLASS = "ytdl-ad-free-active";
const HOST_HIDDEN_CLASS = "ytdl-ad-free-hidden";
const OBSERVER_DISCONNECT_MS = 30_000;
const BRIDGE_TIMEOUT_MS = 4_000;
/** Skip seek when times are close — avoids a visual "reload" on quick toggles. */
const SEEK_EPSILON_SEC = 0.75;

const BUTTON_CSS = `
#${BUTTON_ID} {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 80;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 18px;
  padding: 7px 12px 7px 10px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: "YouTube Sans", Roboto, Arial, sans-serif;
  line-height: 1.2;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  transition: background 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
  pointer-events: auto;
  user-select: none;
}
#${BUTTON_ID}:hover {
  background: rgba(204, 0, 0, 0.92);
  border-color: transparent;
  transform: translateY(-1px);
}
#${BUTTON_ID}:active {
  transform: translateY(0);
}
#${BUTTON_ID}:disabled {
  opacity: 0.75;
  cursor: wait;
  transform: none;
}
#${BUTTON_ID}.is-active {
  background: rgba(204, 0, 0, 0.92);
  border-color: transparent;
}
#${BUTTON_ID} .ytdl-ad-free-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f00;
  box-shadow: 0 0 0 2px rgba(255, 0, 0, 0.25);
  flex-shrink: 0;
}
#${BUTTON_ID}.is-active .ytdl-ad-free-dot {
  background: #0f0;
  box-shadow: 0 0 0 2px rgba(0, 255, 0, 0.25);
}
.html5-video-player #${BUTTON_ID},
#movie_player #${BUTTON_ID},
#ytd-player #${BUTTON_ID} {
  position: absolute;
}
#${OVERLAY_ID} {
  position: absolute;
  inset: 0;
  z-index: 55;
  background: #000;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
}
#${OVERLAY_ID}.${HOST_HIDDEN_CLASS} {
  display: none !important;
}
/* Keep-alive parking lot: outside #movie_player so YT re-renders cannot destroy the iframe */
#${PARK_ID} {
  position: fixed !important;
  left: -99999px !important;
  top: 0 !important;
  width: 2px !important;
  height: 2px !important;
  overflow: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
  z-index: -1 !important;
}
#${PARK_ID} #${OVERLAY_ID} {
  position: static !important;
  inset: auto !important;
  width: 2px !important;
  height: 2px !important;
}
#${IFRAME_ID} {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #000;
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
/* Hide YouTube ad chrome while Ad-Free overlay is active */
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

type YtPlayerEl = HTMLElement & {
  pauseVideo?: () => void;
  playVideo?: () => void;
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void;
  getCurrentTime?: () => number;
  getPlayerState?: () => number;
  getPlaybackRate?: () => number;
  setPlaybackRate?: (rate: number) => void;
  getVolume?: () => number;
  setVolume?: (volume: number) => void;
  isMuted?: () => boolean;
  mute?: () => void;
  unMute?: () => void;
};

let isAdFreeActive = false;
let activeVideoId: string | null = null;
let isPlayerReady = false;
let lastSnapshot: AdFreePlaybackSnapshot | null = null;

function getVideoId(): string | null {
  const url = new URL(location.href);
  if (url.pathname !== "/watch") {
    return null;
  }
  return url.searchParams.get("v");
}

function getPlayerHost(): HTMLElement | null {
  const candidates = [
    document.querySelector<HTMLElement>("#movie_player"),
    document.querySelector<HTMLElement>(".html5-video-player"),
    document.querySelector<HTMLElement>("#ytd-player"),
    document.querySelector<HTMLElement>("#player-container-inner"),
    document.querySelector<HTMLElement>("#player-api")
  ];
  return candidates.find(Boolean) ?? null;
}

function getYtPlayer(): YtPlayerEl | null {
  return document.getElementById("movie_player") as YtPlayerEl | null;
}

function getYtVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("#movie_player video.html5-main-video")
    ?? document.querySelector<HTMLVideoElement>("#movie_player video")
    ?? document.querySelector<HTMLVideoElement>(".html5-video-player video");
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const elStyle = document.createElement("style");
  elStyle.id = STYLE_ID;
  elStyle.textContent = BUTTON_CSS;
  (document.head ?? document.documentElement).append(elStyle);
}

async function persistVisitorData() {
  const visitorData = extractVisitorDataFromDocument();
  if (!visitorData) {
    return;
  }

  await browser.storage.local.set({ [AD_FREE_VISITOR_DATA_KEY]: visitorData });
}

function setButtonContent(
  elButton: HTMLButtonElement,
  label: string,
  options: { withDot?: boolean; isActive?: boolean } = {}
) {
  const { withDot = true, isActive = false } = options;
  elButton.replaceChildren();
  elButton.classList.toggle("is-active", isActive);
  if (withDot) {
    const elDot = document.createElement("span");
    elDot.className = "ytdl-ad-free-dot";
    elDot.setAttribute("aria-hidden", "true");
    elButton.append(elDot);
  }
  const elText = document.createElement("span");
  elText.textContent = label;
  elButton.append(elText);
  elButton.title = isActive ? "Switch back to YouTube player" : "Switch to Ad-Free player";
  elButton.setAttribute(
    "aria-label",
    isActive ? "Switch back to YouTube player" : "Switch to Ad-Free player"
  );
  elButton.setAttribute("aria-pressed", isActive ? "true" : "false");
}

function captureYouTubeSnapshot(videoId: string): AdFreePlaybackSnapshot {
  const elPlayer = getYtPlayer();
  const elVideo = getYtVideo();

  let currentTime = 0;
  try {
    currentTime = elPlayer?.getCurrentTime?.() ?? elVideo?.currentTime ?? 0;
  } catch {
    currentTime = elVideo?.currentTime ?? 0;
  }

  let wasPlaying = false;
  try {
    // YT player states: 1 = playing
    wasPlaying = elPlayer?.getPlayerState?.() === 1
      || Boolean(elVideo && !elVideo.paused && !elVideo.ended);
  } catch {
    wasPlaying = Boolean(elVideo && !elVideo.paused && !elVideo.ended);
  }

  let playbackRate = 1;
  try {
    playbackRate = elPlayer?.getPlaybackRate?.() ?? elVideo?.playbackRate ?? 1;
  } catch {
    playbackRate = elVideo?.playbackRate ?? 1;
  }

  let volume = 1;
  let muted = false;
  try {
    const ytVolume = elPlayer?.getVolume?.();
    volume = typeof ytVolume === "number" ? Math.min(1, Math.max(0, ytVolume / 100)) : (elVideo?.volume ?? 1);
    muted = elPlayer?.isMuted?.() ?? elVideo?.muted ?? false;
  } catch {
    volume = elVideo?.volume ?? 1;
    muted = elVideo?.muted ?? false;
  }

  return {
    videoId,
    currentTime: Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0,
    wasPlaying,
    playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
    volume: Number.isFinite(volume) ? volume : 1,
    muted
  };
}

function pauseYouTubePlayer() {
  const elVideo = getYtVideo();
  elVideo?.pause();
  try {
    getYtPlayer()?.pauseVideo?.();
  } catch {
    // ignore
  }
}

function applyYouTubeSnapshot(snapshot: AdFreePlaybackSnapshot, forcePause: boolean) {
  const elPlayer = getYtPlayer();
  const elVideo = getYtVideo();
  const time = Math.max(0, snapshot.currentTime);

  try {
    elPlayer?.seekTo?.(time, true);
  } catch {
    // ignore
  }
  if (elVideo) {
    try {
      elVideo.currentTime = time;
    } catch {
      // ignore
    }
  }

  try {
    elPlayer?.setPlaybackRate?.(snapshot.playbackRate);
  } catch {
    // ignore
  }
  if (elVideo) {
    elVideo.playbackRate = snapshot.playbackRate;
  }

  try {
    elPlayer?.setVolume?.(Math.round(snapshot.volume * 100));
    if (snapshot.muted) {
      elPlayer?.mute?.();
    } else {
      elPlayer?.unMute?.();
    }
  } catch {
    // ignore
  }
  if (elVideo) {
    elVideo.volume = snapshot.volume;
    elVideo.muted = snapshot.muted;
  }

  // On player switch always pause (user can press play).
  if (forcePause || !snapshot.wasPlaying) {
    pauseYouTubePlayer();
    return;
  }

  try {
    elPlayer?.playVideo?.();
  } catch {
    void elVideo?.play().catch(() => {});
  }
}

function getIframe(): HTMLIFrameElement | null {
  return document.getElementById(IFRAME_ID) as HTMLIFrameElement | null;
}

function postToPlayer(message: AdFreeBridgeToPlayer) {
  const elIframe = getIframe();
  elIframe?.contentWindow?.postMessage(message, "*");
}

function waitForBridgeMessage<T extends AdFreeBridgeFromPlayer>(
  predicate: (message: AdFreeBridgeFromPlayer) => message is T,
  timeoutMs = BRIDGE_TIMEOUT_MS
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Ad-Free player bridge timeout"));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (!isBridgeMessage(event.data)) {
        return;
      }
      const message = event.data as AdFreeBridgeFromPlayer;
      if (!predicate(message)) {
        return;
      }
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(message);
    }

    window.addEventListener("message", onMessage);
  });
}

async function requestPlayerSnapshot(videoId: string): Promise<AdFreePlaybackSnapshot | null> {
  const elIframe = getIframe();
  if (!elIframe?.contentWindow) {
    return lastSnapshot?.videoId === videoId ? lastSnapshot : null;
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const response = await new Promise<AdFreePlaybackSnapshot>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("get-state timeout"));
      }, BRIDGE_TIMEOUT_MS);

      function onMessage(event: MessageEvent) {
        if (!isBridgeMessage(event.data)) {
          return;
        }
        const message = event.data as AdFreeBridgeFromPlayer;
        if (message.action !== "state" || message.requestId !== requestId) {
          return;
        }
        if (!isValidSnapshot(message.snapshot)) {
          return;
        }
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(message.snapshot);
      }

      window.addEventListener("message", onMessage);
      postToPlayer({
        type: AD_FREE_BRIDGE_TYPE,
        action: "get-state",
        requestId
      });
    });

    lastSnapshot = response;
    return response;
  } catch {
    return lastSnapshot?.videoId === videoId ? lastSnapshot : null;
  }
}

async function pushSnapshotToPlayer(
  snapshot: AdFreePlaybackSnapshot,
  forcePause: boolean
): Promise<void> {
  lastSnapshot = snapshot;
  const elIframe = getIframe();
  if (!elIframe?.contentWindow) {
    return;
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  postToPlayer({
    type: AD_FREE_BRIDGE_TYPE,
    action: "set-state",
    requestId,
    snapshot,
    forcePause
  });

  // Best-effort wait; don't block forever if player is still loading
  try {
    await waitForBridgeMessage(
      (message): message is Extract<AdFreeBridgeFromPlayer, { action: "set-state-done" }> =>
        message.action === "set-state-done"
        && (!message.requestId || message.requestId === requestId),
      2_500
    );
  } catch {
    // ignore
  }
}

function getPark(): HTMLElement {
  let elPark = document.getElementById(PARK_ID);
  if (!elPark) {
    elPark = document.createElement("div");
    elPark.id = PARK_ID;
    elPark.setAttribute("aria-hidden", "true");
    // Prefer html over body — body can be rebuilt less often than movie_player, html even less
    (document.documentElement ?? document.body).append(elPark);
  }
  return elPark;
}

function hideOverlayKeepAlive() {
  const elOverlay = document.getElementById(OVERLAY_ID);
  if (elOverlay) {
    elOverlay.classList.add(HOST_HIDDEN_CLASS);
    // Move out of #movie_player so YouTube SPA/player re-renders cannot drop the iframe
    getPark().append(elOverlay);
  }
  document.querySelectorAll(`.${HOST_ACTIVE_CLASS}`).forEach(el => {
    el.classList.remove(HOST_ACTIVE_CLASS);
  });
}

function showOverlay(elHost: HTMLElement) {
  const elOverlay = document.getElementById(OVERLAY_ID);
  if (!elOverlay) {
    return;
  }
  elOverlay.classList.remove(HOST_HIDDEN_CLASS);
  // Always re-attach to the live player host (may be a new node after YT re-render)
  elHost.append(elOverlay);
  elHost.classList.add(HOST_ACTIVE_CLASS);
}

function destroyOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
  document.getElementById(PARK_ID)?.remove();
  document.querySelectorAll(`.${HOST_ACTIVE_CLASS}`).forEach(el => {
    el.classList.remove(HOST_ACTIVE_CLASS);
  });
  isPlayerReady = false;
}

/**
 * Returns true only when a brand-new iframe was created (full load).
 * Same videoId reuses the parked keep-alive iframe — no reload.
 */
function ensureOverlay(videoId: string, elHost: HTMLElement, startAt = 0): boolean {
  const elExistingOverlay = document.getElementById(OVERLAY_ID);
  const elExistingIframe = getIframe();

  if (elExistingOverlay && elExistingIframe?.dataset.videoId === videoId) {
    // Keep-alive hit: never touch iframe.src
    showOverlay(elHost);
    return false;
  }

  if (elExistingOverlay || elExistingIframe) {
    // Different video (or broken pair): tear down and recreate
    destroyOverlay();
  }

  const elOverlay = document.createElement("div");
  elOverlay.id = OVERLAY_ID;

  const elIframe = document.createElement("iframe");
  elIframe.id = IFRAME_ID;
  elIframe.dataset.videoId = videoId;
  elIframe.allow = "autoplay; fullscreen; picture-in-picture";
  elIframe.allowFullscreen = true;
  // Only set src on first create for this videoId
  elIframe.src = browser.runtime.getURL(
    `/${AD_FREE_PLAYER_PATH}?v=${encodeURIComponent(videoId)}&embed=1&t=${encodeURIComponent(String(startAt))}&paused=1` as `/ad-free-player.html${string}`
  );

  elOverlay.append(elIframe);
  elHost.append(elOverlay);
  elHost.classList.add(HOST_ACTIVE_CLASS);
  isPlayerReady = false;
  return true;
}

async function waitForPlayerReady(videoId: string, timeoutMs = BRIDGE_TIMEOUT_MS) {
  if (isPlayerReady && activeVideoId === videoId) {
    return;
  }

  try {
    await waitForBridgeMessage(
      (message): message is Extract<AdFreeBridgeFromPlayer, { action: "ready" }> =>
        message.action === "ready" && message.videoId === videoId,
      timeoutMs
    );
    isPlayerReady = true;
  } catch {
    // Player may already be interactive even without ready event
  }
}

async function mergePageCaptions(payload: AdFreeStreamPayload): Promise<AdFreeStreamPayload> {
  if (payload.captions.length > 0) {
    return payload;
  }

  const pageCaptions = extractCaptionsFromDocument();
  if (pageCaptions.length === 0) {
    return payload;
  }

  const next: AdFreeStreamPayload = {
    ...payload,
    captions: pageCaptions
  };
  await browser.storage.session.set({
    [adFreeStreamStorageKey(payload.videoId)]: next
  });
  return next;
}

async function enableAdFree(elButton: HTMLButtonElement) {
  const videoId = getVideoId();
  const elHost = getPlayerHost();
  if (!videoId || !elHost) {
    return;
  }

  elButton.disabled = true;
  setButtonContent(elButton, "Loading...", { withDot: false, isActive: false });

  try {
    // Capture YT state first (while still current)
    const ytSnapshot = captureYouTubeSnapshot(videoId);
    lastSnapshot = ytSnapshot;

    // Pause YT immediately on switch
    pauseYouTubePlayer();

    await persistVisitorData();

    const existingIframe = getIframe();
    const isKeepAliveSameVideo = existingIframe?.dataset.videoId === videoId;

    // Resolve streams only when first creating the overlay / video changes
    if (!isKeepAliveSameVideo) {
      const payload = await sendMessage(MessageType.ResolveAdFreeStream, { videoId });
      await mergePageCaptions(payload);
    }

    // Remember video before ensureOverlay so keep-alive checks stay consistent
    activeVideoId = videoId;

    const created = ensureOverlay(videoId, elHost, ytSnapshot.currentTime);
    showOverlay(elHost);

    if (created) {
      await waitForPlayerReady(videoId);
      // Fresh load: apply full snapshot (time from YT)
      await pushSnapshotToPlayer({
        ...ytSnapshot,
        wasPlaying: false
      }, true);
    } else {
      // Keep-alive reuse: never reload iframe.src
      const adFreeSnapshot = await requestPlayerSnapshot(videoId);
      const adFreeTime = adFreeSnapshot?.currentTime ?? ytSnapshot.currentTime;
      const timeDelta = Math.abs(ytSnapshot.currentTime - adFreeTime);
      if (timeDelta > SEEK_EPSILON_SEC) {
        // User scrubbed / watched further on YT — sync position only
        await pushSnapshotToPlayer({
          ...ytSnapshot,
          wasPlaying: false
        }, true);
      } else {
        // Same place — pause only, no seek (avoids a visible "refresh")
        postToPlayer({ type: AD_FREE_BRIDGE_TYPE, action: "pause" });
      }
    }

    isAdFreeActive = true;
    setButtonContent(elButton, "YouTube", { isActive: true });
    elButton.disabled = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ytdl-ad-free]", message);
    // Keep keep-alive overlay if it existed; park it, do not destroy
    hideOverlayKeepAlive();
    isAdFreeActive = false;
    setButtonContent(elButton, "Failed — retry", { withDot: false, isActive: false });
    setTimeout(() => {
      if (!isAdFreeActive) {
        setButtonContent(elButton, "Ad-Free", { isActive: false });
        elButton.disabled = false;
      }
    }, 2500);
  }
}

async function disableAdFree(elButton?: HTMLButtonElement | null) {
  const videoId = getVideoId() ?? activeVideoId;
  elButton ??= document.getElementById(BUTTON_ID) as HTMLButtonElement | null;

  if (elButton) {
    elButton.disabled = true;
    setButtonContent(elButton, "Switching...", { withDot: false, isActive: true });
  }

  // Pull state from ad-free player, force pause there
  let snapshot = videoId ? await requestPlayerSnapshot(videoId) : null;
  postToPlayer({ type: AD_FREE_BRIDGE_TYPE, action: "pause" });

  if (!snapshot && lastSnapshot && (!videoId || lastSnapshot.videoId === videoId)) {
    snapshot = lastSnapshot;
  }

  hideOverlayKeepAlive();
  isAdFreeActive = false;

  if (snapshot && videoId && snapshot.videoId === videoId) {
    // Restore time on YT and stay paused on switch
    applyYouTubeSnapshot({
      ...snapshot,
      wasPlaying: false
    }, true);
    lastSnapshot = {
      ...snapshot,
      wasPlaying: false
    };
  } else {
    pauseYouTubePlayer();
  }

  if (elButton) {
    setButtonContent(elButton, "Ad-Free", { isActive: false });
    elButton.disabled = false;
  }
}

function resetForNavigation() {
  isAdFreeActive = false;
  activeVideoId = null;
  lastSnapshot = null;
  isPlayerReady = false;
  destroyOverlay();
  const elButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (elButton) {
    setButtonContent(elButton, "Ad-Free", { isActive: false });
    elButton.disabled = false;
  }
}

async function toggleAdFree(elButton: HTMLButtonElement) {
  if (isAdFreeActive) {
    await disableAdFree(elButton);
    return;
  }
  await enableAdFree(elButton);
}

function removeButton() {
  document.getElementById(BUTTON_ID)?.remove();
}

function createButton(): HTMLButtonElement {
  const elButton = document.createElement("button");
  elButton.id = BUTTON_ID;
  elButton.type = "button";
  setButtonContent(elButton, "Ad-Free", { isActive: false });

  const stopPlayerClick = (e: Event) => {
    e.stopPropagation();
  };

  elButton.addEventListener("mousedown", stopPlayerClick);
  elButton.addEventListener("mouseup", stopPlayerClick);
  elButton.addEventListener("pointerdown", stopPlayerClick);
  elButton.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    void toggleAdFree(elButton);
  });

  return elButton;
}

function injectButton(): boolean {
  if (!getVideoId()) {
    resetForNavigation();
    removeButton();
    return false;
  }

  const elHost = getPlayerHost();
  if (!elHost) {
    return false;
  }

  ensureStyles();

  const hostStyle = getComputedStyle(elHost);
  if (hostStyle.position === "static") {
    elHost.style.position = "relative";
  }

  // If Ad-Free is active, keep overlay on the live host.
  // If inactive, leave overlay parked (do NOT move it back under movie_player).
  const elOverlay = document.getElementById(OVERLAY_ID);
  if (isAdFreeActive) {
    if (elOverlay) {
      showOverlay(elHost);
    }
  }

  const elExisting = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (elExisting) {
    if (elExisting.parentElement !== elHost) {
      elHost.append(elExisting);
    }
    if (isAdFreeActive && activeVideoId === getVideoId()) {
      setButtonContent(elExisting, "YouTube", { isActive: true });
    }
    return true;
  }

  const elButton = createButton();
  if (isAdFreeActive && activeVideoId === getVideoId()) {
    setButtonContent(elButton, "YouTube", { isActive: true });
  }
  elHost.append(elButton);
  return true;
}

function waitForButtonTarget() {
  if (injectButton()) {
    return;
  }

  const observer = new MutationObserver(() => {
    if (injectButton()) {
      observer.disconnect();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), OBSERVER_DISCONNECT_MS);
}

function onWatchNavigation() {
  void persistVisitorData();
  const videoId = getVideoId();
  if (!videoId || (activeVideoId && videoId !== activeVideoId)) {
    resetForNavigation();
  }
  removeButton();
  waitForButtonTarget();
}

function onBridgeFromPlayer(event: MessageEvent) {
  if (!isBridgeMessage(event.data)) {
    return;
  }
  const message = event.data as AdFreeBridgeFromPlayer;
  if (message.action === "ready") {
    if (message.videoId === getVideoId() || message.videoId === activeVideoId) {
      isPlayerReady = true;
    }
  }
  if (message.action === "state" && isValidSnapshot(message.snapshot)) {
    lastSnapshot = message.snapshot;
  }
}

export default defineContentScript({
  matches: ["https://www.youtube.com/*"],
  runAt: "document_idle",
  main(ctx) {
    window.addEventListener("message", onBridgeFromPlayer);

    onWatchNavigation();

    ctx.addEventListener(window, "wxt:locationchange", () => {
      onWatchNavigation();
    });

    document.addEventListener("yt-navigate-finish", () => {
      onWatchNavigation();
    });
  }
});
