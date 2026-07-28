import "vidstack/player";
import "vidstack/player/ui";
import "vidstack/player/layouts/default";
import "vidstack/player/styles/base.css";
import "vidstack/player/styles/default/theme.css";
import "vidstack/player/styles/default/layouts/video.css";

import "./player.css";

import {
  AD_FREE_BRIDGE_TYPE,
  type AdFreeBridgeFromPlayer,
  type AdFreeBridgeToPlayer,
  isBridgeMessage,
  isValidSnapshot
} from "@/lib/ad-free/bridge";
import { createAdFreeLogger } from "@/lib/ad-free/debug-log";
import {
  type KeepPlayingController,
  installKeepPlaying
} from "@/lib/ad-free/keep-playing";
import {
  createPlaybackEngine,
  isMediaPlayerLike,
  orderQualitiesForMenu,
  pickDefaultQuality,
  type MediaPlayerLike,
  type PlaybackEngine
} from "@/lib/ad-free/playback-engine";
import { qualitySupportsMse } from "@/lib/ad-free/mse/mse-controller";
import { installDefaultMenuItem } from "@/lib/ad-free/default-menu-item";
import {
  type AdFreeChapter,
  chaptersToWebVtt,
  normalizeChapters
} from "@/lib/ad-free/chapters";
import {
  type AdFreeCaptionTrack,
  type AdFreeStreamPayload,
  adFreeStreamStorageKey,
  deriveSelectedFields,
  normalizeAdFreeStreamPayload
} from "@/lib/ad-free/resolve-stream";
import { buildStoryboardThumbs } from "@/lib/ad-free/storyboard";
import { readInitialTime } from "@/lib/ad-free/youtube-time";
import { installHotkeys } from "@/lib/ad-free/hotkeys";
import {
  getAdFreeQualityPref,
  pickQualityFromPreference,
  setAdFreeQualityPref
} from "@/lib/ad-free/quality-pref";
import { createPlayerToast } from "@/lib/ad-free/player-toast";
import { MessageType, sendMessage } from "@/lib/messaging/messaging";

const log = createAdFreeLogger("player");

function postToParent(message: AdFreeBridgeFromPlayer) {
  try {
    parent.postMessage(message, "*");
  } catch {
    // ignore
  }
}

function createErrorElement(heading: string, message: string): HTMLElement {
  const elError = document.createElement("div");
  elError.id = "error";
  const elHeading = document.createElement("h2");
  elHeading.textContent = heading;
  const elMessage = document.createElement("p");
  elMessage.textContent = message;
  elError.append(elHeading, elMessage);
  return elError;
}

function renderError(elContainer: HTMLElement, message: string) {
  elContainer.replaceChildren(createErrorElement("Playback error", message));
}

function renderLoading(elContainer: HTMLElement, text = "Loading stream...") {
  const elLoading = document.createElement("div");
  elLoading.id = "loading";
  const elSpinner = document.createElement("div");
  elSpinner.className = "spinner";
  const elText = document.createElement("p");
  elText.textContent = text;
  elLoading.append(elSpinner, elText);
  elContainer.replaceChildren(elLoading);
}

function youtubeThumbnailUrl(videoId: string) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function appendCaptionTracks(elProvider: HTMLElement, captions: AdFreeCaptionTrack[]) {
  for (const caption of captions) {
    if (!/^https?:\/\//i.test(caption.src)) {
      continue;
    }
    const elTrack = document.createElement("track");
    elTrack.kind = caption.kind;
    elTrack.label = caption.label;
    elTrack.srclang = caption.languageCode;
    elTrack.src = caption.src;
    elTrack.id = caption.id;
    elProvider.append(elTrack);
  }
}

/**
 * Attach YouTube chapters as a VTT `kind="chapters"` track so Vidstack's
 * default layout can render slider segments + hover title next to storyboard.
 * Returns the blob URL to revoke on teardown (or null if skipped).
 */
function appendChapterTrack(
  elProvider: HTMLElement,
  chapters: AdFreeChapter[],
  durationSeconds: number
): string | null {
  const normalized = normalizeChapters(
    chapters.map(chapter => ({
      startSeconds: chapter.startSeconds,
      title: chapter.title
    })),
    durationSeconds
  );
  if (normalized.length < 2) {
    return null;
  }

  // Replace any prior chapters track (late attach after Always Ad-Free race)
  elProvider.querySelectorAll("track#ytdl-chapters, track[kind='chapters']").forEach(el => {
    el.remove();
  });

  const vtt = chaptersToWebVtt(normalized);
  const blobUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
  const elTrack = document.createElement("track");
  elTrack.kind = "chapters";
  elTrack.label = "Chapters";
  elTrack.srclang = "en";
  elTrack.default = true;
  elTrack.src = blobUrl;
  elTrack.id = "ytdl-chapters";
  elProvider.append(elTrack);
  return blobUrl;
}

function persistSelected(
  videoId: string,
  payload: AdFreeStreamPayload,
  qualityId: string
) {
  const quality = payload.qualities.find(item => item.id === qualityId);
  if (!quality) {
    return;
  }
  const nextPayload: AdFreeStreamPayload = {
    ...payload,
    ...deriveSelectedFields(quality),
    qualities: payload.qualities,
    captions: payload.captions,
    storyboardSpec: payload.storyboardSpec,
    chapters: payload.chapters ?? [],
    resolvedAt: payload.resolvedAt
  };
  void browser.storage.session.set({
    [adFreeStreamStorageKey(videoId)]: nextPayload
  });
}

function isBridgeToPlayer(data: unknown): data is AdFreeBridgeToPlayer {
  return isBridgeMessage(data);
}

function wireBridge(
  engine: PlaybackEngine,
  videoId: string,
  keepPlaying: KeepPlayingController | null,
  options?: {
    onSetChapters?: (chapters: AdFreeChapter[]) => void;
  }
) {
  function handler(event: MessageEvent) {
    if (event.source !== window.parent) {
      return;
    }
    if (!isBridgeToPlayer(event.data)) {
      return;
    }
    const message = event.data;
    log.debug(`bridge ← ${message.action}`);

    if (message.action === "ping") {
      postToParent({ type: AD_FREE_BRIDGE_TYPE, action: "pong" });
      return;
    }

    if (message.action === "get-state") {
      postToParent({
        type: AD_FREE_BRIDGE_TYPE,
        action: "state",
        requestId: message.requestId,
        snapshot: engine.captureSnapshot(videoId)
      });
      return;
    }

    if (message.action === "pause") {
      keepPlaying?.setWantsPlaying(false);
      engine.pause();
      return;
    }

    if (message.action === "set-chapters") {
      if (message.videoId !== videoId) {
        return;
      }
      const chapters = (message.chapters ?? []).filter(
        (item): item is AdFreeChapter =>
          typeof item?.startSeconds === "number"
          && typeof item?.endSeconds === "number"
          && typeof item?.title === "string"
      );
      options?.onSetChapters?.(chapters);
      return;
    }

    if (message.action === "set-state") {
      if (!isValidSnapshot(message.snapshot) || message.snapshot.videoId !== videoId) {
        log.warn("bridge set-state rejected snapshot");
        return;
      }
      void (async () => {
        await engine.applySnapshot(message.snapshot, message.forcePause);
        if (message.forcePause || !message.snapshot.wasPlaying) {
          keepPlaying?.setWantsPlaying(false);
        } else {
          keepPlaying?.setWantsPlaying(true);
        }
        postToParent({
          type: AD_FREE_BRIDGE_TYPE,
          action: "set-state-done",
          requestId: message.requestId
        });
      })();
    }
  }

  window.addEventListener("message", handler);
  return function disposeBridge() {
    window.removeEventListener("message", handler);
  };
}

function createMediaPlayerElement(): MediaPlayerLike {
  const element = document.createElement("media-player");
  if (isMediaPlayerLike(element)) {
    return element;
  }
  throw new Error("Failed to create media-player element");
}

function renderPlayer(
  elContainer: HTMLElement,
  payload: AdFreeStreamPayload,
  videoId: string,
  options: {
    isEmbed: boolean;
    initialTime: number;
    startPaused: boolean;
    preferredQualityHeight?: number | null;
    preferProgressive?: boolean | null;
  }
) {
  const { isEmbed, initialTime, startPaused } = options;
  const qualities = payload.qualities;
  if (qualities.length === 0) {
    renderError(elContainer, "No quality options available");
    return;
  }

  // Adaptive dual-element cannot sustain 1080p+ (audio steals the pipe).
  // Phase 1: avc1 adaptive uses MSE dual-track — allow all heights for those.
  // Non-MSE adaptive (e.g. av01 without MSE path) still capped at 720p.
  const playableQualities = qualities.filter(item =>
    item.isProgressive
    || qualitySupportsMse(item)
    || (item.height ?? 0) <= 720
  );
  const orderedForMenu = orderQualitiesForMenu(
    playableQualities.length > 0 ? playableQualities : qualities
  );
  // Remembered quality (local) > session selected MSE > pickDefaultQuality
  const remembered = pickQualityFromPreference(
    orderedForMenu,
    options.preferredQualityHeight && options.preferredQualityHeight > 0
      ? {
        height: options.preferredQualityHeight,
        preferProgressive: options.preferProgressive === true,
        updatedAt: 0
      }
      : null
  );
  const preferredDefault = pickDefaultQuality(orderedForMenu);
  const stored = orderedForMenu.find(item => item.id === payload.selectedQualityId);
  const initialQuality = remembered
    ?? (stored && qualitySupportsMse(stored) ? stored : null)
    ?? preferredDefault
    ?? stored
    ?? orderedForMenu[0];

  if (!/^https?:\/\//i.test(initialQuality.videoUrl)) {
    renderError(elContainer, "No valid stream URLs found");
    return;
  }

  if (isEmbed) {
    document.documentElement.classList.add("is-embed");
    document.body.classList.add("is-embed");
  }

  const elShell = document.createElement("div");
  elShell.id = "shell";
  if (isEmbed) {
    elShell.classList.add("is-embed");
  }

  const elPlayerWrap = document.createElement("div");
  elPlayerWrap.id = "player-wrap";
  // Hide from first paint (before loader / media-player append)
  elPlayerWrap.classList.add("is-buffering", "is-bootstrapping");

  const elPlayer = createMediaPlayerElement();
  // When chapters exist, leave title empty so Vidstack default layout shows
  // media-chapter-title (current chapter) next to volume instead of the full video name.
  const hasChapters = (payload.chapters?.length ?? 0) >= 2;
  if (hasChapters) {
    elPlayer.removeAttribute("title");
  } else {
    elPlayer.setAttribute("title", payload.title);
  }
  elPlayer.setAttribute("artist", payload.author);
  elPlayer.setAttribute("poster", youtubeThumbnailUrl(videoId));
  elPlayer.setAttribute("playsinline", "");
  elPlayer.setAttribute("view-type", "video");
  elPlayer.setAttribute("stream-type", "on-demand");
  elPlayer.setAttribute("load", "eager");
  // Prefer auto so mid-video seeks (1h+) buffer more aggressively at resume point
  elPlayer.setAttribute("preload", "auto");
  elPlayer.setAttribute("aria-label", payload.title || "Video player");

  const elProvider = document.createElement("media-provider");
  appendCaptionTracks(elProvider, payload.captions ?? []);
  let chapterBlobUrl = appendChapterTrack(
    elProvider,
    payload.chapters ?? [],
    payload.durationSeconds > 0 ? payload.durationSeconds : 0
  );
  if (chapterBlobUrl) {
    log.info("chapters track ready", {
      count: payload.chapters?.length ?? 0,
      first: payload.chapters?.[0]?.title?.slice(0, 60)
    });
  } else {
    log.debug("no chapters — continuous progress bar");
  }

  function applyChapters(chapters: AdFreeChapter[]) {
    if (chapters.length < 2) {
      return;
    }
    if (chapterBlobUrl) {
      try {
        URL.revokeObjectURL(chapterBlobUrl);
      } catch {
        // ignore
      }
    }
    chapterBlobUrl = appendChapterTrack(
      elProvider,
      chapters,
      payload.durationSeconds > 0 ? payload.durationSeconds : 0
    );
    if (chapterBlobUrl) {
      // Empty title so default layout shows media-chapter-title
      elPlayer.removeAttribute("title");
      log.info("chapters track ready (late)", {
        count: chapters.length,
        first: chapters[0]?.title?.slice(0, 60)
      });
    }
  }

  const elLayout = document.createElement("media-video-layout") as HTMLElement & {
    sliderChaptersMinWidth?: number;
    menuContainer?: string | HTMLElement | null;
    /** Default: width < 576 || height < 380 → small UI (caption/settings TOP). */
    smallWhen?: "never" | boolean | ((q: { width: number; height: number }) => boolean);
    menuGroup?: "top" | "bottom";
  };
  // Always show chapter segments when a chapters track is present (embed can be narrow).
  elLayout.sliderChaptersMinWidth = 0;
  // Keep settings/chapters menus portaled inside player-wrap (not document.body)
  // so our Always Ad-Free row and CSS stay reachable.
  elLayout.menuContainer = elPlayerWrap;
  // YouTube embed is often ~670×378 — default smallWhen (height < 380) puts
  // caption/settings/fullscreen in the TOP row (y≈2). That looked like a flash
  // of "bottom" chrome stuck in the corner. Force large layout → bottom chrome.
  elLayout.smallWhen = "never";
  elLayout.menuGroup = "bottom";
  // Storyboard attached after first media ready — expanding 800+ frames blocks first paint
  // and felt like a second "reload" (loading → blank player → spinner).
  elPlayer.append(elProvider, elLayout);
  elPlayerWrap.append(elPlayer);

  // Revoke chapter VTT blob when the player page unloads
  window.addEventListener(
    "pagehide",
    () => {
      if (!chapterBlobUrl) {
        return;
      }
      try {
        URL.revokeObjectURL(chapterBlobUrl);
      } catch {
        // ignore
      }
    },
    { once: true }
  );

  // Minimal single-ring loader (Vidstack native spinner is CSS-hidden).
  // Bootstrapping: solid cover until first loadQuality resolves — one continuous spinner
  // instead of Loading page → empty chrome → spinner again.
  const elLoader = document.createElement("div");
  elLoader.className = "ytdl-loader";
  elLoader.setAttribute("aria-hidden", "false");
  elLoader.innerHTML = "<div class=\"ytdl-loader-ring\" role=\"presentation\"></div>";
  elPlayerWrap.append(elLoader);

  let engine: PlaybackEngine | null = null;
  let isBootstrapping = true;

  function attachStoryboardWhenIdle() {
    if (!payload.storyboardSpec) {
      return;
    }
    const run = () => {
      try {
        const storyboardThumbs = buildStoryboardThumbs({
          spec: payload.storyboardSpec,
          durationSeconds: payload.durationSeconds > 0 ? payload.durationSeconds : 0
        });
        if (storyboardThumbs.length === 0) {
          return;
        }
        (elLayout as HTMLElement & { thumbnails?: unknown }).thumbnails = storyboardThumbs;
        log.info("storyboard thumbs ready (deferred)", {
          frames: storyboardThumbs.length,
          firstUrl: storyboardThumbs[0]?.url?.slice(0, 80)
        });
      } catch (error) {
        log.warn("storyboard attach failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => run(), { timeout: 2_500 });
    } else {
      window.setTimeout(run, 0);
    }
  }

  const keepPlaying = isEmbed
    ? installKeepPlaying({
      isSafeToResume: () => engine?.isSafeToResume() ?? false,
      onForceResume() {
        void engine?.play();
      }
    })
    : null;

  const settingsExtrasHolder: {
    current: ReturnType<typeof installDefaultMenuItem> | null;
  } = {
    current: null
  };

  const toast = createPlayerToast(elPlayerWrap);

  engine = createPlaybackEngine({
    elPlayer,
    elMount: elPlayerWrap,
    initialQuality,
    durationSeconds: payload.durationSeconds > 0 ? payload.durationSeconds : undefined,
    allowPause: keepPlaying
      ? run => keepPlaying.allowPause(run)
      : undefined,
    onStateChange(state) {
      const busy = state === "loading" || state === "switching" || state === "seeking";
      // During bootstrap keep spinner until first ready (ignore brief ready→busy flicker)
      const showLoader = isBootstrapping || busy;
      elPlayerWrap.classList.toggle("is-buffering", showLoader);
      elPlayerWrap.dataset.engineState = state;
      elLoader.setAttribute("aria-hidden", showLoader ? "false" : "true");
    },
    onQualityChange(quality) {
      settingsExtrasHolder.current?.setSelectedQuality(quality.id);
      persistSelected(videoId, payload, quality.id);
      void setAdFreeQualityPref(quality);
      const elBadge = document.getElementById("quality-badge");
      if (elBadge) {
        elBadge.textContent = quality.label;
      }
    },
    onError(message) {
      log.error("engine error", { message });
      elPlayerWrap.classList.remove("is-buffering");
      renderError(elContainer, message);
    }
  });

  // Persist initial selection too (first visit after pref empty)
  void setAdFreeQualityPref(initialQuality);

  // Settings ⚙: Always Ad-Free + Quality (chip removed — missing in fullscreen)
  const defaultMenuItem = installDefaultMenuItem(elPlayer as unknown as HTMLElement, {
    qualities: orderedForMenu,
    selectedQualityId: initialQuality.id,
    onQualitySelect(quality) {
      if (!engine) {
        return;
      }
      const resumeAt = engine.getLastKnownGoodTime() > 0
        ? engine.getLastKnownGoodTime()
        : Number(elPlayer.currentTime ?? 0) || 0;
      const wasPlaying = true;
      log.info("quality menu select", {
        id: quality.id,
        label: quality.label,
        resumeAt,
        wasPlaying,
        busy: engine.isBusy()
      });
      void setAdFreeQualityPref(quality);
      void engine.loadQuality(quality, { resumeAt, wasPlaying });
    }
  });
  settingsExtrasHolder.current = defaultMenuItem;

  /**
   * Chapters menu: close root menu after picking a chapter (Vidstack keeps it open by default).
   */
  elPlayer.addEventListener("change", event => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (!target.matches("media-chapters-radio-group, .vds-chapters-radio-group")) {
      return;
    }
    const elMenu = target.closest("media-menu");
    if (!elMenu) {
      return;
    }
    const closer = elMenu as HTMLElement & { close?: (trigger?: Event) => void };
    if (typeof closer.close === "function") {
      closer.close(event);
    }
  }, true);

  // Mirror controls idle → parent (Ad-Free chip)
  if (isEmbed) {
    elPlayer.addEventListener("controls-change", event => {
      const detail = (event as CustomEvent<boolean>).detail;
      const visible = typeof detail === "boolean"
        ? detail
        : (elPlayer as HTMLElement).hasAttribute("data-controls");
      postToParent({
        type: AD_FREE_BRIDGE_TYPE,
        action: "controls-visible",
        visible
      });
    });
  }

  let lastUserInputAt = 0;
  /**
   * Until this timestamp, treat play/playing as accidental (grace re-play / keep-playing)
   * and force-pause. Set by media-pause-request / gesture before the actual pause event.
   */
  let intentionalPauseUntil = 0;
  const INTENTIONAL_PAUSE_HOLD_MS = 2_000;

  function markUserInput() {
    lastUserInputAt = Date.now();
  }

  function isFromTimeSlider(event: Event): boolean {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (!(node instanceof Element)) {
        continue;
      }
      if (node.matches(
        "media-time-slider, .vds-time-slider, media-volume-slider, .vds-volume-slider, "
        + "media-slider.vds-time-slider, [data-media-slider-type=\"time\"]"
      )) {
        return true;
      }
    }
    const target = event.target;
    if (target instanceof Element) {
      return Boolean(target.closest(
        "media-time-slider, .vds-time-slider, media-volume-slider, .vds-volume-slider"
      ));
    }
    return false;
  }

  function applyIntentionalPause(source: string) {
    if (!engine) {
      return;
    }
    if (engine.isBusy()) {
      log.debug(`intentional pause ignored — busy (${source})`);
      return;
    }
    intentionalPauseUntil = Date.now() + INTENTIONAL_PAUSE_HOLD_MS;
    markUserInput();
    log.debug(`intentional pause → engine.pause() (${source})`);
    engine.pause();
    keepPlaying?.setWantsPlaying(false);
  }

  function applyIntentionalPlay(source: string) {
    if (!engine) {
      return;
    }
    intentionalPauseUntil = 0;
    markUserInput();
    log.debug(`intentional play (${source})`);
    keepPlaying?.setWantsPlaying(true);
    engine.setWantsPlaying(true);
  }

  /**
   * Vidstack fires these BEFORE the media element pauses/plays — from gesture
   * (click on video), play button, and keyboard. Time-slider also emits them
   * during scrub; those must NOT clear wantsPlaying.
   */
  elPlayer.addEventListener("media-pause-request", event => {
    if (isFromTimeSlider(event)) {
      log.debug("media-pause-request from scrub — keep intent");
      return;
    }
    applyIntentionalPause("media-pause-request");
  }, true);

  elPlayer.addEventListener("media-play-request", event => {
    if (isFromTimeSlider(event)) {
      log.debug("media-play-request from scrub — engine owns resume");
      return;
    }
    applyIntentionalPlay("media-play-request");
  }, true);

  elPlayer.addEventListener("play", () => {
    if (engine?.isBusy()) {
      return;
    }
    // Ghost play right after intentional pause (grace re-play / keep-playing race)
    if (Date.now() < intentionalPauseUntil) {
      log.debug("play blocked — intentional pause window");
      engine?.pause();
      keepPlaying?.setWantsPlaying(false);
      return;
    }
    keepPlaying?.setWantsPlaying(true);
    engine?.setWantsPlaying(true);
  });
  elPlayer.addEventListener("playing", () => {
    if (engine?.isBusy()) {
      return;
    }
    if (Date.now() < intentionalPauseUntil) {
      log.debug("playing blocked — intentional pause window");
      engine?.pause();
      keepPlaying?.setWantsPlaying(false);
      return;
    }
    keepPlaying?.setWantsPlaying(true);
    engine?.setWantsPlaying(true);
  });
  elPlayer.addEventListener("ended", () => {
    intentionalPauseUntil = 0;
    keepPlaying?.setWantsPlaying(false);
    engine?.setWantsPlaying(false);
  });

  // Fallback: if pause arrives without media-pause-request (some providers),
  // still honour a recent non-scrub pointer gesture.
  let lastSurfacePointerAt = 0;
  elPlayer.addEventListener("pause", () => {
    if (!engine || engine.isBusy()) {
      return;
    }
    if (Date.now() < intentionalPauseUntil) {
      // Already handled via media-pause-request
      engine.pause();
      keepPlaying?.setWantsPlaying(false);
      return;
    }
    if (Date.now() - lastSurfacePointerAt <= 400) {
      applyIntentionalPause("pause+surface-pointer");
    }
  }, true);

  function onSurfacePointer(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    // Scrub / volume / menus / non-play chrome — not a play/pause toggle
    if (target.closest(
      "media-menu, media-menu-button, media-menu-items, media-menu-portal, "
      + "media-time-slider, media-volume-slider, media-slider, "
      + ".vds-slider, .vds-time-slider, .vds-volume-slider, .vds-menu, .vds-menu-items, "
      + ".ytdl-quality-section, input, select, textarea, "
      + "media-mute-button, media-fullscreen-button, media-pip-button, "
      + "media-caption-button, media-live-button, media-seek-button, "
      + ".vds-mute-button, .vds-fullscreen-button, .vds-pip-button, "
      + ".vds-caption-button, .vds-settings-menu, .vds-google-cast-button, "
      + ".vds-volume-popup, .vds-tooltip"
    )) {
      markUserInput();
      return;
    }
    // Vidstack gesture uses pointerup on media-gesture for toggle:paused
    lastSurfacePointerAt = Date.now();
    markUserInput();
  }
  elPlayer.addEventListener("pointerdown", onSurfacePointer, true);
  elPlayer.addEventListener("pointerup", onSurfacePointer, true);

  elPlayer.addEventListener("keydown", event => {
    if (event.key === " " || event.key === "k" || event.key === "K" || event.key === "MediaPlayPause") {
      // media-pause-request / media-play-request will follow; pre-mark surface
      lastSurfacePointerAt = Date.now();
      markUserInput();
    }
  }, true);

  // Engine is always assigned above; alias for non-null hotkey wiring
  const activeEngine = engine!;

  // YouTube-style hotkeys (j/l, arrows, m, f, c, 0–9, speed, frame step)
  const hotkeys = installHotkeys({
    elPlayer,
    engine: activeEngine,
    onPlayIntent: () => applyIntentionalPlay("hotkey"),
    onPauseIntent: () => applyIntentionalPause("hotkey"),
    onSeekFlash: delta => toast.showSeek(delta),
    onSpeedFlash: rate => toast.show(`${rate}×`, { durationMs: 800 })
  });

  let disposeBridge: (() => void) | null = null;
  if (isEmbed) {
    disposeBridge = wireBridge(activeEngine, videoId, keepPlaying, {
      onSetChapters: applyChapters
    });
  }

  elShell.append(elPlayerWrap);

  if (!isEmbed) {
    const elMeta = document.createElement("div");
    elMeta.id = "meta";

    const elTitle = document.createElement("h1");
    elTitle.textContent = payload.title;

    const elChannel = document.createElement("p");
    elChannel.className = "channel";
    elChannel.textContent = payload.author;

    const elBadge = document.createElement("span");
    elBadge.id = "quality-badge";
    elBadge.className = "badge";
    elBadge.textContent = initialQuality.label;

    const elHint = document.createElement("p");
    elHint.className = "quality-hint";
    const captionHint = (payload.captions?.length ?? 0) > 0
      ? ` · ${payload.captions.length} subtitle track(s)`
      : "";
    const mseCount = orderedForMenu.filter(item => qualitySupportsMse(item)).length;
    const mseHint = mseCount > 0 ? ` · MSE ${mseCount} adaptive` : "";
    elHint.textContent = orderedForMenu.length > 1
      ? `Quality menu · Captions in Settings · hotkeys j/l/f/m${captionHint}${mseHint}`
      : `Settings ⚙ → Captions · hotkeys j/l/f/m${captionHint}${mseHint}`;

    elMeta.append(elTitle, elChannel, elBadge, elHint);
    elShell.append(elMeta);
    document.title = `${payload.title} · Ad-Free Player`;
  }

  elContainer.replaceChildren(elShell);

  log.info("render", {
    videoId,
    quality: initialQuality.label,
    t: Math.round(initialTime),
    paused: startPaused
  });

  // Honor paused=0 even for mid-file resume (old: && initialTime<=0 left Always Ad-Free black)
  void engine.loadQuality(initialQuality, {
    resumeAt: Math.max(0, initialTime),
    wasPlaying: !startPaused
  }).then(async () => {
    // Keep solid black bootstrap until buffer is playable — avoids 0.7s flash then rebuffer
    const elVideo = engine?.getVideoElement() ?? null;
    const minRevealAhead = 1.5;
    const revealDeadline = Date.now() + 4_000;
    while (Date.now() < revealDeadline) {
      const ahead = elVideo
        ? (() => {
          try {
            const t = elVideo.currentTime;
            const b = elVideo.buffered;
            for (let i = 0; i < b.length; i += 1) {
              if (t >= b.start(i) - 0.15 && t <= b.end(i) + 0.05) {
                return b.end(i) - t;
              }
            }
            return 0;
          } catch {
            return 0;
          }
        })()
        : 0;
      if (ahead >= minRevealAhead || !engine?.getWantsPlaying()) {
        break;
      }
      await new Promise<void>(r => {
        window.setTimeout(r, 80);
      });
    }

    const stillBusy = engine?.isBusy() ?? false;
    elPlayerWrap.classList.toggle("is-buffering", stillBusy);
    elLoader.setAttribute("aria-hidden", stillBusy ? "false" : "true");

    /** Snapshot chrome geometry for session-log (top-right flash diagnosis). */
    function measureChrome(tag: string) {
      const wrap = elPlayerWrap.getBoundingClientRect();
      const elLayoutNode = elPlayer.querySelector("media-video-layout");
      const buttons = [
        ...elPlayer.querySelectorAll(
          "media-fullscreen-button, media-caption-button, "
          + "media-menu.vds-settings-menu media-menu-button.vds-button"
        )
      ] as HTMLElement[];
      const btnSnap = buttons.slice(0, 6).map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          x: Math.round(r.left - wrap.left),
          y: Math.round(r.top - wrap.top)
        };
      });
      // Large layout: settings/caption/fs in bottom row. Small: y≈2 (top).
      const btnsBottom = btnSnap.length > 0
        && btnSnap.every(b => b.y >= wrap.height * 0.45);
      log.info(`chrome ${tag}`, {
        wrap: { w: Math.round(wrap.width), h: Math.round(wrap.height) },
        layout: {
          sm: elLayoutNode?.hasAttribute("data-sm") ?? null,
          size: elLayoutNode?.getAttribute("data-size") ?? null
        },
        btnsBottom,
        classes: elPlayerWrap.className,
        btns: btnSnap
      });
      return { btnsBottom };
    }

    /** Reveal after large-layout bottom chrome is in place (btns y in lower half). */
    const waitForBottomChrome = (): Promise<{ reason: string; frames: number }> =>
      new Promise(resolve => {
        const deadline = Date.now() + 2_500;
        let frames = 0;
        let lastLogFrame = -99;
        log.info("chrome wait start");
        measureChrome("wait-0");

        const tick = () => {
          frames += 1;
          const shouldLog = frames <= 3
            || frames - lastLogFrame >= 10;
          const snap = shouldLog
            ? measureChrome(`wait-f${frames}`)
            : (() => {
              const wrap = elPlayerWrap.getBoundingClientRect();
              const buttons = [
                ...elPlayer.querySelectorAll(
                  "media-fullscreen-button, media-caption-button, "
                  + "media-menu.vds-settings-menu media-menu-button.vds-button"
                )
              ] as HTMLElement[];
              const btnsBottom = buttons.length > 0
                && buttons.every(el => {
                  const r = el.getBoundingClientRect();
                  return r.height > 0 && r.top - wrap.top >= wrap.height * 0.45;
                });
              return { btnsBottom };
            })();
          if (shouldLog || snap.btnsBottom) {
            lastLogFrame = frames;
            if (snap.btnsBottom && !shouldLog) {
              measureChrome(`wait-f${frames}`);
            }
          }
          if (snap.btnsBottom && frames >= 2) {
            resolve({ reason: "btns-bottom", frames });
            return;
          }
          if (Date.now() >= deadline || frames > 120) {
            measureChrome("wait-timeout");
            resolve({
              reason: Date.now() >= deadline ? "deadline" : "max-frames",
              frames
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

    void waitForBottomChrome().then(result => {
      log.info("chrome wait done", result);
      requestAnimationFrame(() => {
        measureChrome("pre-reveal");
        isBootstrapping = false;
        elPlayerWrap.classList.add("is-chrome-ready");
        log.info("chrome ready class set");
        requestAnimationFrame(() => {
          elPlayerWrap.classList.remove("is-bootstrapping");
          measureChrome("post-reveal-0");
          window.setTimeout(() => measureChrome("post-reveal-50"), 50);
          window.setTimeout(() => measureChrome("post-reveal-150"), 150);
        });
      });
    });

    attachStoryboardWhenIdle();
    if (isEmbed) {
      log.info("ready → parent");
      postToParent({ type: AD_FREE_BRIDGE_TYPE, action: "ready", videoId });
    }
  });

  window.addEventListener("pagehide", () => {
    log.info("pagehide dispose");
    disposeBridge?.();
    hotkeys.dispose();
    toast.dispose();
    defaultMenuItem.dispose();
    engine?.dispose();
    keepPlaying?.dispose();
  }, { once: true });
}

async function loadStoredPayload(videoId: string): Promise<AdFreeStreamPayload | null> {
  const key = adFreeStreamStorageKey(videoId);
  const result = await browser.storage.session.get(key);
  return normalizeAdFreeStreamPayload(result[key]);
}

async function resolvePayload(videoId: string): Promise<AdFreeStreamPayload> {
  const stored = await loadStoredPayload(videoId);
  if (stored && stored.qualities.length > 0) {
    return stored;
  }

  return sendMessage(MessageType.ResolveAdFreeStream, { videoId });
}

async function init() {
  const elApp = document.getElementById("app");
  if (!elApp) {
    return;
  }

  const params = new URLSearchParams(location.search);
  const videoId = params.get("v");
  const isEmbed = params.get("embed") === "1";
  const initialTime = readInitialTime(params);
  // paused=0 → play; paused=1 or missing → start paused (parent pushSnapshot may still play)
  const startPaused = params.get("paused") !== "0";

  log.info("init", { videoId, isEmbed, initialTime, startPaused });

  if (!videoId) {
    renderError(elApp, "No video ID provided.");
    return;
  }

  renderLoading(elApp, isEmbed ? "Loading Ad-Free…" : "Loading stream...");

  try {
    const payload = await resolvePayload(videoId);
    const qualityPref = await getAdFreeQualityPref();
    log.info("payload", {
      title: payload.title?.slice(0, 80),
      qualities: payload.qualities.length,
      selected: payload.selectedQualityId,
      captions: payload.captions.length,
      qualityPref: qualityPref?.height ?? null
    });
    renderPlayer(elApp, payload, videoId, {
      isEmbed,
      initialTime,
      startPaused,
      preferredQualityHeight: qualityPref?.height ?? null,
      preferProgressive: qualityPref?.preferProgressive ?? null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("init failed", { message });
    renderError(
      elApp,
      `${message}\n\nToggle Ad-Free again on the YouTube watch page.`
    );
  }
}

void init();
