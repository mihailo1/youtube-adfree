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
const ROOT_ID = "ytdl-ad-free-root";
const OVERLAY_ID = "ytdl-ad-free-overlay";
const IFRAME_ID = "ytdl-ad-free-iframe";
const HOST_ACTIVE_CLASS = "ytdl-ad-free-active";
const ROOT_ACTIVE_CLASS = "is-active";
const OBSERVER_DISCONNECT_MS = 30_000;
const BRIDGE_TIMEOUT_MS = 4_000;
const SEEK_EPSILON_SEC = 0.75;

/**
 * IMPORTANT: Never reparent the iframe.
 * Moving an <iframe> in the DOM reloads its document in Chromium, which looks
 * like the Ad-Free video "refreshed" on every toggle. The root stays on
 * documentElement; we only change CSS (position/size/visibility).
 */
const BUTTON_CSS = `
#${BUTTON_ID} {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 3;
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

/* Stable shell: never reparented; only bounds + visibility change */
#${ROOT_ID} {
  position: fixed;
  z-index: 2147483000;
  margin: 0;
  padding: 0;
  border: 0;
  box-sizing: border-box;
  pointer-events: none;
  overflow: visible;
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
let layoutRafId = 0;
let layoutListening = false;

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

function getRoot(): HTMLElement | null {
  return document.getElementById(ROOT_ID);
}

function postToPlayer(message: AdFreeBridgeToPlayer) {
  getIframe()?.contentWindow?.postMessage(message, "*");
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
  if (!getIframe()?.contentWindow) {
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

function syncRootLayout() {
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
  elRoot.style.top = `${Math.round(rect.top)}px`;
  elRoot.style.left = `${Math.round(rect.left)}px`;
  elRoot.style.width = `${Math.round(rect.width)}px`;
  elRoot.style.height = `${Math.round(rect.height)}px`;
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

function startLayoutTracking() {
  if (layoutListening) {
    return;
  }
  layoutListening = true;
  window.addEventListener("resize", scheduleLayoutSync, true);
  window.addEventListener("scroll", scheduleLayoutSync, true);
  // YouTube theater / fullscreen / flex layout
  document.addEventListener("yt-action", scheduleLayoutSync, true);
  document.addEventListener("fullscreenchange", scheduleLayoutSync, true);
}

function stopLayoutTracking() {
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

function setHostActive(isActive: boolean) {
  document.querySelectorAll(`.${HOST_ACTIVE_CLASS}`).forEach(el => {
    el.classList.remove(HOST_ACTIVE_CLASS);
  });
  if (!isActive) {
    return;
  }
  const elHost = getPlayerHost();
  elHost?.classList.add(HOST_ACTIVE_CLASS);
}

function hideOverlayKeepAlive() {
  const elRoot = getRoot();
  elRoot?.classList.remove(ROOT_ACTIVE_CLASS);
  setHostActive(false);
  // Keep root sized over the player so the toggle button still sits on the video
  syncRootLayout();
}

function showOverlayActive() {
  const elRoot = getRoot();
  if (!elRoot) {
    return;
  }
  elRoot.classList.add(ROOT_ACTIVE_CLASS);
  setHostActive(true);
  syncRootLayout();
}

function destroyOverlay() {
  stopLayoutTracking();
  document.getElementById(ROOT_ID)?.remove();
  setHostActive(false);
  isPlayerReady = false;
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

/**
 * Ensure stable root + iframe exist. Returns true only on first iframe create.
 * Never reparents the iframe after creation.
 */
function ensureOverlay(videoId: string, startAt = 0): boolean {
  ensureStyles();
  startLayoutTracking();

  let elRoot = getRoot();
  let elIframe = getIframe();
  let elOverlay = document.getElementById(OVERLAY_ID);
  let elButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;

  // Same video keep-alive: only toggle CSS
  if (elRoot && elIframe?.dataset.videoId === videoId && elOverlay) {
    if (!elButton) {
      elRoot.append(createButton());
    }
    syncRootLayout();
    return false;
  }

  // Different video: full recreate allowed
  if (elRoot && elIframe && elIframe.dataset.videoId !== videoId) {
    destroyOverlay();
    elRoot = null;
    elIframe = null;
    elOverlay = null;
    elButton = null;
  }

  if (!elRoot) {
    elRoot = document.createElement("div");
    elRoot.id = ROOT_ID;
    document.documentElement.append(elRoot);
  }

  if (!elOverlay) {
    elOverlay = document.createElement("div");
    elOverlay.id = OVERLAY_ID;
    elRoot.append(elOverlay);
  }

  let didCreateIframe = false;
  if (!elIframe) {
    elIframe = document.createElement("iframe");
    elIframe.id = IFRAME_ID;
    elIframe.dataset.videoId = videoId;
    elIframe.allow = "autoplay; fullscreen; picture-in-picture";
    elIframe.allowFullscreen = true;
    // Set src exactly once per videoId lifetime of this iframe node
    elIframe.src = browser.runtime.getURL(
      `/${AD_FREE_PLAYER_PATH}?v=${encodeURIComponent(videoId)}&embed=1&t=${encodeURIComponent(String(startAt))}&paused=1` as `/ad-free-player.html${string}`
    );
    elOverlay.append(elIframe);
    isPlayerReady = false;
    didCreateIframe = true;
  }

  if (!document.getElementById(BUTTON_ID)) {
    elRoot.append(createButton());
  }

  syncRootLayout();
  return didCreateIframe;
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
    // ignore
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
  if (!videoId || !getPlayerHost()) {
    return;
  }

  elButton.disabled = true;
  setButtonContent(elButton, "Loading...", { withDot: false, isActive: false });

  try {
    const ytSnapshot = captureYouTubeSnapshot(videoId);
    lastSnapshot = ytSnapshot;
    pauseYouTubePlayer();
    await persistVisitorData();

    const existingIframe = getIframe();
    const isKeepAliveSameVideo = existingIframe?.dataset.videoId === videoId;

    if (!isKeepAliveSameVideo) {
      const payload = await sendMessage(MessageType.ResolveAdFreeStream, { videoId });
      await mergePageCaptions(payload);
    }

    activeVideoId = videoId;
    const created = ensureOverlay(videoId, ytSnapshot.currentTime);
    showOverlayActive();

    // Refresh button ref (lives on root, not host)
    const elLiveButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null ?? elButton;

    if (created || !isKeepAliveSameVideo) {
      await waitForPlayerReady(videoId);
      await pushSnapshotToPlayer({
        ...ytSnapshot,
        wasPlaying: false
      }, true);
    } else {
      // Reuse warm iframe: never touch src; avoid seek if times match
      const adFreeSnapshot = await requestPlayerSnapshot(videoId);
      const adFreeTime = adFreeSnapshot?.currentTime ?? ytSnapshot.currentTime;
      const timeDelta = Math.abs(ytSnapshot.currentTime - adFreeTime);
      if (timeDelta > SEEK_EPSILON_SEC) {
        await pushSnapshotToPlayer({
          ...ytSnapshot,
          wasPlaying: false
        }, true);
      } else {
        postToPlayer({ type: AD_FREE_BRIDGE_TYPE, action: "pause" });
      }
    }

    isAdFreeActive = true;
    setButtonContent(elLiveButton, "YouTube", { isActive: true });
    elLiveButton.disabled = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ytdl-ad-free]", message);
    hideOverlayKeepAlive();
    isAdFreeActive = false;
    const elLiveButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null ?? elButton;
    setButtonContent(elLiveButton, "Failed — retry", { withDot: false, isActive: false });
    setTimeout(() => {
      if (!isAdFreeActive) {
        setButtonContent(elLiveButton, "Ad-Free", { isActive: false });
        elLiveButton.disabled = false;
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

  let snapshot = videoId ? await requestPlayerSnapshot(videoId) : null;
  postToPlayer({ type: AD_FREE_BRIDGE_TYPE, action: "pause" });

  if (!snapshot && lastSnapshot && (!videoId || lastSnapshot.videoId === videoId)) {
    snapshot = lastSnapshot;
  }

  // Hide overlay only — do not reparent or destroy iframe
  hideOverlayKeepAlive();
  isAdFreeActive = false;

  if (snapshot && videoId && snapshot.videoId === videoId) {
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

  const elLiveButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null ?? elButton;
  if (elLiveButton) {
    setButtonContent(elLiveButton, "Ad-Free", { isActive: false });
    elLiveButton.disabled = false;
  }
}

function resetForNavigation() {
  isAdFreeActive = false;
  activeVideoId = null;
  lastSnapshot = null;
  isPlayerReady = false;
  destroyOverlay();
}

async function toggleAdFree(elButton: HTMLButtonElement) {
  if (isAdFreeActive) {
    await disableAdFree(elButton);
    return;
  }
  await enableAdFree(elButton);
}

function ensureUiShell() {
  if (!getVideoId()) {
    resetForNavigation();
    return false;
  }

  if (!getPlayerHost()) {
    return false;
  }

  ensureStyles();
  startLayoutTracking();

  // Keep warm root/button even before first Ad-Free open (button must be visible)
  if (!getRoot()) {
    const elRoot = document.createElement("div");
    elRoot.id = ROOT_ID;
    document.documentElement.append(elRoot);
    elRoot.append(createButton());
  } else if (!document.getElementById(BUTTON_ID)) {
    getRoot()?.append(createButton());
  }

  syncRootLayout();

  const elButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (elButton) {
    if (isAdFreeActive && activeVideoId === getVideoId()) {
      setButtonContent(elButton, "YouTube", { isActive: true });
      showOverlayActive();
    } else if (!isAdFreeActive) {
      setButtonContent(elButton, "Ad-Free", { isActive: false });
      hideOverlayKeepAlive();
    }
  }

  return true;
}

function waitForButtonTarget() {
  if (ensureUiShell()) {
    return;
  }

  const observer = new MutationObserver(() => {
    if (ensureUiShell()) {
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
