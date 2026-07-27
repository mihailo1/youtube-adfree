import {
  AD_FREE_BRIDGE_TYPE,
  type AdFreeBridgeFromPlayer,
  type AdFreePlaybackSnapshot,
  isBridgeMessage,
  isValidSnapshot
} from "@/lib/ad-free/bridge";
import { extractCaptionsFromDocument } from "@/lib/ad-free/captions";
import { AD_FREE_VISITOR_DATA_KEY } from "@/lib/ad-free/constants";
import {
  BUTTON_ID,
  OBSERVER_DISCONNECT_MS,
  BRIDGE_TIMEOUT_MS,
  getVideoId,
  getPlayerHost,
  getIframe,
  getRoot
} from "@/lib/ad-free/content-dom";
import {
  postToPlayer,
  waitForBridgeMessage,
  requestPlayerSnapshot,
  pushSnapshotToPlayer
} from "@/lib/ad-free/content-bridge-client";
import {
  captureYouTubeSnapshot,
  pauseYouTubePlayer
} from "@/lib/ad-free/content-yt-snapshot";
import {
  ensureStyles,
  setButtonContents,
  createButton,
  ensureOverlay,
  destroyOverlay,
  startLayoutTracking,
  syncRootLayout,
  showOverlayActive,
  hideOverlayKeepAlive
} from "@/lib/ad-free/content-overlay";
import {
  type AdFreeStreamPayload,
  adFreeStreamStorageKey
} from "@/lib/ad-free/resolve-stream";
import { extractChaptersFromDocument } from "@/lib/ad-free/chapters";
import { extractStoryboardSpecFromDocument } from "@/lib/ad-free/storyboard";
import { extractVisitorDataFromDocument } from "@/lib/ad-free/visitor-data";
import { createAdFreeLogger } from "@/lib/ad-free/debug-log";
import { createYouTubeParkController } from "@/lib/ad-free/youtube-park";
import {
  getAdFreeDefaultEnabled,
  watchAdFreeDefaultEnabled
} from "@/lib/ad-free/default-pref";
import { MessageType, sendMessage } from "@/lib/messaging/messaging";

const log = createAdFreeLogger("watch");

let isAdFreeActive = false;
let activeVideoId: string | null = null;
let isPlayerReady = false;
let lastSnapshot: AdFreePlaybackSnapshot | null = null;
/** Prefer Ad-Free on every watch page when user enabled the setting. */
let isAdFreeDefault = false;
/** One auto-enable attempt per videoId (manual switch-back stays until next video). */
let autoEnableForVideoId: string | null = null;
let isAutoEnabling = false;
const youtubePark = createYouTubeParkController();

async function persistVisitorData() {
  const visitorData = extractVisitorDataFromDocument();
  if (!visitorData) {
    return;
  }

  try {
    await browser.storage.local.set({ [AD_FREE_VISITOR_DATA_KEY]: visitorData });
  } catch (error) {
    log.warn("persistVisitorData failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Persist stream payload for the player iframe.
 * Always go through the background — content scripts cannot reliably use
 * chrome.storage.session without setAccessLevel (and users must never open DevTools).
 */
async function storePayloadInSession(payload: AdFreeStreamPayload) {
  try {
    await sendMessage(MessageType.StoreAdFreeStreamPayload, { payload });
    return;
  } catch (bgError) {
    // Fallback: direct session write if BG setAccessLevel already ran
    try {
      await browser.storage.session.set({
        [adFreeStreamStorageKey(payload.videoId)]: payload
      });
      return;
    } catch (sessionError) {
      log.warn("could not store ad-free payload", {
        bg: bgError instanceof Error ? bgError.message : String(bgError),
        session: sessionError instanceof Error ? sessionError.message : String(sessionError)
      });
    }
  }
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
  await storePayloadInSession(next);
  return next;
}

/** Prefer ANDROID_VR storyboard; fall back to ytInitialPlayerResponse on the watch page. */
async function mergePageStoryboard(payload: AdFreeStreamPayload): Promise<AdFreeStreamPayload> {
  if (payload.storyboardSpec) {
    return payload;
  }

  const pageSpec = extractStoryboardSpecFromDocument();
  if (!pageSpec) {
    log.debug("no page storyboard spec either");
    return payload;
  }

  log.info("merged storyboard from watch page");
  const next: AdFreeStreamPayload = {
    ...payload,
    storyboardSpec: pageSpec
  };
  await storePayloadInSession(next);
  return next;
}

/**
 * Prefer chapters already on the stream payload; otherwise pull markersMap /
 * engagementPanels from ytInitialData on the watch page (ANDROID_VR rarely has them).
 */
async function mergePageChapters(payload: AdFreeStreamPayload): Promise<AdFreeStreamPayload> {
  if (payload.chapters.length >= 2) {
    return payload;
  }

  const pageChapters = extractChaptersFromDocument(
    document,
    payload.durationSeconds > 0 ? payload.durationSeconds : 0
  );
  if (pageChapters.length < 2) {
    log.debug("no page chapters either");
    return payload;
  }

  log.info("merged chapters from watch page", {
    count: pageChapters.length,
    first: pageChapters[0]?.title?.slice(0, 60)
  });
  const next: AdFreeStreamPayload = {
    ...payload,
    chapters: pageChapters
  };
  await storePayloadInSession(next);
  return next;
}

async function enableAdFree(elButton: HTMLButtonElement) {
  const videoId = getVideoId();
  if (!videoId || !getPlayerHost()) {
    log.warn("enable skipped — no video/host");
    return;
  }

  log.info("enable", { videoId });
  elButton.disabled = true;
  setButtonContents(elButton, "Loading...", { withDot: false, isActive: false });

  try {
    const ytSnapshot = captureYouTubeSnapshot(videoId);
    lastSnapshot = ytSnapshot;
    log.debug("yt snapshot", ytSnapshot);
    pauseYouTubePlayer();
    youtubePark.park();
    await persistVisitorData();

    const existingIframe = getIframe();
    const isKeepAliveSameVideo = existingIframe?.dataset.videoId === videoId;

    if (!isKeepAliveSameVideo) {
      log.info("resolve stream");
      let payload = await sendMessage(MessageType.ResolveAdFreeStream, { videoId });
      payload = await mergePageCaptions(payload);
      payload = await mergePageStoryboard(payload);
      payload = await mergePageChapters(payload);
      log.info("stream resolved", {
        selected: payload.selectedQualityId,
        qualities: payload.qualities.map(item => item.label),
        storyboard: Boolean(payload.storyboardSpec),
        chapters: payload.chapters.length
      });
    } else {
      log.info("reuse keep-alive iframe");
    }

    activeVideoId = videoId;
    const created = ensureOverlay(videoId, ytSnapshot.currentTime, {
      onDestroy: () => void toggleAdFree(),
      onIframeCreated() { isPlayerReady = false; }
    });
    showOverlayActive();
    // Keep park enforced while overlay is active
    youtubePark.park();

    const elLiveButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null ?? elButton;

    if (created || !isKeepAliveSameVideo) {
      await waitForPlayerReady(videoId);
      log.info("player ready", { isPlayerReady });
    }
    // Preserve play/pause intent from YouTube (and keep-alive ad-free buffers).
    // Do not force-pause: round-trip original ↔ ad-free should resume if it was playing.
    await pushSnapshotToPlayer(ytSnapshot, false);

    isAdFreeActive = true;
    // Free original player memory once Ad-Free owns playback
    youtubePark.unload();
    // Fresh enable: controls start visible until player reports idle
    getRoot()?.classList.remove("is-controls-hidden");
    setButtonContents(elLiveButton, "YouTube", { isActive: true });
    elLiveButton.disabled = false;
    log.info("enable done");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("enable failed", { message });
    console.error("[ytdl-ad-free]", message);
    youtubePark.unpark();
    hideOverlayKeepAlive();
    isAdFreeActive = false;
    const elLiveButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null ?? elButton;
    setButtonContents(elLiveButton, "Failed — retry", { withDot: false, isActive: false });
    setTimeout(() => {
      if (!isAdFreeActive) {
        setButtonContents(elLiveButton, "Ad-Free", { isActive: false });
        elLiveButton.disabled = false;
      }
    }, 2500);
  }
}

async function disableAdFree(elButton?: HTMLButtonElement | null) {
  const videoId = getVideoId() ?? activeVideoId;
  log.info("disable", { videoId });
  elButton ??= document.getElementById(BUTTON_ID) as HTMLButtonElement | null;

  if (elButton) {
    elButton.disabled = true;
    setButtonContents(elButton, "Switching...", { withDot: false, isActive: true });
  }

  // Capture ad-free state *before* pause so wasPlaying / time / volume survive the round-trip
  let snapshot = videoId ? await requestPlayerSnapshot(videoId, lastSnapshot) : null;
  postToPlayer({ type: AD_FREE_BRIDGE_TYPE, action: "pause" });

  if (!snapshot && lastSnapshot && (!videoId || lastSnapshot.videoId === videoId)) {
    snapshot = lastSnapshot;
  }
  log.debug("disable snapshot", snapshot);

  hideOverlayKeepAlive();
  isAdFreeActive = false;
  getRoot()?.classList.remove("is-controls-hidden");
  // Don't re-auto-enable on this video if default is on (user chose YouTube)
  if (videoId) {
    autoEnableForVideoId = videoId;
  }

  if (snapshot && videoId && snapshot.videoId === videoId) {
    lastSnapshot = snapshot;
    // Restores media after unload (or soft park) at ad-free position/intent
    youtubePark.reload(videoId, snapshot.currentTime, {
      play: snapshot.wasPlaying,
      volume: snapshot.volume,
      muted: snapshot.muted,
      playbackRate: snapshot.playbackRate
    });
  } else {
    youtubePark.unpark();
    pauseYouTubePlayer();
  }

  const elLiveButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null ?? elButton;
  if (elLiveButton) {
    setButtonContents(elLiveButton, "Ad-Free", { isActive: false });
    elLiveButton.disabled = false;
  }
}

function resetForNavigation() {
  log.info("reset navigation");
  isAdFreeActive = false;
  activeVideoId = null;
  lastSnapshot = null;
  isPlayerReady = false;
  autoEnableForVideoId = null;
  isAutoEnabling = false;
  youtubePark.unpark();
  destroyOverlay();
}

async function toggleAdFree(elButton?: HTMLButtonElement | null) {
  if (!elButton) {
    elButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  }
  if (!elButton) {
    return;
  }
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

  if (!getRoot()) {
    const elRoot = document.createElement("div");
    elRoot.id = "ytdl-ad-free-root";
    document.documentElement.append(elRoot);
    elRoot.append(createButton(() => void toggleAdFree()));
  } else if (!document.getElementById(BUTTON_ID)) {
    getRoot()?.append(createButton(() => void toggleAdFree()));
  }

  syncRootLayout();

  const elButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (elButton) {
    if (isAdFreeActive && activeVideoId === getVideoId()) {
      setButtonContents(elButton, "YouTube", { isActive: true });
      showOverlayActive();
    } else if (!isAdFreeActive) {
      setButtonContents(elButton, "Ad-Free", { isActive: false });
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

/**
 * When "Always Ad-Free" is on, enable as soon as the watch host exists.
 * Skips if user already switched back to YouTube for this videoId.
 */
async function tryAutoEnableAdFree() {
  if (!isAdFreeDefault || isAdFreeActive || isAutoEnabling) {
    return;
  }
  const videoId = getVideoId();
  if (!videoId) {
    return;
  }
  // User already opted back to YouTube (or we finished enable) for this id
  if (autoEnableForVideoId === videoId) {
    return;
  }
  isAutoEnabling = true;
  log.info("auto-enable (default on)", { videoId });
  try {
    if (!ensureUiShell()) {
      waitForButtonTarget();
      for (let attempt = 0; attempt < 25 && (!getPlayerHost() || !document.getElementById(BUTTON_ID)); attempt += 1) {
        await new Promise<void>(resolve => {
          window.setTimeout(resolve, 120);
        });
        ensureUiShell();
      }
    }
    const elButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
    if (!elButton || !getPlayerHost()) {
      log.warn("auto-enable deferred — host/button not ready");
      return;
    }
    // Mark before enable so a parallel nav/toggle cannot double-fire
    autoEnableForVideoId = videoId;
    await enableAdFree(elButton);
  } catch (error) {
    // Allow retry on next navigation if enable failed
    if (autoEnableForVideoId === videoId && !isAdFreeActive) {
      autoEnableForVideoId = null;
    }
    log.warn("auto-enable failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    isAutoEnabling = false;
  }
}

function onWatchNavigation() {
  void persistVisitorData();
  const videoId = getVideoId();
  if (!videoId || (activeVideoId && videoId !== activeVideoId)) {
    resetForNavigation();
  }
  waitForButtonTarget();
  if (isAdFreeDefault && videoId && autoEnableForVideoId !== videoId) {
    void tryAutoEnableAdFree();
  }
}

function onBridgeFromPlayer(event: MessageEvent) {
  if (event.source !== getIframe()?.contentWindow) {
    return;
  }
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
  if (message.action === "controls-visible") {
    // Only hide top chip while ad-free overlay is active (quality menu hides inside iframe)
    const elRoot = getRoot();
    if (!elRoot || !isAdFreeActive) {
      return;
    }
    elRoot.classList.toggle("is-controls-hidden", !message.visible);
  }
}

export default defineContentScript({
  matches: ["https://www.youtube.com/*"],
  runAt: "document_idle",
  main(ctx) {
    window.addEventListener("message", onBridgeFromPlayer);

    void getAdFreeDefaultEnabled().then(enabled => {
      isAdFreeDefault = enabled;
      log.info("default pref loaded", { enabled });
      if (enabled) {
        void tryAutoEnableAdFree();
      }
    });

    const unwatchDefault = watchAdFreeDefaultEnabled(enabled => {
      const was = isAdFreeDefault;
      isAdFreeDefault = enabled;
      log.info("default pref changed", { enabled, was });
      if (enabled && !was && !isAdFreeActive) {
        // Newly enabled: clear skip so current video auto-enables once
        autoEnableForVideoId = null;
        void tryAutoEnableAdFree();
      }
    });
    ctx.onInvalidated(() => {
      unwatchDefault();
    });

    onWatchNavigation();

    ctx.addEventListener(window, "wxt:locationchange", () => {
      onWatchNavigation();
    });

    document.addEventListener("yt-navigate-finish", () => {
      onWatchNavigation();
    });
  }
});
