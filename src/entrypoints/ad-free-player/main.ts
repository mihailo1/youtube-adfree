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
  type AdFreePlaybackSnapshot,
  isBridgeMessage,
  isValidSnapshot
} from "@/lib/ad-free/bridge";
import {
  type KeepPlayingController,
  installKeepPlaying
} from "@/lib/ad-free/keep-playing";
import {
  type AdFreeCaptionTrack,
  type AdFreeQualityOption,
  type AdFreeStreamPayload,
  adFreeStreamStorageKey,
  normalizeAdFreeStreamPayload
} from "@/lib/ad-free/resolve-stream";
import { MessageType, sendMessage } from "@/lib/messaging/messaging";

const CAN_PLAY_TIMEOUT_MS = 20_000;

function postToParent(message: AdFreeBridgeFromPlayer) {
  try {
    parent.postMessage(message, "*");
  } catch {
    // ignore
  }
}

type VideoQualitySrc = {
  src: string;
  type?: string;
  width: number;
  height: number;
  bitrate?: number | null;
  id?: string;
};

type MediaPlayerEl = HTMLElement & {
  src?: string | VideoQualitySrc | VideoQualitySrc[];
  currentTime?: number;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  playbackRate?: number;
  quality?: { id?: string; src?: string; height?: number; width?: number } | null;
  startLoading?: () => void;
  play?: () => Promise<void>;
  pause?: () => void;
  textTracks?: {
    getById?: (id: string) => unknown;
  };
};

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

function guessMimeType(url: string, fallback?: string): string | undefined {
  if (fallback?.startsWith("video/")) {
    return fallback.split(";")[0]?.trim();
  }
  if (url.includes("mime=video%2Fwebm") || url.includes("mime=video/webm")) {
    return "video/webm";
  }
  if (url.includes("mime=video%2Fmp4") || url.includes("mime=video/mp4")) {
    return "video/mp4";
  }
  return undefined;
}

function toVideoQualitySrc(quality: AdFreeQualityOption): VideoQualitySrc | null {
  if (!/^https?:\/\//i.test(quality.videoUrl)) {
    return null;
  }

  const height = quality.height > 0 ? quality.height : 720;
  const width = quality.width && quality.width > 0
    ? quality.width
    : Math.round(height * 16 / 9);

  return {
    src: quality.videoUrl,
    type: guessMimeType(quality.videoUrl, quality.mimeType) ?? "video/mp4",
    width,
    height,
    bitrate: quality.bitrate ?? null,
    id: quality.id
  };
}

function appendCaptionTracks(
  elProvider: HTMLElement,
  captions: AdFreeCaptionTrack[]
) {
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

type CompanionAudioController = {
  setQuality: (quality: AdFreeQualityOption | null) => void;
  syncFromPlayer: () => void;
  suspend: () => void;
  releaseWhenPlaying: () => void;
  /** Tear down the audio element completely (frees decoded buffers). */
  dispose: () => void;
};

/**
 * Separate audio element for adaptive (video-only + audio-only) streams.
 * Gated until video "playing"; fully recreated on quality change to drop buffers.
 */
function createCompanionAudio(
  elPlayer: MediaPlayerEl,
  elMount: HTMLElement
): CompanionAudioController {
  let elAudio: HTMLAudioElement | null = null;
  let activeAudioUrl: string | null = null;
  let isSuspended = false;

  const disposeAudioElement = () => {
    if (!elAudio) {
      return;
    }
    try {
      elAudio.pause();
      elAudio.removeAttribute("src");
      elAudio.load();
    } catch {
      // ignore
    }
    elAudio.remove();
    elAudio = null;
    activeAudioUrl = null;
  };

  const ensureAudio = () => {
    if (elAudio) {
      return elAudio;
    }
    elAudio = document.createElement("audio");
    elAudio.preload = "metadata";
    elAudio.setAttribute("playsinline", "");
    elAudio.hidden = true;
    elMount.append(elAudio);
    return elAudio;
  };

  const silentStop = () => {
    if (!elAudio) {
      return;
    }
    elAudio.pause();
    elAudio.muted = true;
  };

  const suspend = () => {
    isSuspended = true;
    silentStop();
  };

  const alignClock = () => {
    if (!elAudio || !activeAudioUrl) {
      return;
    }
    const playerTime = Number(elPlayer.currentTime ?? 0);
    if (Number.isFinite(playerTime)) {
      try {
        elAudio.currentTime = playerTime;
      } catch {
        // ignore
      }
    }
    elAudio.playbackRate = Number(elPlayer.playbackRate ?? 1) || 1;
  };

  const applyUserVolume = () => {
    if (!elAudio || isSuspended) {
      return;
    }
    elAudio.volume = Number(elPlayer.volume ?? 1);
    elAudio.muted = Boolean(elPlayer.muted);
  };

  const releaseWhenPlaying = () => {
    if (!elAudio || !activeAudioUrl) {
      return;
    }
    if (elPlayer.paused) {
      isSuspended = false;
      silentStop();
      elAudio.muted = Boolean(elPlayer.muted);
      return;
    }
    isSuspended = false;
    alignClock();
    applyUserVolume();
    void elAudio.play().catch(() => {});
  };

  elPlayer.addEventListener("waiting", suspend);
  elPlayer.addEventListener("stalled", suspend);
  elPlayer.addEventListener("seeking", suspend);
  elPlayer.addEventListener("emptied", suspend);
  elPlayer.addEventListener("loadstart", suspend);
  elPlayer.addEventListener("pause", () => {
    silentStop();
  });
  elPlayer.addEventListener("ended", () => {
    isSuspended = false;
    silentStop();
  });
  elPlayer.addEventListener("playing", () => {
    releaseWhenPlaying();
  });
  elPlayer.addEventListener("seeked", () => {
    if (elAudio && activeAudioUrl) {
      alignClock();
      silentStop();
    }
  });
  elPlayer.addEventListener("volume-change", () => {
    applyUserVolume();
  });
  elPlayer.addEventListener("rate-change", () => {
    if (elAudio) {
      elAudio.playbackRate = Number(elPlayer.playbackRate ?? 1) || 1;
    }
  });

  return {
    suspend,
    releaseWhenPlaying,
    dispose: disposeAudioElement,
    setQuality(quality) {
      suspend();
      // Always drop the previous audio element so decoded buffers can be GC'd
      disposeAudioElement();

      if (!quality || quality.isProgressive || !quality.audioUrl) {
        return;
      }

      activeAudioUrl = quality.audioUrl;
      const audio = ensureAudio();
      audio.src = quality.audioUrl;
      alignClock();
      silentStop();
    },
    syncFromPlayer() {
      if (elPlayer.paused) {
        isSuspended = false;
        silentStop();
        if (elAudio) {
          elAudio.muted = Boolean(elPlayer.muted);
        }
        return;
      }
      releaseWhenPlaying();
    }
  };
}

/** Drop buffered media from the provider video element(s). */
function hardResetVideoElements(elPlayer: MediaPlayerEl) {
  try {
    elPlayer.pause?.();
  } catch {
    // ignore
  }
  try {
    // Detach current source so the previous progressive buffer can be GC'd
    elPlayer.src = "";
  } catch {
    // ignore
  }
  for (const el of elPlayer.querySelectorAll("video")) {
    const elVideo = el as HTMLVideoElement;
    try {
      elVideo.pause();
      elVideo.removeAttribute("src");
      elVideo.srcObject = null;
      elVideo.load();
    } catch {
      // ignore
    }
  }
}

function buildQualityMenu(
  qualities: AdFreeQualityOption[],
  selectedId: string,
  onSelect: (quality: AdFreeQualityOption) => void
) {
  const elWrap = document.createElement("div");
  elWrap.className = "quality-menu";
  elWrap.id = "quality-menu";

  const elButton = document.createElement("button");
  elButton.type = "button";
  elButton.className = "quality-menu-button";

  const selected = qualities.find(q => q.id === selectedId) ?? qualities[0];
  const setLabel = (label: string) => {
    elButton.textContent = label;
  };
  setLabel(selected.label);

  const elList = document.createElement("ul");
  elList.className = "quality-menu-list";
  elList.hidden = true;

  const close = () => {
    elList.hidden = true;
  };

  elButton.addEventListener("click", e => {
    e.stopPropagation();
    elList.hidden = !elList.hidden;
  });
  document.addEventListener("click", close);

  for (const quality of qualities) {
    const elItem = document.createElement("li");
    elItem.className = "quality-menu-item";
    if (quality.id === selected.id) {
      elItem.classList.add("is-selected");
    }
    elItem.textContent = quality.label
      + (quality.isProgressive ? " · muxed" : "");
    elItem.addEventListener("click", e => {
      e.stopPropagation();
      for (const child of elList.children) {
        child.classList.remove("is-selected");
      }
      elItem.classList.add("is-selected");
      setLabel(quality.label);
      close();
      onSelect(quality);
    });
    elList.append(elItem);
  }

  elWrap.append(elButton, elList);
  return { el: elWrap, setLabel };
}

/** Parse YouTube-style time: "90", "90.5", "1h2m3s", "2m", "45s". */
export function parseYoutubeTimeToSeconds(raw: string | null | undefined): number {
  if (!raw) {
    return 0;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return 0;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  const match = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!match) {
    return 0;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function readInitialTime(params: URLSearchParams): number {
  // Prefer explicit player t=, then YouTube-style start=
  return parseYoutubeTimeToSeconds(params.get("t"))
    || parseYoutubeTimeToSeconds(params.get("start"));
}

function capturePlayerSnapshot(elPlayer: MediaPlayerEl, videoId: string): AdFreePlaybackSnapshot {
  return {
    videoId,
    currentTime: Number(elPlayer.currentTime ?? 0) || 0,
    wasPlaying: !elPlayer.paused,
    playbackRate: Number(elPlayer.playbackRate ?? 1) || 1,
    volume: Number(elPlayer.volume ?? 1) || 1,
    muted: Boolean(elPlayer.muted)
  };
}

function applyPlayerSnapshot(
  elPlayer: MediaPlayerEl,
  companionAudio: CompanionAudioController,
  snapshot: AdFreePlaybackSnapshot,
  forcePause: boolean,
  keepPlaying?: KeepPlayingController | null
) {
  const time = Math.max(0, snapshot.currentTime);

  const applyTime = () => {
    elPlayer.currentTime = time;
    companionAudio.syncFromPlayer();
  };

  applyTime();
  // Media elements often ignore the first seek until the stream is ready
  window.requestAnimationFrame(applyTime);
  window.setTimeout(applyTime, 50);
  window.setTimeout(applyTime, 250);

  elPlayer.playbackRate = snapshot.playbackRate > 0 ? snapshot.playbackRate : 1;
  elPlayer.volume = Math.min(1, Math.max(0, snapshot.volume));
  elPlayer.muted = snapshot.muted;
  companionAudio.syncFromPlayer();

  if (forcePause || !snapshot.wasPlaying) {
    keepPlaying?.setWantsPlaying(false);
    if (keepPlaying) {
      keepPlaying.allowPause(() => {
        elPlayer.pause?.();
      });
    } else {
      elPlayer.pause?.();
    }
    companionAudio.syncFromPlayer();
    return;
  }

  keepPlaying?.setWantsPlaying(true);
  void elPlayer.play?.().catch(() => {});
  companionAudio.syncFromPlayer();
}

function renderPlayer(
  elContainer: HTMLElement,
  payload: AdFreeStreamPayload,
  videoId: string,
  options: {
    isEmbed: boolean;
    initialTime: number;
    startPaused: boolean;
  }
) {
  const { isEmbed, initialTime, startPaused } = options;
  const qualities = payload.qualities;
  if (qualities.length === 0) {
    renderError(elContainer, "No quality options available");
    return;
  }

  // Prefer progressive/muxed first (one media buffer), then highest adaptive.
  const orderedQualities = [...qualities].sort((a, b) => {
    if (a.isProgressive !== b.isProgressive) {
      return a.isProgressive ? -1 : 1;
    }
    return (b.height ?? 0) - (a.height ?? 0);
  });

  let activeQuality = orderedQualities.find(q => q.id === payload.selectedQualityId)
    ?? orderedQualities.find(q => q.isProgressive)
    ?? orderedQualities[0];

  if (!toVideoQualitySrc(activeQuality)) {
    renderError(elContainer, "No valid stream URLs found");
    return;
  }

  const keepPlaying = isEmbed ? installKeepPlaying() : null;

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

  const elPlayer = document.createElement("media-player") as MediaPlayerEl;
  elPlayer.setAttribute("title", payload.title);
  elPlayer.setAttribute("artist", payload.author);
  elPlayer.setAttribute("poster", youtubeThumbnailUrl(videoId));
  elPlayer.setAttribute("playsinline", "");
  // Autoplay only when not starting paused (player switch always starts paused).
  if (!startPaused && initialTime <= 0) {
    elPlayer.setAttribute("autoplay", "");
  }
  elPlayer.setAttribute("view-type", "video");
  elPlayer.setAttribute("stream-type", "on-demand");
  elPlayer.setAttribute("load", "eager");
  // metadata only — full auto preload of multi-hour streams OOMs after seeks/quality flips
  elPlayer.setAttribute("preload", "metadata");

  const elProvider = document.createElement("media-provider");
  appendCaptionTracks(elProvider, payload.captions ?? []);

  const elLayout = document.createElement("media-video-layout");
  elPlayer.append(elProvider, elLayout);
  elPlayerWrap.append(elPlayer);

  const companionAudio = createCompanionAudio(elPlayer, elPlayerWrap);

  let isSettled = false;
  let loadTimeoutId = 0;
  let pendingSnapshot: {
    snapshot: AdFreePlaybackSnapshot;
    forcePause: boolean;
    requestId?: string;
  } | null = null;
  let qualityMenuLabel = activeQuality.label;

  const clearLoadTimeout = () => {
    if (loadTimeoutId) {
      window.clearTimeout(loadTimeoutId);
      loadTimeoutId = 0;
    }
  };

  const armLoadTimeout = () => {
    clearLoadTimeout();
    loadTimeoutId = window.setTimeout(() => {
      if (isSettled) {
        return;
      }
      renderError(
        elContainer,
        "Stream is taking too long to start. Toggle Ad-Free off/on, or try another video."
      );
    }, CAN_PLAY_TIMEOUT_MS);
  };

  const persistSelected = (quality: AdFreeQualityOption) => {
    const elBadge = document.getElementById("quality-badge");
    if (elBadge) {
      elBadge.textContent = quality.label;
    }
    qualityMenuLabel = quality.label;
    const elMenuBtn = document.querySelector(".quality-menu-button");
    if (elMenuBtn) {
      elMenuBtn.textContent = quality.label;
    }
    const nextPayload: AdFreeStreamPayload = {
      ...payload,
      selectedQualityId: quality.id,
      qualityLabel: quality.label,
      progressiveUrl: quality.isProgressive ? quality.videoUrl : null,
      videoUrl: quality.isProgressive ? null : quality.videoUrl,
      audioUrl: quality.audioUrl
    };
    void browser.storage.session.set({
      [adFreeStreamStorageKey(videoId)]: nextPayload
    });
  };

  /**
   * Load exactly one quality URL. Never pass multi-src quality arrays to Vidstack —
   * that kept every rendition's buffers alive (10–30GB RAM after repeated seeks).
   */
  const loadSingleQuality = (
    quality: AdFreeQualityOption,
    resumeAt: number,
    wasPlaying: boolean
  ) => {
    const src = toVideoQualitySrc(quality);
    if (!src) {
      return;
    }

    companionAudio.suspend();
    keepPlaying?.allowPause(() => {
      try {
        elPlayer.pause?.();
      } catch {
        // ignore
      }
    });

    hardResetVideoElements(elPlayer);
    companionAudio.setQuality(quality);

    elPlayer.src = src;
    activeQuality = quality;
    persistSelected(quality);

    pendingSnapshot = {
      snapshot: {
        videoId,
        currentTime: Math.max(0, resumeAt),
        wasPlaying,
        playbackRate: Number(elPlayer.playbackRate ?? 1) || 1,
        volume: Number(elPlayer.volume ?? 1) || 1,
        muted: Boolean(elPlayer.muted)
      },
      forcePause: !wasPlaying
    };
    isSettled = false;
    armLoadTimeout();
    queueMicrotask(() => {
      try {
        elPlayer.startLoading?.();
      } catch {
        // ignore
      }
    });
  };

  const qualityMenu = buildQualityMenu(
    orderedQualities,
    activeQuality.id,
    quality => {
      if (quality.id === activeQuality.id) {
        return;
      }
      const resumeAt = Number(elPlayer.currentTime ?? 0) || 0;
      const wasPlaying = !elPlayer.paused;
      loadSingleQuality(quality, resumeAt, wasPlaying);
    }
  );

  // Track play intent for background keep-alive.
  let lastUserInputAt = 0;
  const USER_PAUSE_GESTURE_MS = 1_000;
  const markUserInput = () => {
    lastUserInputAt = Date.now();
  };

  elPlayer.addEventListener("play", () => {
    keepPlaying?.setWantsPlaying(true);
  });
  elPlayer.addEventListener("playing", () => {
    keepPlaying?.setWantsPlaying(true);
  });
  elPlayer.addEventListener("ended", () => {
    keepPlaying?.setWantsPlaying(false);
  });
  elPlayer.addEventListener("pause", () => {
    if (!keepPlaying) {
      return;
    }
    if (Date.now() - lastUserInputAt <= USER_PAUSE_GESTURE_MS) {
      keepPlaying.setWantsPlaying(false);
    }
  });

  elPlayer.addEventListener(
    "pointerdown",
    event => {
      const target = event.target as Element | null;
      if (!target) {
        return;
      }
      if (
        target.closest(
          "media-menu, media-menu-button, media-menu-items, media-menu-portal, "
          + "media-time-slider, media-volume-slider, media-slider, "
          + ".vds-slider, .vds-menu, .vds-menu-items, .quality-menu, input, select, textarea"
        )
      ) {
        return;
      }
      markUserInput();
    },
    true
  );
  elPlayer.addEventListener(
    "keydown",
    event => {
      if (
        event.key === " "
        || event.key === "k"
        || event.key === "K"
        || event.key === "MediaPlayPause"
      ) {
        markUserInput();
      }
    },
    true
  );

  if (initialTime > 0 || startPaused) {
    pendingSnapshot = {
      snapshot: {
        videoId,
        currentTime: initialTime,
        wasPlaying: false,
        playbackRate: 1,
        volume: 1,
        muted: false
      },
      forcePause: true
    };
    keepPlaying?.setWantsPlaying(false);
  }

  const flushPendingSnapshot = () => {
    if (!pendingSnapshot) {
      return;
    }
    const { snapshot, forcePause, requestId } = pendingSnapshot;
    pendingSnapshot = null;
    applyPlayerSnapshot(elPlayer, companionAudio, snapshot, forcePause, keepPlaying);
    if (requestId || isEmbed) {
      postToParent({
        type: AD_FREE_BRIDGE_TYPE,
        action: "set-state-done",
        requestId
      });
    }
  };

  elPlayer.addEventListener("can-play", () => {
    isSettled = true;
    clearLoadTimeout();
    flushPendingSnapshot();
    companionAudio.syncFromPlayer();
    if (isEmbed) {
      postToParent({
        type: AD_FREE_BRIDGE_TYPE,
        action: "ready",
        videoId
      });
    }
  }, { once: false });

  // After a long seek into unbuffered range, drop stale forward buffer pressure
  elPlayer.addEventListener("waiting", () => {
    companionAudio.suspend();
  });

  elPlayer.addEventListener("error", (event: Event) => {
    const detail = (event as CustomEvent<{ message?: string }>).detail;
    const detailMessage = detail && typeof detail === "object" && "message" in detail
      ? String(detail.message)
      : "";
    isSettled = true;
    clearLoadTimeout();
    renderError(
      elContainer,
      detailMessage
        || "Media error. Toggle Ad-Free off/on — stream URL may have expired."
    );
  });

  if (isEmbed) {
    window.addEventListener("message", (event: MessageEvent) => {
      if (!isBridgeMessage(event.data)) {
        return;
      }
      const message = event.data as AdFreeBridgeToPlayer;

      if (message.action === "ping") {
        postToParent({ type: AD_FREE_BRIDGE_TYPE, action: "pong" });
        return;
      }

      if (message.action === "get-state") {
        postToParent({
          type: AD_FREE_BRIDGE_TYPE,
          action: "state",
          requestId: message.requestId,
          snapshot: capturePlayerSnapshot(elPlayer, videoId)
        });
        return;
      }

      if (message.action === "pause") {
        keepPlaying?.setWantsPlaying(false);
        keepPlaying?.allowPause(() => {
          elPlayer.pause?.();
        });
        companionAudio.syncFromPlayer();
        return;
      }

      if (message.action === "set-state") {
        if (!isValidSnapshot(message.snapshot) || message.snapshot.videoId !== videoId) {
          return;
        }
        if (!isSettled) {
          pendingSnapshot = {
            snapshot: message.snapshot,
            forcePause: message.forcePause,
            requestId: message.requestId
          };
          return;
        }
        applyPlayerSnapshot(
          elPlayer,
          companionAudio,
          message.snapshot,
          message.forcePause,
          keepPlaying
        );
        postToParent({
          type: AD_FREE_BRIDGE_TYPE,
          action: "set-state-done",
          requestId: message.requestId
        });
      }
    });
  }

  // Initial single-source load
  companionAudio.suspend();
  loadSingleQuality(activeQuality, initialTime, !startPaused && initialTime <= 0);

  elPlayerWrap.append(qualityMenu.el);
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
    elBadge.textContent = qualityMenuLabel;

    const elHint = document.createElement("p");
    elHint.className = "quality-hint";
    const captionHint = (payload.captions?.length ?? 0) > 0
      ? ` · ${payload.captions.length} subtitle track(s) in Captions`
      : "";
    elHint.textContent = orderedQualities.length > 1
      ? `Quality menu (top-right) · Captions in Settings${captionHint}`
      : `Settings ⚙ → Captions${captionHint}`;

    elMeta.append(elTitle, elChannel, elBadge, elHint);
    elShell.append(elMeta);
    document.title = `${payload.title} · Ad-Free Player`;
  }

  elContainer.replaceChildren(elShell);
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
  const startPaused = params.get("paused") === "1" || isEmbed;

  if (!videoId) {
    renderError(elApp, "No video ID provided.");
    return;
  }

  renderLoading(elApp, isEmbed ? "Loading Ad-Free…" : "Loading stream...");

  try {
    const payload = await resolvePayload(videoId);
    renderPlayer(elApp, payload, videoId, {
      isEmbed,
      initialTime,
      startPaused
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderError(
      elApp,
      `${message}\n\nToggle Ad-Free again on the YouTube watch page.`
    );
  }
}

void init();
