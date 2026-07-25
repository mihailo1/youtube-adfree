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

function buildQualitySources(
  qualities: AdFreeQualityOption[],
  preferredId: string
): VideoQualitySrc[] {
  const sources = qualities
    .map(toVideoQualitySrc)
    .filter((src): src is VideoQualitySrc => src != null);
  sources.sort((a, b) => {
    if (a.id === preferredId) {
      return -1;
    }
    if (b.id === preferredId) {
      return 1;
    }
    return (b.height ?? 0) - (a.height ?? 0);
  });
  return sources;
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
  dispose: () => void;
};

/**
 * Adaptive audio is a separate element. Never play it until video is truly
 * "playing" after seek/buffer/quality change — otherwise audio CDN wins the race
 * and a short blip repeats when clocks re-align.
 */
function createCompanionAudio(
  elPlayer: MediaPlayerEl,
  elMount: HTMLElement
): CompanionAudioController {
  let elAudio: HTMLAudioElement | null = null;
  let activeAudioUrl: string | null = null;
  let isSuspended = true;

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
    if (!Number.isFinite(playerTime)) {
      return;
    }
    try {
      if (Math.abs(elAudio.currentTime - playerTime) > 0.05) {
        elAudio.currentTime = playerTime;
      }
    } catch {
      // ignore until metadata
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
      isSuspended = true;
      silentStop();
      elAudio.muted = Boolean(elPlayer.muted);
      return;
    }

    // Recover if the element errored out during a long seek
    if (elAudio.error) {
      const url = activeAudioUrl;
      disposeAudioElement();
      activeAudioUrl = url;
      const audio = ensureAudio();
      audio.src = url;
    }

    isSuspended = false;
    alignClock();
    applyUserVolume();
    void elAudio.play().catch(() => {
      // one retry after a short delay (audio element still loading)
      window.setTimeout(() => {
        if (!isSuspended && elAudio && !elPlayer.paused) {
          alignClock();
          applyUserVolume();
          void elAudio.play().catch(() => {});
        }
      }, 120);
    });
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
    isSuspended = true;
    silentStop();
  });
  // Only unlock on real frame playback — not on "play" while still buffering
  elPlayer.addEventListener("playing", () => {
    releaseWhenPlaying();
  });
  elPlayer.addEventListener("seeked", () => {
    if (elAudio && activeAudioUrl) {
      alignClock();
      // stay silent until "playing"
      silentStop();
    }
  });
  elPlayer.addEventListener("can-play", () => {
    // If already in playing state after seek into buffer, unlock
    if (!elPlayer.paused && !isSuspended) {
      releaseWhenPlaying();
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
        isSuspended = true;
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

function parseYoutubeTimeToSeconds(raw: string | null | undefined): number {
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
  const total = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function readInitialTime(params: URLSearchParams): number {
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

/**
 * Apply time/volume once media can seek. Avoid multi-shot seeks that flash 0
 * and avoid starting play before can-play (mini-repeat of old buffer).
 */
function applyPlayerSnapshot(
  elPlayer: MediaPlayerEl,
  companionAudio: CompanionAudioController,
  snapshot: AdFreePlaybackSnapshot,
  forcePause: boolean,
  keepPlaying?: KeepPlayingController | null
) {
  const time = Math.max(0, snapshot.currentTime);

  companionAudio.suspend();

  try {
    elPlayer.currentTime = time;
  } catch {
    // ignore until metadata
  }

  elPlayer.playbackRate = snapshot.playbackRate > 0 ? snapshot.playbackRate : 1;
  elPlayer.volume = Math.min(1, Math.max(0, snapshot.volume));
  elPlayer.muted = snapshot.muted;

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

  // Wait for can-play / playing — do not play immediately after seek/source swap
  keepPlaying?.setWantsPlaying(true);
  void elPlayer.play?.().catch(() => {});
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

  // Progressive first for default, then by height
  const orderedQualities = [...qualities].sort((a, b) => {
    if (a.isProgressive !== b.isProgressive) {
      return a.isProgressive ? -1 : 1;
    }
    return (b.height ?? 0) - (a.height ?? 0);
  });

  let activeQuality = orderedQualities.find(q => q.id === payload.selectedQualityId)
    ?? orderedQualities.find(q => q.isProgressive)
    ?? orderedQualities[0];

  const allSources = buildQualitySources(orderedQualities, activeQuality.id);
  if (allSources.length === 0) {
    renderError(elContainer, "No valid stream URLs found");
    return;
  }

  const bySrc = new Map(orderedQualities.map(q => [q.videoUrl, q]));
  const byId = new Map(orderedQualities.map(q => [q.id, q]));

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
  if (!startPaused && initialTime <= 0) {
    elPlayer.setAttribute("autoplay", "");
  }
  elPlayer.setAttribute("view-type", "video");
  elPlayer.setAttribute("stream-type", "on-demand");
  elPlayer.setAttribute("load", "eager");
  elPlayer.setAttribute("preload", "metadata");

  const elProvider = document.createElement("media-provider");
  appendCaptionTracks(elProvider, payload.captions ?? []);
  const elLayout = document.createElement("media-video-layout");
  elPlayer.append(elProvider, elLayout);
  elPlayerWrap.append(elPlayer);

  const companionAudio = createCompanionAudio(elPlayer, elPlayerWrap);

  let isSettled = false;
  let isReloading = false;
  let lastKnownGoodTime = Math.max(0, initialTime);
  let loadTimeoutId = 0;
  let pendingSnapshot: {
    snapshot: AdFreePlaybackSnapshot;
    forcePause: boolean;
    requestId?: string;
  } | null = null;
  let hasAnnouncedReady = false;

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

  const resolveQualityFromPlayer = (): AdFreeQualityOption | null => {
    const current = elPlayer.quality;
    if (current?.id) {
      const byQualityId = byId.get(String(current.id));
      if (byQualityId) {
        return byQualityId;
      }
    }
    if (current?.src && typeof current.src === "string") {
      return bySrc.get(current.src) ?? null;
    }
    if (typeof current?.height === "number") {
      const match = orderedQualities.find(q => q.height === current.height);
      if (match) {
        return match;
      }
    }
    return activeQuality;
  };

  /**
   * Multi-src list for Vidstack Settings → Quality UI.
   * Preferred rendition first so only it starts buffering.
   * On switch we re-order + soft reload and wait for can-play before play.
   */
  const loadQualities = (
    preferred: AdFreeQualityOption,
    resumeAt: number,
    wasPlaying: boolean
  ) => {
    const sources = buildQualitySources(orderedQualities, preferred.id);
    if (sources.length === 0) {
      return;
    }

    isReloading = true;
    companionAudio.suspend();
    keepPlaying?.allowPause(() => {
      try {
        elPlayer.pause?.();
      } catch {
        // ignore
      }
    });

    // Soft replace: do NOT assign src="" (that zeros the timeline UI).
    // Dispose companion audio fully; reset only provider <video> buffers.
    companionAudio.setQuality(preferred);
    for (const el of elPlayer.querySelectorAll("video")) {
      const elVideo = el as HTMLVideoElement;
      try {
        elVideo.pause();
      } catch {
        // ignore
      }
    }

    elPlayer.src = sources.length === 1 ? sources[0] : sources;
    activeQuality = preferred;
    persistSelected(preferred);

    pendingSnapshot = {
      snapshot: {
        videoId,
        currentTime: Math.max(0, resumeAt),
        wasPlaying,
        playbackRate: Number(elPlayer.playbackRate ?? 1) || 1,
        volume: Number(elPlayer.volume ?? 1) || 1,
        muted: Boolean(elPlayer.muted)
      },
      // Never play until can-play applied the resume time (prevents mini-repeat)
      forcePause: true
    };
    // Store intent to resume after ready
    if (wasPlaying) {
      pendingSnapshot.snapshot.wasPlaying = true;
      // forcePause stays true until can-play, then we play if wasPlaying
    }

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

  // Track time only when not mid-reload (avoids writing 0 into lastKnownGoodTime)
  elPlayer.addEventListener("time-update", () => {
    if (isReloading) {
      return;
    }
    const t = Number(elPlayer.currentTime ?? 0);
    if (Number.isFinite(t) && t > 0) {
      lastKnownGoodTime = t;
    }
  });

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
    if (!isReloading) {
      companionAudio.releaseWhenPlaying();
    }
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

  const flushPendingSnapshot = () => {
    if (!pendingSnapshot) {
      return;
    }
    const { snapshot, requestId } = pendingSnapshot;
    const shouldPlay = snapshot.wasPlaying;
    pendingSnapshot = null;
    isReloading = false;

    // Apply time first while still paused
    applyPlayerSnapshot(
      elPlayer,
      companionAudio,
      {
        ...snapshot,
        wasPlaying: false
      },
      true,
      keepPlaying
    );

    // Only then start playback — stream is ready at resumeAt
    if (shouldPlay) {
      keepPlaying?.setWantsPlaying(true);
      void elPlayer.play?.().catch(() => {});
    }

    if (requestId || isEmbed) {
      postToParent({
        type: AD_FREE_BRIDGE_TYPE,
        action: "set-state-done",
        requestId
      });
    }
  };

  elPlayer.addEventListener("loaded-metadata", () => {
    // Restore timeline ASAP so the scrubber does not sit at 0
    const pendingTime = pendingSnapshot?.snapshot.currentTime;
    const time = pendingTime ?? (isReloading ? lastKnownGoodTime : null);
    if (time != null && time > 0) {
      try {
        elPlayer.currentTime = time;
      } catch {
        // ignore
      }
    }
  });

  elPlayer.addEventListener("can-play", () => {
    isSettled = true;
    clearLoadTimeout();
    flushPendingSnapshot();
    if (isEmbed && !hasAnnouncedReady) {
      hasAnnouncedReady = true;
      postToParent({
        type: AD_FREE_BRIDGE_TYPE,
        action: "ready",
        videoId
      });
    }
  });

  // Vidstack Settings → Quality (multi-src list).
  // On user quality pick we do a controlled soft reload and only resume after can-play.
  elPlayer.addEventListener("quality-change", () => {
    const quality = resolveQualityFromPlayer();
    if (!quality) {
      return;
    }

    // Ignore events fired while we are already reloading sources
    if (isReloading) {
      activeQuality = quality;
      persistSelected(quality);
      return;
    }

    if (quality.id === activeQuality.id) {
      return;
    }

    const resumeAt = lastKnownGoodTime > 0
      ? lastKnownGoodTime
      : Number(elPlayer.currentTime ?? 0) || 0;
    const wasPlaying = !elPlayer.paused || Boolean(keepPlaying?.getWantsPlaying());
    loadQualities(quality, resumeAt, wasPlaying);
  });

  elPlayer.addEventListener("error", (event: Event) => {
    const detail = (event as CustomEvent<{ message?: string }>).detail;
    const detailMessage = detail && typeof detail === "object" && "message" in detail
      ? String(detail.message)
      : "";
    isSettled = true;
    isReloading = false;
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
        const snap = capturePlayerSnapshot(elPlayer, videoId);
        if (isReloading && lastKnownGoodTime > 0) {
          snap.currentTime = lastKnownGoodTime;
        }
        postToParent({
          type: AD_FREE_BRIDGE_TYPE,
          action: "state",
          requestId: message.requestId,
          snapshot: snap
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
        lastKnownGoodTime = Math.max(lastKnownGoodTime, message.snapshot.currentTime);
        if (!isSettled || isReloading) {
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

  // Initial load — multi-src for Settings quality menu; preferred first
  companionAudio.suspend();
  loadQualities(
    activeQuality,
    initialTime,
    !startPaused && initialTime <= 0
  );

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
    elBadge.textContent = activeQuality.label;

    const elHint = document.createElement("p");
    elHint.className = "quality-hint";
    const captionHint = (payload.captions?.length ?? 0) > 0
      ? ` · ${payload.captions.length} subtitle track(s)`
      : "";
    elHint.textContent = orderedQualities.length > 1
      ? `Settings ⚙ → Quality / Captions${captionHint}`
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
