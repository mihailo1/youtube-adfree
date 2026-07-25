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
};

function createCompanionAudio(
  elPlayer: MediaPlayerEl,
  elMount: HTMLElement
): CompanionAudioController {
  let elAudio: HTMLAudioElement | null = null;
  let activeAudioUrl: string | null = null;

  const ensureAudio = () => {
    if (elAudio) {
      return elAudio;
    }
    elAudio = document.createElement("audio");
    elAudio.preload = "auto";
    elAudio.setAttribute("playsinline", "");
    elAudio.hidden = true;
    elMount.append(elAudio);
    return elAudio;
  };

  const syncTime = () => {
    if (!elAudio || !activeAudioUrl) {
      return;
    }
    const playerTime = Number(elPlayer.currentTime ?? 0);
    if (Math.abs(elAudio.currentTime - playerTime) > 0.3) {
      elAudio.currentTime = playerTime;
    }
  };

  const syncVolume = () => {
    if (!elAudio) {
      return;
    }
    elAudio.volume = Number(elPlayer.volume ?? 1);
    elAudio.muted = Boolean(elPlayer.muted);
  };

  const onPlay = () => {
    if (!elAudio || !activeAudioUrl) {
      return;
    }
    syncTime();
    syncVolume();
    elAudio.playbackRate = Number(elPlayer.playbackRate ?? 1);
    void elAudio.play().catch(() => {});
  };

  const onPause = () => {
    elAudio?.pause();
  };

  elPlayer.addEventListener("play", onPlay);
  elPlayer.addEventListener("playing", onPlay);
  elPlayer.addEventListener("pause", onPause);
  elPlayer.addEventListener("seeking", syncTime);
  elPlayer.addEventListener("seeked", syncTime);
  elPlayer.addEventListener("time-update", syncTime);
  elPlayer.addEventListener("volume-change", syncVolume);
  elPlayer.addEventListener("rate-change", () => {
    if (elAudio) {
      elAudio.playbackRate = Number(elPlayer.playbackRate ?? 1);
    }
  });
  elPlayer.addEventListener("ended", () => {
    elAudio?.pause();
  });

  return {
    setQuality(quality) {
      if (!quality || quality.isProgressive || !quality.audioUrl) {
        activeAudioUrl = null;
        if (elAudio) {
          elAudio.pause();
          elAudio.removeAttribute("src");
          elAudio.load();
        }
        return;
      }

      const audio = ensureAudio();
      const resumeAt = Number(elPlayer.currentTime ?? 0);
      if (activeAudioUrl !== quality.audioUrl) {
        activeAudioUrl = quality.audioUrl;
        audio.src = quality.audioUrl;
      }
      audio.currentTime = resumeAt;
      if (!elPlayer.paused) {
        onPlay();
      }
    },
    syncFromPlayer() {
      syncTime();
      syncVolume();
      if (!elPlayer.paused) {
        onPlay();
      } else {
        onPause();
      }
    }
  };
}

function findQualityForPlayer(
  elPlayer: MediaPlayerEl,
  qualities: AdFreeQualityOption[],
  bySrc: Map<string, AdFreeQualityOption>
): AdFreeQualityOption | null {
  const current = elPlayer.quality;
  if (current?.id) {
    const byId = qualities.find(q => q.id === current.id);
    if (byId) {
      return byId;
    }
  }
  if (current?.src && typeof current.src === "string") {
    return bySrc.get(current.src) ?? null;
  }
  return qualities[0] ?? null;
}

function readInitialTime(params: URLSearchParams): number {
  const raw = params.get("t");
  if (!raw) {
    return 0;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
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
  elPlayer.currentTime = time;
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

  const qualitySources = qualities
    .map(toVideoQualitySrc)
    .filter((src): src is VideoQualitySrc => src != null);

  if (qualitySources.length === 0) {
    renderError(elContainer, "No valid stream URLs found");
    return;
  }

  const bySrc = new Map(qualities.map(q => [q.videoUrl, q]));
  const preferred = qualities.find(q => q.id === payload.selectedQualityId) ?? qualities[0];

  qualitySources.sort((a, b) => {
    if (a.id === preferred.id) {
      return -1;
    }
    if (b.id === preferred.id) {
      return 1;
    }
    return (b.height ?? 0) - (a.height ?? 0);
  });

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
  elPlayer.setAttribute("preload", "auto");

  const elProvider = document.createElement("media-provider");
  appendCaptionTracks(elProvider, payload.captions ?? []);

  const elLayout = document.createElement("media-video-layout");
  elPlayer.append(elProvider, elLayout);
  elPlayerWrap.append(elPlayer);

  const companionAudio = createCompanionAudio(elPlayer, elPlayerWrap);

  elPlayer.src = qualitySources.length === 1 ? qualitySources[0] : qualitySources;
  companionAudio.setQuality(preferred);

  // Track play intent for background keep-alive.
  // Any pause that follows recent user input (click on video, play button, space…)
  // is treated as intentional — clear wantsPlaying so the poll won't re-play.
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
    // Bridge pause already cleared wantsPlaying; system/background pauses have no
    // recent gesture and keep wantsPlaying so the poll resumes.
    if (Date.now() - lastUserInputAt <= USER_PAUSE_GESTURE_MS) {
      keepPlaying.setWantsPlaying(false);
    }
  });

  // Capture clicks/taps anywhere on the player (video surface, gestures, controls)
  // except pure scrubbing/menus where pause is not the intent.
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
          + ".vds-slider, .vds-menu, .vds-menu-items, input, select, textarea"
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

  let isSettled = false;
  let loadTimeoutId = 0;
  let pendingSnapshot: { snapshot: AdFreePlaybackSnapshot; forcePause: boolean; requestId?: string } | null = null;

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

  const onQualityOrSourceChange = () => {
    const quality = findQualityForPlayer(elPlayer, qualities, bySrc);
    if (!quality) {
      return;
    }
    companionAudio.setQuality(quality);
    companionAudio.syncFromPlayer();
    persistSelected(quality);
  };

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

  elPlayer.addEventListener("quality-change", () => {
    onQualityOrSourceChange();
  });

  elPlayer.addEventListener("source-change", () => {
    onQualityOrSourceChange();
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

  armLoadTimeout();

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
    elBadge.textContent = preferred.label;

    const elHint = document.createElement("p");
    elHint.className = "quality-hint";
    const captionHint = (payload.captions?.length ?? 0) > 0
      ? ` · ${payload.captions.length} subtitle track(s) in Captions`
      : "";
    elHint.textContent = qualitySources.length > 1
      ? `Settings ⚙ → Quality / Captions${captionHint}`
      : `Settings ⚙ → Captions${captionHint}`;

    elMeta.append(elTitle, elChannel, elBadge, elHint);
    elShell.append(elMeta);
    document.title = `${payload.title} · Ad-Free Player`;
  }

  elContainer.replaceChildren(elShell);

  queueMicrotask(() => {
    try {
      elPlayer.startLoading?.();
    } catch {
      // ignore
    }
  });
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
