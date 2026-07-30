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
  OVERLAY_ID,
  getVideoId,
  getPlayerHost,
  getIframe,
  getRoot,
  isPlayerWatchPage
} from "@/lib/ad-free/content-dom";
import {
  postToPlayer,
  waitForBridgeMessage,
  requestPlayerSnapshot,
  pushSnapshotToPlayer
} from "@/lib/ad-free/content-bridge-client";
import { captureYouTubeSnapshot, isYouTubeShowingAd, pauseYouTubePlayer } from "@/lib/ad-free/content-yt-snapshot";
import {
  EARLY_HIDE_CLASS,
  ensureStyles,
  setButtonContents,
  createButton,
  ensureOverlay,
  destroyOverlay,
  startLayoutTracking,
  syncRootLayout,
  showOverlayActive,
  hideOverlayKeepAlive,
  setHostActive,
  showImmediateCover,
  installEarlyHideCss,
  removeEarlyHideCss
} from "@/lib/ad-free/content-overlay";
import {
  type AdFreeStreamPayload,
  adFreeStreamStorageKey
} from "@/lib/ad-free/resolve-stream";
import {
  chaptersFitDuration,
  extractChaptersFromDocument
} from "@/lib/ad-free/chapters";
import { extractStoryboardSpecFromDocument } from "@/lib/ad-free/storyboard";
import { extractVisitorDataFromDocument } from "@/lib/ad-free/visitor-data";
import {
  createAdFreeLogger,
  setAdFreeExtendedLogs
} from "@/lib/ad-free/debug-log";
import { createYouTubeParkController } from "@/lib/ad-free/youtube-park";
import {
  isYouTubeTheaterMode,
  toggleYouTubeTheaterMode,
  watchYouTubeTheaterMode
} from "@/lib/ad-free/youtube-theater";
import {
  getAdFreeDefaultEnabled,
  readAdFreeDefaultFromLocalCache,
  watchAdFreeDefaultEnabled,
  writeAdFreeDefaultLocalCache
} from "@/lib/ad-free/default-pref";
import { MessageType, sendMessage } from "@/lib/messaging/messaging";
import { optionsItem } from "@/lib/storage/storage";

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
/** Early cover applied once per navigation — prevents MO/log infinite loops. */
let hasEarlyCover = false;
let earlyCoverObserver: MutationObserver | null = null;
/** Scheduled Always Ad-Free resolve/enable retries after early 403 / CS-not-ready. */
let enableRetryTimer = 0;
let enableRetryCount = 0;
/** Peel black cover if enable never lands (Always Ad-Free stuck shell). */
let coverWatchdogTimer = 0;
let coverWatchdogRound = 0;
const youtubePark = createYouTubeParkController();

function pageSnap() {
  return {
    path: location.pathname,
    v: getVideoId(),
    host: Boolean(getPlayerHost()),
    earlyCover: hasEarlyCover,
    earlyHide: document.documentElement.classList.contains(EARLY_HIDE_CLASS),
    active: isAdFreeActive,
    iframe: Boolean(getIframe()),
    parked: youtubePark.isParked()
  };
}

function clearCoverWatchdog() {
  if (coverWatchdogTimer) {
    window.clearTimeout(coverWatchdogTimer);
    coverWatchdogTimer = 0;
  }
}

/**
 * Drop black cover / early-hide / park when Ad-Free is NOT owning playback.
 * Fixes stuck "black square over YT audio" when auto-enable never starts.
 */
function releaseCover(reason: string) {
  if (isAdFreeActive) {
    log.ext("release cover skipped (ad-free active)", { reason, ...pageSnap() });
    return;
  }
  const hadSomething = hasEarlyCover
    || document.documentElement.classList.contains(EARLY_HIDE_CLASS)
    || youtubePark.isParked()
    || Boolean(document.getElementById(OVERLAY_ID));
  clearCoverWatchdog();
  coverWatchdogRound = 0;
  hasEarlyCover = false;
  stopEarlyCoverObserver();
  removeEarlyHideCss();
  youtubePark.unpark();
  // Empty black shell (no player iframe yet)
  if (!getIframe()) {
    const elOverlay = document.getElementById(OVERLAY_ID);
    elOverlay?.remove();
    hideOverlayKeepAlive();
  } else {
    hideOverlayKeepAlive();
  }
  if (hadSomething) {
    log.info("released idle cover", { reason, ...pageSnap() });
  } else {
    log.ext("release cover noop", { reason, ...pageSnap() });
  }
}

function armCoverWatchdog(reason: string) {
  clearCoverWatchdog();
  // First tick 8s, second 12s then peel
  const delay = coverWatchdogRound === 0 ? 8_000 : 12_000;
  log.ext("cover watchdog armed", { reason, delay, round: coverWatchdogRound, ...pageSnap() });
  coverWatchdogTimer = window.setTimeout(() => {
    coverWatchdogTimer = 0;
    if (isAdFreeActive) {
      coverWatchdogRound = 0;
      return;
    }
    if (!isAdFreeDefault) {
      releaseCover("watchdog-pref-off");
      return;
    }
    const videoId = getVideoId();
    log.warn("cover watchdog fire", {
      reason,
      round: coverWatchdogRound,
      videoId,
      ...pageSnap()
    });
    if (videoId && coverWatchdogRound === 0) {
      coverWatchdogRound = 1;
      autoEnableForVideoId = null;
      isAutoEnabling = false;
      void tryAutoEnableAdFree();
      armCoverWatchdog("retry-after-timeout");
      return;
    }
    // Give up — show native YT rather than permanent black square
    releaseCover("watchdog-give-up");
  }, delay);
}

function sleep(ms: number) {
  return new Promise<void>(resolve => {
    window.setTimeout(resolve, ms);
  });
}

function isRetriableResolveError(message: string) {
  return /403|content script|Receiving end|Could not establish connection|no content script|try again/i
    .test(message);
}

/**
 * ANDROID_VR via page-proxy needs youtube.content (document_idle) + MAIN fetch bridge.
 * document_start auto-enable often races → 403. Retry with cover kept.
 */
async function resolveStreamWithRetry(videoId: string) {
  const delaysMs = [0, 350, 700, 1_200, 2_000, 3_500];
  let lastMessage = "resolve failed";
  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    if (delaysMs[attempt] > 0) {
      await sleep(delaysMs[attempt]);
    }
    // Keep black cover while waiting for proxy CS
    if (!hasEarlyCover) {
      applyEarlyCover(`resolve-wait-${attempt}`);
    } else {
      pauseYouTubePlayer();
      youtubePark.park();
    }
    try {
      const payload = await sendMessage(MessageType.ResolveAdFreeStream, { videoId });
      return payload;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      log.info("resolve attempt failed", { attempt, message: lastMessage.slice(0, 120) });
      if (!isRetriableResolveError(lastMessage)) {
        throw error instanceof Error ? error : new Error(lastMessage);
      }
    }
  }
  throw new Error(lastMessage);
}

function clearEnableRetry() {
  if (enableRetryTimer) {
    window.clearTimeout(enableRetryTimer);
    enableRetryTimer = 0;
  }
}

function scheduleEnableRetry(reason: string) {
  if (!isAdFreeDefault || isAdFreeActive) {
    return;
  }
  if (enableRetryCount >= 6) {
    log.warn("enable retry gave up", { reason, enableRetryCount });
    return;
  }
  clearEnableRetry();
  const delay = Math.min(4_000, 600 + enableRetryCount * 700);
  enableRetryCount += 1;
  log.info("enable retry scheduled", { reason, delay, attempt: enableRetryCount });
  // Allow tryAutoEnable / enable again
  autoEnableForVideoId = null;
  isAutoEnabling = false;
  enableRetryTimer = window.setTimeout(() => {
    enableRetryTimer = 0;
    if (isAdFreeActive || !isAdFreeDefault) {
      return;
    }
    void tryAutoEnableAdFree();
  }, delay);
}

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
 * Prefer chapters already on the stream payload; otherwise pull markers for
 * **this videoId only** from the watch page (ANDROID_VR rarely has them).
 *
 * Must scope by videoId: after SPA navigation, leftover ytInitialData from the
 * previous watch used to leak chapters into videos that have none.
 */
async function mergePageChapters(payload: AdFreeStreamPayload): Promise<AdFreeStreamPayload> {
  const videoId = payload.videoId;
  const duration = payload.durationSeconds > 0 ? payload.durationSeconds : 0;

  // Even if ANDROID_VR returned chapters, drop them when they don't fit this video
  // (defensive — wrong merge / cache pollution).
  if (payload.chapters.length >= 2) {
    if (chaptersFitDuration(payload.chapters, duration)) {
      return payload;
    }
    log.warn("dropping payload chapters that don't fit duration", {
      videoId,
      duration,
      count: payload.chapters.length,
      lastStart: payload.chapters[payload.chapters.length - 1]?.startSeconds
    });
  }

  const pageChapters = extractChaptersFromDocument(document, duration, videoId);
  if (pageChapters.length < 2) {
    log.debug("no page chapters either", { videoId });
    // Keep empty for now; scheduleLateChapterMerge will retry after YT panels hydrate
    if (payload.chapters.length > 0 && !chaptersFitDuration(payload.chapters, duration)) {
      const cleared: AdFreeStreamPayload = { ...payload, chapters: [] };
      await storePayloadInSession(cleared);
      return cleared;
    }
    return { ...payload, chapters: [] };
  }

  log.info("merged chapters from watch page", {
    videoId,
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

let lateChapterTimer = 0;

function clearLateChapterMerge() {
  if (lateChapterTimer) {
    window.clearTimeout(lateChapterTimer);
    lateChapterTimer = 0;
  }
}

/**
 * Always Ad-Free enables before engagement-panel / script chapters exist.
 * Retry extraction and push into the player via bridge when they appear.
 */
function scheduleLateChapterMerge(
  videoId: string,
  durationSeconds: number,
  alreadyHasChapters: boolean
) {
  clearLateChapterMerge();
  if (alreadyHasChapters) {
    return;
  }

  const delays = [600, 1_500, 3_000, 6_000];
  let attempt = 0;

  const tick = () => {
    lateChapterTimer = 0;
    if (!isAdFreeActive || activeVideoId !== videoId) {
      return;
    }
    const chapters = extractChaptersFromDocument(
      document,
      durationSeconds > 0 ? durationSeconds : 0,
      videoId
    );
    if (chapters.length >= 2) {
      log.info("late chapters merge", {
        videoId,
        count: chapters.length,
        attempt,
        first: chapters[0]?.title?.slice(0, 60)
      });
      // Patch only chapters on existing session payload
      void (async () => {
        try {
          const key = adFreeStreamStorageKey(videoId);
          const existing = await browser.storage.session.get(key);
          const prev = existing[key];
          if (prev && typeof prev === "object") {
            await browser.storage.session.set({
              [key]: { ...(prev as object), chapters }
            });
          }
        } catch {
          // ignore
        }
      })();
      postToPlayer({
        type: AD_FREE_BRIDGE_TYPE,
        action: "set-chapters",
        videoId,
        chapters
      });
      return;
    }

    attempt += 1;
    if (attempt < delays.length) {
      lateChapterTimer = window.setTimeout(tick, delays[attempt]);
    }
  };

  lateChapterTimer = window.setTimeout(tick, delays[0]);
}

async function enableAdFree(
  elButton: HTMLButtonElement,
  options?: {
    /** Always Ad-Free / auto path — user opened a watch page to watch. */
    preferPlay?: boolean;
  }
) {
  const videoId = getVideoId();
  if (!videoId || !getPlayerHost()) {
    log.warn("enable skipped — no video/host");
    return;
  }

  log.info("enable", { videoId });
  elButton.disabled = true;
  setButtonContents(elButton, "Loading...", { withDot: false, isActive: false });

  try {
    const isAd = isYouTubeShowingAd();
    const ytSnapshot = captureYouTubeSnapshot(videoId);
    // Mid-ad / Always Ad-Free: force play — park often reports wasPlaying=false (black screen)
    if (isAd || options?.preferPlay) {
      ytSnapshot.wasPlaying = true;
      log.info("autoplay forced", { t: Math.round(ytSnapshot.currentTime), isAd });
    }
    lastSnapshot = ytSnapshot;

    // Cover immediately with CSS + black shell. Park only (pause/mute) — do NOT
    // unload yet: early unload during YT SPA load freezes Polymer/main thread.
    showImmediateCover();
    pauseYouTubePlayer();
    youtubePark.park();
    activeVideoId = videoId;

    await persistVisitorData();

    const existingIframe = getIframe();
    const isKeepAliveSameVideo = existingIframe?.dataset.videoId === videoId;
    let resolvedChapters = 0;
    let resolvedDuration = 0;

    if (!isKeepAliveSameVideo) {
      log.info("resolve stream");
      let payload = await resolveStreamWithRetry(videoId);
      payload = await mergePageCaptions(payload);
      payload = await mergePageStoryboard(payload);
      payload = await mergePageChapters(payload);
      resolvedChapters = payload.chapters.length;
      resolvedDuration = payload.durationSeconds;
      log.info("stream resolved", {
        selected: payload.selectedQualityId,
        qualities: payload.qualities.length,
        chapters: payload.chapters.length
      });
    } else {
      log.info("reuse keep-alive iframe");
    }

    const created = ensureOverlay(
      videoId,
      ytSnapshot.currentTime,
      {
        onDestroy: () => void toggleAdFree(),
        onIframeCreated() {
          isPlayerReady = false;
        }
      },
      { startPaused: !ytSnapshot.wasPlaying }
    );
    showOverlayActive();
    youtubePark.park();

    const elLiveButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null ?? elButton;

    if (created || !isKeepAliveSameVideo) {
      await waitForPlayerReady(videoId);
      log.info("player ready", { isPlayerReady });
    } else {
    }

    // Fresh iframe already started with loadQuality(wasPlaying) + paused=0/1.
    // Re-pushing snapshot caused thin-buffer rebuffer flicker (play→pause→play).
    // Only push when keep-alive reuse (same iframe, may need time/play sync).
    if (!created && isKeepAliveSameVideo) {
      await pushSnapshotToPlayer(ytSnapshot, false);
    } else {
    }

    isAdFreeActive = true;
    enableRetryCount = 0;
    clearEnableRetry();
    // Unload original only after Ad-Free is ready (safe for YT SPA)
    youtubePark.unload();
    // Fresh enable: controls start visible until player reports idle
    getRoot()?.classList.remove("is-controls-hidden");
    setButtonContents(elLiveButton, "YouTube", { isActive: true });
    elLiveButton.disabled = false;
    log.info("enable done", { wasPlaying: ytSnapshot.wasPlaying, isAd });
    // Always Ad-Free often runs before YT chapter markers exist in DOM/scripts
    scheduleLateChapterMerge(videoId, resolvedDuration, resolvedChapters >= 2);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("enable failed", { message });
    console.error("[ytdl-ad-free]", message);
    isAdFreeActive = false;
    const elLiveButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null ?? elButton;

    // Always Ad-Free: keep cover, do NOT unpark (that flash of paused YT was the bug)
    if (isAdFreeDefault && isRetriableResolveError(message)) {
      installEarlyHideCss();
      showImmediateCover();
      pauseYouTubePlayer();
      youtubePark.park();
      setButtonContents(elLiveButton, "Loading...", { withDot: false, isActive: false });
      scheduleEnableRetry(message.slice(0, 80));
      return;
    }

    youtubePark.unpark();
    hideOverlayKeepAlive();
    removeEarlyHideCss();
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
  clearLateChapterMerge();
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
  removeEarlyHideCss();
  clearEnableRetry();
  isAdFreeActive = false;
  hasEarlyCover = false;
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

function resetForNavigation(reason = "nav") {
  // Avoid log+work spam when MO/ensureUiShell fire without a video id
  // and there is nothing mounted (was 1000+ "reset navigation" lines).
  const hasState = isAdFreeActive
    || Boolean(activeVideoId)
    || Boolean(getRoot())
    || hasEarlyCover
    || isPlayerReady
    || isAutoEnabling
    || enableRetryCount > 0
    || document.documentElement.classList.contains(EARLY_HIDE_CLASS);
  if (!hasState) {
    return;
  }
  log.info("reset navigation", { reason, ...pageSnap() });
  clearLateChapterMerge();
  clearCoverWatchdog();
  coverWatchdogRound = 0;
  isAdFreeActive = false;
  activeVideoId = null;
  lastSnapshot = null;
  isPlayerReady = false;
  autoEnableForVideoId = null;
  isAutoEnabling = false;
  hasEarlyCover = false;
  enableRetryCount = 0;
  clearEnableRetry();
  stopEarlyCoverObserver();
  youtubePark.unpark();
  destroyOverlay();
  removeEarlyHideCss();
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
  const videoId = getVideoId();
  if (!videoId) {
    resetForNavigation("no-video-id");
    return false;
  }

  if (!getPlayerHost()) {
    return false;
  }

  ensureStyles();
  startLayoutTracking();

  const hadButton = Boolean(document.getElementById(BUTTON_ID));
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
    if (isAdFreeActive && activeVideoId === videoId) {
      setButtonContents(elButton, "YouTube", { isActive: true });
      showOverlayActive();
    } else if (!isAdFreeActive) {
      setButtonContents(elButton, "Ad-Free", { isActive: false });
      hideOverlayKeepAlive();
    }
    if (!hadButton) {
      log.info("Ad-Free button mounted", { videoId });
    }
  }

  return true;
}

function waitForButtonTarget() {
  if (ensureUiShell()) {
    return;
  }
  // Non-watch pages: never hang a MutationObserver that spams reset
  if (!getVideoId()) {
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
function stopEarlyCoverObserver() {
  if (earlyCoverObserver) {
    earlyCoverObserver.disconnect();
    earlyCoverObserver = null;
  }
}

/**
 * Cover as soon as #movie_player exists — used for Always Ad-Free before full enable.
 * Safe: park only, no unload. Idempotent — never logs/spams on repeated calls.
 */
function applyEarlyCover(reason: string): boolean {
  if (hasEarlyCover) {
    log.ext("early cover already on", { reason, ...pageSnap() });
    return true;
  }
  installEarlyHideCss();
  ensureStyles();
  const elHost = getPlayerHost();
  if (!elHost) {
    log.ext("early cover wait host", { reason, ...pageSnap() });
    return false;
  }
  hasEarlyCover = true;
  stopEarlyCoverObserver();
  showImmediateCover();
  pauseYouTubePlayer();
  youtubePark.park();
  log.info("early cover applied", { reason, ...pageSnap() });
  armCoverWatchdog(`cover:${reason}`);
  return true;
}

async function tryAutoEnableAdFree() {
  if (!isAdFreeDefault) {
    log.ext("auto-enable skip", { reason: "pref-off", ...pageSnap() });
    return;
  }
  if (isAdFreeActive) {
    log.ext("auto-enable skip", { reason: "already-active", ...pageSnap() });
    return;
  }
  if (isAutoEnabling) {
    log.ext("auto-enable skip", { reason: "in-flight", ...pageSnap() });
    return;
  }
  const videoId = getVideoId();
  if (!videoId) {
    // Always Ad-Free cache may have painted a black cover with no video — peel or wait
    log.info("auto-enable skip", { reason: "no-video-id", ...pageSnap() });
    if (!isPlayerWatchPage()) {
      releaseCover("not-watch-page");
    } else {
      armCoverWatchdog("await-video-id");
    }
    return;
  }
  // User already opted back to YouTube (or we finished enable) for this id
  if (autoEnableForVideoId === videoId) {
    log.ext("auto-enable skip", { reason: "already-tried", videoId, ...pageSnap() });
    return;
  }
  isAutoEnabling = true;
  log.info("auto-enable (default on)", { videoId, ...pageSnap() });
  try {
    applyEarlyCover("auto-enable");

    if (!ensureUiShell()) {
      waitForButtonTarget();
      for (let attempt = 0; attempt < 25 && (!getPlayerHost() || !document.getElementById(BUTTON_ID)); attempt += 1) {
        await new Promise<void>(resolve => {
          window.setTimeout(resolve, 120);
        });
        ensureUiShell();
        // One-shot if host just appeared (hasEarlyCover makes this cheap)
        if (!hasEarlyCover && getPlayerHost()) {
          applyEarlyCover("auto-enable-poll");
        } else if (getPlayerHost() && !youtubePark.isParked()) {
          pauseYouTubePlayer();
          youtubePark.park();
        }
      }
    }
    const elButton = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
    if (!elButton || !getPlayerHost()) {
      log.warn("auto-enable deferred — host/button not ready", pageSnap());
      // Keep early hide + schedule retry (do not unpark — flashes YT)
      if (isAdFreeDefault) {
        installEarlyHideCss();
        scheduleEnableRetry("shell-not-ready");
        armCoverWatchdog("shell-not-ready");
      } else {
        releaseCover("pref-off-during-enable");
      }
      return;
    }
    // Mark before enable so a parallel nav/toggle cannot double-fire
    autoEnableForVideoId = videoId;
    await enableAdFree(elButton, { preferPlay: true });
    if (isAdFreeActive) {
      clearCoverWatchdog();
      coverWatchdogRound = 0;
    } else {
      armCoverWatchdog("enable-returned-inactive");
    }
  } catch (error) {
    // Allow retry on next navigation if enable failed
    if (autoEnableForVideoId === videoId && !isAdFreeActive) {
      autoEnableForVideoId = null;
    }
    log.warn("auto-enable failed", {
      message: error instanceof Error ? error.message : String(error),
      ...pageSnap()
    });
    armCoverWatchdog("enable-threw");
  } finally {
    isAutoEnabling = false;
  }
}

function onWatchNavigation() {
  const videoId = getVideoId();
  log.ext("nav", {
    videoId,
    activeVideoId,
    isAdFreeDefault,
    ...pageSnap()
  });
  // Same video + already enabling/active: ignore SPA noise (yt-navigate-finish mid-load)
  if (videoId && activeVideoId === videoId && (isAdFreeActive || isAutoEnabling || getIframe())) {
    log.ext("nav ignored (same video active)", { videoId });
    return;
  }
  // New video only — reset early-cover one-shot for the next page
  if (videoId && activeVideoId && videoId !== activeVideoId) {
    hasEarlyCover = false;
    stopEarlyCoverObserver();
    coverWatchdogRound = 0;
  }
  void persistVisitorData();
  if (!videoId || (activeVideoId && videoId !== activeVideoId)) {
    resetForNavigation();
    hasEarlyCover = false;
    stopEarlyCoverObserver();
  }
  waitForButtonTarget();
  if (isAdFreeDefault && videoId && autoEnableForVideoId !== videoId) {
    void tryAutoEnableAdFree();
  } else if (isAdFreeDefault && !videoId) {
    log.ext("nav no auto-enable (no videoId)");
  }
}

/**
 * document_start: if Always Ad-Free was on last time, cover YT before it paints/plays.
 * Pref is mirrored in localStorage by get/set/watch AdFreeDefault.
 * Observer only tries until first success — never log per-mutation (that froze YT).
 */
function bootEarlyCoverFromCache() {
  const cachedDefault = readAdFreeDefaultFromLocalCache();
  if (!cachedDefault) {
    log.ext("boot early cover skip (cache off)");
    return;
  }
  // Optimistic: treat as default-on until storage confirms
  isAdFreeDefault = true;
  const onWatch = isPlayerWatchPage();
  log.info("boot early cover from cache", { onWatch, ...pageSnap() });
  if (!onWatch) {
    // Don't install black shell on home/search — wait for watch/live navigation
    return;
  }
  // Instant CSS hide at +0ms — before #movie_player exists (logs showed ~1.2s of YT play)
  installEarlyHideCss();
  if (applyEarlyCover("document_start-cache")) {
    return;
  }
  stopEarlyCoverObserver();
  earlyCoverObserver = new MutationObserver(() => {
    // Silent until host exists; applyEarlyCover is one-shot
    if (getPlayerHost()) {
      applyEarlyCover("document_start-mo");
    }
  });
  earlyCoverObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => stopEarlyCoverObserver(), OBSERVER_DISCONNECT_MS);
  armCoverWatchdog("boot-await-host");
}

function pushTheaterStateToPlayer() {
  postToPlayer({
    type: AD_FREE_BRIDGE_TYPE,
    action: "theater-state",
    theater: isYouTubeTheaterMode()
  });
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
    // Sync theater icon/state once player chrome is up
    pushTheaterStateToPlayer();
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
  if (message.action === "toggle-theater") {
    const next = toggleYouTubeTheaterMode();
    log.info("theater toggle", { theater: next });
    // Layout change moves #movie_player — re-sync fixed overlay
    window.requestAnimationFrame(() => {
      syncRootLayout();
      window.setTimeout(() => syncRootLayout(), 50);
      window.setTimeout(() => syncRootLayout(), 200);
    });
    pushTheaterStateToPlayer();
  }
  if (message.action === "get-theater") {
    pushTheaterStateToPlayer();
  }
}

export default defineContentScript({
  matches: ["https://www.youtube.com/*"],
  // Early so Always Ad-Free can cover #movie_player before first paint/play
  runAt: "document_start",
  main(ctx) {
    // Dev extended logs (localStorage mirror + options) before other boot
    void optionsItem.getValue().then(options => {
      const extended = options.isAdFreeDevExtendedLogs === true;
      setAdFreeExtendedLogs(extended);
      log.ext("extended logs boot", { extended });
    }).catch(() => {
      // ignore
    });
    const unwatchOptions = optionsItem.watch(options => {
      setAdFreeExtendedLogs(options.isAdFreeDevExtendedLogs === true);
    });
    ctx.onInvalidated(() => {
      unwatchOptions();
    });

    bootEarlyCoverFromCache();

    window.addEventListener("message", onBridgeFromPlayer);

    void getAdFreeDefaultEnabled().then(enabled => {
      isAdFreeDefault = enabled;
      writeAdFreeDefaultLocalCache(enabled);
      log.info("default pref loaded", { enabled, ...pageSnap() });
      if (enabled) {
        void tryAutoEnableAdFree();
      } else {
        // Stale cover from previous session cache mismatch
        releaseCover("pref-loaded-off");
      }
    });

    const unwatchDefault = watchAdFreeDefaultEnabled(enabled => {
      const was = isAdFreeDefault;
      isAdFreeDefault = enabled;
      writeAdFreeDefaultLocalCache(enabled);
      log.info("default pref changed", { enabled, was, ...pageSnap() });
      if (enabled && !was && !isAdFreeActive) {
        // Newly enabled: clear skip so current video auto-enables once
        autoEnableForVideoId = null;
        coverWatchdogRound = 0;
        void tryAutoEnableAdFree();
      } else if (!enabled && was && !isAdFreeActive) {
        // Turning Always Ad-Free off must not leave black shell over YT
        releaseCover("pref-turned-off");
      }
    });
    ctx.onInvalidated(() => {
      unwatchDefault();
      clearCoverWatchdog();
    });

    onWatchNavigation();

    ctx.addEventListener(window, "wxt:locationchange", () => {
      onWatchNavigation();
    });

    document.addEventListener("yt-navigate-finish", () => {
      onWatchNavigation();
    });

    // Keep player theater icon in sync if user (or YT) changes layout
    const unwatchTheater = watchYouTubeTheaterMode(theater => {
      if (!isAdFreeActive) {
        return;
      }
      postToPlayer({
        type: AD_FREE_BRIDGE_TYPE,
        action: "theater-state",
        theater
      });
      syncRootLayout();
    });
    ctx.onInvalidated(() => {
      unwatchTheater();
    });
  }
});
