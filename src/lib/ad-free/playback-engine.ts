import type { AdFreePlaybackSnapshot } from "@/lib/ad-free/bridge";
import {
  bufferAheadSeconds,
  createAdFreeLogger,
  formatBuffered,
  mediaSnapshot
} from "@/lib/ad-free/debug-log";
import {
  createMseController,
  qualitySupportsMse,
  type MseController
} from "@/lib/ad-free/mse/mse-controller";
import type { AdFreeQualityOption } from "@/lib/ad-free/resolve-stream";

export type PlaybackState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "seeking"
  | "switching"
  | "error";

export type MediaPlayerLike = HTMLElement & {
  src?: string | { src: string; type?: string; width?: number; height?: number; id?: string };
  currentTime?: number;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  playbackRate?: number;
  startLoading?: () => void;
  play?: () => Promise<void>;
  pause?: () => void;
  duration?: number;
  readyState?: number;
  state?: { canPlay?: boolean };
};

export type PlaybackEngine = {
  getState: () => PlaybackState;
  getGeneration: () => number;
  getActiveQuality: () => AdFreeQualityOption;
  getLastKnownGoodTime: () => number;
  isSafeToResume: () => boolean;
  isBusy: () => boolean;
  getVideoElement: () => HTMLVideoElement | null;
  getAudioElement: () => HTMLAudioElement | null;
  captureSnapshot: (videoId: string) => AdFreePlaybackSnapshot;
  loadQuality: (quality: AdFreeQualityOption, options?: {
    resumeAt?: number;
    wasPlaying?: boolean;
  }) => Promise<void>;
  seek: (time: number, options?: { wasPlaying?: boolean }) => Promise<void>;
  applySnapshot: (snapshot: AdFreePlaybackSnapshot, forcePause: boolean) => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  setWantsPlaying: (value: boolean) => void;
  getWantsPlaying: () => boolean;
  dispose: () => void;
};

type EngineOptions = {
  elPlayer: MediaPlayerLike;
  elMount: HTMLElement;
  initialQuality: AdFreeQualityOption;
  /** Wall-clock duration from ANDROID_VR (for MSE mid time→byte map). */
  durationSeconds?: number;
  onStateChange?: (state: PlaybackState) => void;
  onQualityChange?: (quality: AdFreeQualityOption) => void;
  onError?: (message: string) => void;
  allowPause?: <T>(run: () => T) => T;
  canPlayTimeoutMs?: number;
};

const DEFAULT_CAN_PLAY_MS = 25_000;
const EVENT_WAIT_MS = 8_000;
const AUDIO_SEEK_WAIT_MS = 3_000;
const HAVE_FUTURE_DATA = 3;
const HEALTH_POLL_MS = 1000;
const STALL_TIME_EPS = 0.05;
/** Hard seek only above this — smaller drift uses playbackRate nudge. */
const AUDIO_HARD_ALIGN = 0.55;
/** Never hard-seek audio for tiny drift (log: hard-align 0.006 → audio seeking thrash). */
const AUDIO_HARD_ALIGN_MIN = 0.12;
/** Drift beyond this means video/audio are on different timelines — barrier resync. */
const AUDIO_CATASTROPHIC_DRIFT = 4;
const AUDIO_RATE_NUDGE_MAX = 0.06;
const AUDIO_ALIGN_COOLDOWN_MS = 2_500;
/** Don't call play() when buffer is thinner than this — causes 0.2s play/reset loop. */
const MIN_PLAY_AHEAD_S = 1.2;
/** After underrun, wait until this much video is buffered before resuming. */
const REBUFFER_TARGET_S = 4.0;
/** Accept seek landing within this many seconds of target. */
const SEEK_LAND_TOLERANCE_S = 1.75;
const SEEK_VERIFY_ATTEMPTS = 3;
/**
 * Jumping audio currentTime by more than this freezes the element (log: +691s seek).
 * Recreate with #t= fragment instead.
 */
const AUDIO_RECREATE_JUMP_S = 12;
/** Debounce Vidstack scrub seeked storms into one engine.seek(). */
const USER_SEEK_DEBOUNCE_MS = 180;
/** Adaptive (esp. 1080p) needs a larger initial cushion — audio used to steal the pipe. */
const MIN_BUFFER_AHEAD_PROGRESSIVE_S = 1.5;
const MIN_BUFFER_AHEAD_ADAPTIVE_S = 4.0;
const MIN_BUFFER_AHEAD_ADAPTIVE_HI_S = 5.5;
const MIN_BUFFER_WAIT_MS = 14_000;
const log = createAdFreeLogger("engine");

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

/** Media fragment helps browsers range-fetch near resume point (critical mid-video). */
function withTimeFragment(url: string, seconds: number): string {
  const base = url.split("#")[0] ?? url;
  if (!Number.isFinite(seconds) || seconds < 1) {
    return base;
  }
  return `${base}#t=${Math.floor(seconds)}`;
}

function toSingleSrc(quality: AdFreeQualityOption, startAt = 0) {
  const height = quality.height > 0 ? quality.height : 720;
  const width = quality.width && quality.width > 0
    ? quality.width
    : Math.round(height * 16 / 9);
  return {
    src: withTimeFragment(quality.videoUrl, startAt),
    type: guessMimeType(quality.videoUrl, quality.mimeType) ?? "video/mp4",
    width,
    height,
    id: quality.id
  };
}

function waitForEvent(
  target: EventTarget,
  eventName: string,
  timeoutMs: number,
  isCurrent: () => boolean,
  label: string
): Promise<boolean> {
  return new Promise(resolve => {
    if (!isCurrent()) {
      resolve(false);
      return;
    }

    const started = Date.now();
    log.debug(`wait ${label} for ${eventName}`);

    const timer = window.setTimeout(() => {
      cleanup();
      log.warn(`timeout ${label} waiting ${eventName}`, { ms: timeoutMs });
      resolve(false);
    }, timeoutMs);

    function onEvent() {
      cleanup();
      log.debug(`got ${label} ${eventName}`, { ms: Date.now() - started });
      resolve(true);
    }

    function cleanup() {
      window.clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
    }

    target.addEventListener(eventName, onEvent);
  });
}

function mediaReadyState(elPlayer: MediaPlayerLike): number {
  const elVideo = elPlayer.querySelector("video");
  if (elVideo instanceof HTMLVideoElement) {
    return elVideo.readyState;
  }
  if (typeof elPlayer.readyState === "number") {
    return elPlayer.readyState;
  }
  if (elPlayer.state?.canPlay) {
    return HAVE_FUTURE_DATA;
  }
  return 0;
}

function getProviderVideo(elPlayer: MediaPlayerLike): HTMLVideoElement | null {
  const elVideo = elPlayer.querySelector("video");
  return elVideo instanceof HTMLVideoElement ? elVideo : null;
}

/** True when we can safely finish a transition (not stuck seeking with no data). */
function isPlayableEnough(elPlayer: MediaPlayerLike, atTime?: number): boolean {
  const elVideo = getProviderVideo(elPlayer);
  if (!elVideo) {
    return mediaReadyState(elPlayer) >= 2;
  }
  if (elVideo.error) {
    return false;
  }
  // Stuck seeking with no local data is NOT playable
  if (elVideo.seeking && elVideo.readyState < 2 && bufferAheadSeconds(elVideo, atTime) < 0.2) {
    return false;
  }
  if (elVideo.readyState >= HAVE_FUTURE_DATA) {
    return true;
  }
  // HAVE_CURRENT_DATA + some buffer ahead is enough to proceed and keep filling
  if (elVideo.readyState >= 2 && bufferAheadSeconds(elVideo, atTime) >= 0.4) {
    return true;
  }
  return false;
}

/**
 * If target is just outside a buffered range, snap into it so the demuxer unsticks.
 * Log case: target 6637, buffered 6631-6634 → snap to 6634.
 */
function snapToNearbyBuffer(elVideo: HTMLVideoElement, target: number): number | null {
  try {
    const ranges = elVideo.buffered;
    if (!ranges.length) {
      return null;
    }
    let best: number | null = null;
    let bestDist = Infinity;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const end = ranges.end(index);
      if (target >= start && target <= end) {
        return target;
      }
      // Prefer end of range just before target (most common mid-video stall)
      if (target > end && target - end < 8) {
        const candidate = Math.max(start, end - 0.15);
        const dist = target - end;
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
      if (target < start && start - target < 8) {
        const dist = start - target;
        if (dist < bestDist) {
          bestDist = dist;
          best = start + 0.05;
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

function waitForCanPlay(
  elPlayer: MediaPlayerLike,
  timeoutMs: number,
  isCurrent: () => boolean,
  atTime?: number
): Promise<boolean> {
  return new Promise(resolve => {
    if (!isCurrent()) {
      resolve(false);
      return;
    }

    if (isPlayableEnough(elPlayer, atTime)) {
      log.debug("can-play already ready", {
        readyState: mediaReadyState(elPlayer),
        ahead: bufferAheadSeconds(getProviderVideo(elPlayer), atTime)
      });
      resolve(true);
      return;
    }

    const started = Date.now();
    log.debug("wait can-play", { atTime });

    const timer = window.setTimeout(() => {
      cleanup();
      const isReady = isPlayableEnough(elPlayer, atTime);
      log.warn("can-play timeout", {
        ms: timeoutMs,
        isReady,
        readyState: mediaReadyState(elPlayer),
        video: mediaSnapshot(getProviderVideo(elPlayer))
      });
      resolve(isReady);
    }, timeoutMs);

    function onMaybeReady() {
      if (!isCurrent()) {
        cleanup();
        resolve(false);
        return;
      }
      if (isPlayableEnough(elPlayer, atTime)) {
        cleanup();
        log.debug("can-play ready", { ms: Date.now() - started });
        resolve(true);
      }
    }

    function onError() {
      cleanup();
      log.error("media error while loading", mediaSnapshot(getProviderVideo(elPlayer)));
      resolve(false);
    }

    function cleanup() {
      window.clearTimeout(timer);
      elPlayer.removeEventListener("can-play", onMaybeReady);
      elPlayer.removeEventListener("canplay", onMaybeReady);
      elPlayer.removeEventListener("loadeddata", onMaybeReady);
      elPlayer.removeEventListener("progress", onMaybeReady);
      elPlayer.removeEventListener("seeked", onMaybeReady);
      elPlayer.removeEventListener("error", onError);
      const elVideo = getProviderVideo(elPlayer);
      elVideo?.removeEventListener("progress", onMaybeReady);
      elVideo?.removeEventListener("canplay", onMaybeReady);
      elVideo?.removeEventListener("seeked", onMaybeReady);
    }

    elPlayer.addEventListener("can-play", onMaybeReady);
    elPlayer.addEventListener("canplay", onMaybeReady);
    elPlayer.addEventListener("loadeddata", onMaybeReady);
    elPlayer.addEventListener("progress", onMaybeReady);
    elPlayer.addEventListener("seeked", onMaybeReady);
    elPlayer.addEventListener("error", onError);
    const elVideo = getProviderVideo(elPlayer);
    elVideo?.addEventListener("progress", onMaybeReady);
    elVideo?.addEventListener("canplay", onMaybeReady);
    elVideo?.addEventListener("seeked", onMaybeReady);

    queueMicrotask(onMaybeReady);
  });
}

/** Wait until video has minAhead seconds buffered at currentTime (or timeout). */
function waitForBufferAhead(
  elPlayer: MediaPlayerLike,
  minAhead: number,
  timeoutMs: number,
  isCurrent: () => boolean
): Promise<boolean> {
  return new Promise(resolve => {
    const elVideo = getProviderVideo(elPlayer);
    if (!elVideo || !isCurrent()) {
      resolve(false);
      return;
    }

    const started = Date.now();
    const initial = bufferAheadSeconds(elVideo);
    if (initial >= minAhead) {
      log.debug("buffer already ok", { ahead: initial, minAhead });
      resolve(true);
      return;
    }

    log.debug("wait buffer ahead", { minAhead, initial });

    const timer = window.setTimeout(() => {
      cleanup();
      const ahead = bufferAheadSeconds(getProviderVideo(elPlayer));
      log.warn("buffer wait timeout", {
        ms: timeoutMs,
        ahead,
        minAhead,
        buffered: formatBuffered(getProviderVideo(elPlayer))
      });
      // Proceed with whatever we have — better than freezing forever
      resolve(ahead > 0.4);
    }, timeoutMs);

    function onProgress() {
      if (!isCurrent()) {
        cleanup();
        resolve(false);
        return;
      }
      const video = getProviderVideo(elPlayer);
      const ahead = bufferAheadSeconds(video);
      if (ahead >= minAhead) {
        cleanup();
        log.debug("buffer ready", { ahead, ms: Date.now() - started });
        resolve(true);
      }
    }

    function cleanup() {
      window.clearTimeout(timer);
      elPlayer.removeEventListener("progress", onProgress);
      elPlayer.removeEventListener("can-play", onProgress);
      elPlayer.removeEventListener("canplay", onProgress);
      elVideo?.removeEventListener("progress", onProgress);
    }

    elPlayer.addEventListener("progress", onProgress);
    elPlayer.addEventListener("can-play", onProgress);
    elPlayer.addEventListener("canplay", onProgress);
    elVideo.addEventListener("progress", onProgress);
  });
}

/**
 * Atomic single-rendition playback: one video URL at a time, generation-tokenled
 * seek/quality transitions, barrier sync for adaptive companion audio.
 */
export function createPlaybackEngine(options: EngineOptions): PlaybackEngine {
  const {
    elPlayer,
    elMount,
    initialQuality,
    durationSeconds: streamDurationSeconds = 0,
    onStateChange,
    onQualityChange,
    onError,
    allowPause,
    canPlayTimeoutMs = DEFAULT_CAN_PLAY_MS
  } = options;

  let state: PlaybackState = "idle";
  let generation = 0;
  let activeQuality = initialQuality;
  let lastKnownGoodTime = 0;
  let wantsPlaying = false;
  /**
   * Sticky watch intent: true after user hits play / we resume for them.
   * Cleared only by explicit pause() / setWantsPlaying(false) — not by ghost pause events.
   * Scrub/quality use this so they keep playing after timeline seeks.
   */
  let playbackIntent = false;
  let elAudio: HTMLAudioElement | null = null;
  let disposed = false;
  let lastHealthTime = -1;
  let stallTicks = 0;
  let lastAudioHardAlignAt = 0;
  let lastProgressLogAt = 0;
  /** Base audio URL without fragment — used to recreate on large seeks. */
  let activeAudioUrl: string | null = null;
  let userSeekDebounceId = 0;
  let userSeekWasPlaying = false;
  /** True from first user scrub seeking until engine.seek finishes — blocks play spam. */
  let isUserSeekPending = false;
  /** While true, ignore user-facing play/pause side-effects from intermediate events. */
  let isTransitionLocked = false;
  /** User mute preference — never confused with transition mute. */
  let userWantsMuted = false;
  /** >0 while we force-mute for load/seek; volume events must not steal user preference. */
  let transitionMuteDepth = 0;
  let rebufferPollId = 0;
  let isRebuffering = false;
  /** Dual-track MSE for adaptive avc1/av01 (Phase 1–2) — no companion <audio>. */
  let mse: MseController | null = null;
  /** Timestamp when user scrub lock was taken — stuck recovery if seeked never fires. */
  let userSeekPendingSince = 0;
  /** Ignore ghost pause events right after load/seek play (Vidstack/MSE flap). */
  let ignorePauseUntil = 0;
  /** Ignore spurious seeking right after MSE load/seek completes. */
  let ignoreUserSeekUntil = 0;
  let userSeekWatchdogId = 0;

  function armPauseGrace(ms = 1_800) {
    ignorePauseUntil = Date.now() + ms;
  }

  function armSeekIgnore(ms = 600) {
    ignoreUserSeekUntil = Date.now() + ms;
  }

  function adaptiveMinAhead(quality: AdFreeQualityOption): number {
    if (quality.isProgressive) {
      return MIN_BUFFER_AHEAD_PROGRESSIVE_S;
    }
    if ((quality.height ?? 0) >= 1080) {
      return MIN_BUFFER_AHEAD_ADAPTIVE_HI_S;
    }
    return MIN_BUFFER_AHEAD_ADAPTIVE_S;
  }

  function stopRebufferPoll() {
    if (rebufferPollId) {
      window.clearInterval(rebufferPollId);
      rebufferPollId = 0;
    }
    isRebuffering = false;
  }

  function startRebuffer(reason: string) {
    if (disposed || isBusy() || isRebuffering || !wantsPlaying) {
      return;
    }
    isRebuffering = true;
    log.info("rebuffer start", {
      reason,
      ahead: bufferAheadSeconds(getProviderVideo(elPlayer)),
      quality: activeQuality.label
    });
    runPause(() => {
      try {
        elPlayer.pause?.();
      } catch {
        // ignore
      }
    });
    suspendAudio("rebuffer");
    if (state === "playing") {
      setState("ready");
    }

    if (rebufferPollId) {
      window.clearInterval(rebufferPollId);
    }
    rebufferPollId = window.setInterval(() => {
      if (disposed || !wantsPlaying || isBusy()) {
        stopRebufferPoll();
        return;
      }
      // MSE: underrun often means playhead left the only buffered range (snap to 0)
      if (isMseActive()) {
        restoreMsePlayhead("rebuffer-poll");
      }
      const ahead = bufferAheadSeconds(getProviderVideo(elPlayer));
      if (ahead >= REBUFFER_TARGET_S) {
        log.info("rebuffer complete", { ahead });
        stopRebufferPoll();
        void requestPlay("rebuffer-done");
      }
    }, 250);
  }

  log.info("engine created", {
    quality: initialQuality.label,
    progressive: initialQuality.isProgressive,
    height: initialQuality.height
  });

  function setState(next: PlaybackState) {
    if (state === next) {
      return;
    }
    log.debug(`state ${state} → ${next}`, {
      gen: generation,
      wantsPlaying,
      t: Number(elPlayer.currentTime ?? 0)
    });
    state = next;
    onStateChange?.(next);
  }

  function isBusy() {
    // Note: isRebuffering is intentionally NOT busy — seek/quality must stay possible.
    // requestPlay/play gate underrun separately via hasPlayableBuffer.
    return state === "loading"
      || state === "switching"
      || state === "seeking"
      || isTransitionLocked
      || isUserSeekPending;
  }

  function isPlayBlocked() {
    return isBusy() || isRebuffering;
  }

  function isCurrent(gen: number) {
    return !disposed && gen === generation;
  }

  function hasPlayableBuffer(): boolean {
    return bufferAheadSeconds(getProviderVideo(elPlayer)) >= MIN_PLAY_AHEAD_S;
  }

  /**
   * Pick a time that is actually inside media.buffered (prefer preferred / lastKnown).
   */
  function pickBufferedTime(elVideo: HTMLVideoElement, preferred: number): number | null {
    try {
      const ranges = elVideo.buffered;
      if (!ranges.length) {
        return null;
      }
      if (bufferAheadSeconds(elVideo, preferred) >= 0.2) {
        return preferred;
      }
      // Nearest range to preferred
      let best: number | null = null;
      let bestDist = Infinity;
      for (let index = 0; index < ranges.length; index += 1) {
        const start = ranges.start(index);
        const end = ranges.end(index);
        let candidate: number;
        if (preferred < start) {
          candidate = start + 0.05;
        } else if (preferred > end) {
          candidate = Math.max(start, end - 0.5);
        } else {
          candidate = preferred;
        }
        const dist = Math.abs(candidate - preferred);
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  /**
   * MSE mid-file land: Vidstack/Chrome sometimes snap currentTime→0 while buffer
   * only exists at 1h+. Restore playhead before play / on waiting so we don't hang.
   */
  function restoreMsePlayhead(reason: string): boolean {
    if (!isMseActive()) {
      return false;
    }
    const elVideo = getProviderVideo(elPlayer);
    if (!elVideo) {
      return false;
    }
    const live = Number(elVideo.currentTime);
    const ahead = bufferAheadSeconds(elVideo, live);
    // Healthy playhead inside buffer
    if (Number.isFinite(live) && ahead >= 0.25 && !elVideo.seeking) {
      return false;
    }
    // Still seeking into a covered target — let it finish
    if (elVideo.seeking && ahead >= 0.25) {
      return false;
    }

    const preferred = lastKnownGoodTime > 1
      ? lastKnownGoodTime
      : (Number.isFinite(live) && live > 1 ? live : 0);
    const snap = pickBufferedTime(elVideo, preferred)
      ?? pickBufferedTime(elVideo, live)
      ?? null;
    if (snap == null) {
      return false;
    }
    // No meaningful correction
    if (Number.isFinite(live) && Math.abs(live - snap) < 0.35 && ahead >= 0.2) {
      return false;
    }

    log.warn("MSE playhead restore", {
      reason,
      from: Number.isFinite(live) ? live : null,
      to: snap,
      lastKnown: lastKnownGoodTime,
      buffered: formatBuffered(elVideo),
      seeking: elVideo.seeking
    });
    try {
      elVideo.currentTime = snap;
    } catch {
      // ignore
    }
    try {
      elPlayer.currentTime = snap;
    } catch {
      // ignore
    }
    lastKnownGoodTime = snap;
    return true;
  }

  function isSafeToResume() {
    return !disposed
      && !isPlayBlocked()
      && (state === "ready" || state === "playing")
      && wantsPlaying
      && hasPlayableBuffer();
  }

  function runPause(callback: () => void) {
    if (allowPause) {
      allowPause(callback);
    } else {
      callback();
    }
  }

  function suspendAudio(reason: string) {
    if (!elAudio) {
      return;
    }
    log.debug(`audio suspend (${reason})`, mediaSnapshot(elAudio));
    try {
      elAudio.pause();
      elAudio.muted = true;
    } catch {
      // ignore
    }
  }

  function disposeAudio() {
    if (!elAudio) {
      return;
    }
    log.debug("audio dispose");
    try {
      elAudio.pause();
      elAudio.removeAttribute("src");
      elAudio.load();
    } catch {
      // ignore
    }
    elAudio.remove();
    elAudio = null;
    // keep activeAudioUrl so large seeks can recreate
  }

  function disposeMse(reason: string) {
    if (!mse) {
      return;
    }
    log.info("mse dispose", { reason });
    try {
      mse.stop();
    } catch {
      // ignore
    }
    mse = null;
  }

  function isMseActive(): boolean {
    return mse?.isActive() === true;
  }

  /**
   * Ensure Vidstack has created a <video>, then return it for MediaSource attach.
   */
  async function ensureProviderVideoElement(gen: number): Promise<HTMLVideoElement | null> {
    let elVideo = getProviderVideo(elPlayer);
    if (elVideo) {
      return elVideo;
    }

    // Bootstrap: assign a temporary MediaSource URL so the provider mounts <video>
    const bootstrap = new MediaSource();
    const bootstrapUrl = URL.createObjectURL(bootstrap);
    const height = activeQuality.height > 0 ? activeQuality.height : 1080;
    const width = activeQuality.width && activeQuality.width > 0
      ? activeQuality.width
      : Math.round(height * 16 / 9);
    elPlayer.src = {
      src: bootstrapUrl,
      type: "video/mp4",
      width,
      height,
      id: "mse-bootstrap"
    };
    queueMicrotask(() => {
      try {
        elPlayer.startLoading?.();
      } catch {
        // ignore
      }
    });

    const started = Date.now();
    while (Date.now() - started < 5_000 && isCurrent(gen)) {
      elVideo = getProviderVideo(elPlayer);
      if (elVideo) {
        break;
      }
      await new Promise(resolve => window.setTimeout(resolve, 40));
    }

    try {
      URL.revokeObjectURL(bootstrapUrl);
    } catch {
      // ignore
    }

    return getProviderVideo(elPlayer);
  }

  function ensureAudio(audioUrl: string, startAt = 0) {
    disposeAudio();
    activeAudioUrl = audioUrl.split("#")[0] ?? audioUrl;
    elAudio = document.createElement("audio");
    elAudio.preload = "auto";
    elAudio.setAttribute("playsinline", "");
    elAudio.hidden = true;
    elAudio.muted = true;
    elAudio.src = withTimeFragment(activeAudioUrl, startAt);
    elMount.append(elAudio);
    log.debug("audio created", { startAt });
    return elAudio;
  }

  function setProviderMuted(muted: boolean) {
    elPlayer.muted = muted;
    const elVideo = getProviderVideo(elPlayer);
    if (elVideo) {
      elVideo.muted = muted;
    }
  }

  /** Force-mute only for load/seek; depth-tracked so volume-change never sticks. */
  function beginTransitionMute() {
    transitionMuteDepth += 1;
    setProviderMuted(true);
  }

  function endTransitionMute() {
    if (transitionMuteDepth > 0) {
      transitionMuteDepth -= 1;
    }
    if (transitionMuteDepth === 0) {
      setProviderMuted(userWantsMuted);
      const elVideo = getProviderVideo(elPlayer);
      if (elVideo && !userWantsMuted) {
        elVideo.muted = false;
        elPlayer.muted = false;
      }
    }
  }

  function clearAllTransitionMute() {
    while (transitionMuteDepth > 0) {
      endTransitionMute();
    }
  }

  /** Keep MSE <video> volume/rate in sync with Vidstack chrome. */
  function syncVideoElementFromPlayer() {
    const elVideo = getProviderVideo(elPlayer);
    if (!elVideo) {
      return;
    }
    try {
      elVideo.volume = Math.min(1, Math.max(0, Number(elPlayer.volume ?? 1) || 1));
      // Never re-apply transition mute as if it were user intent
      if (transitionMuteDepth === 0) {
        elVideo.muted = userWantsMuted || Boolean(elPlayer.muted);
        if (!userWantsMuted && elPlayer.muted) {
          // Vidstack may still show muted after transition — clear it
          elPlayer.muted = false;
          elVideo.muted = false;
        }
      }
      const rate = Number(elPlayer.playbackRate ?? 1) || 1;
      if (rate > 0 && Number.isFinite(rate)) {
        elVideo.playbackRate = rate;
      }
    } catch {
      // ignore
    }
  }

  function restoreUserMute() {
    if (transitionMuteDepth > 0) {
      // Still inside nested transition — only endTransitionMute fully restores
      return;
    }
    setProviderMuted(userWantsMuted);
    if (!userWantsMuted) {
      const elVideo = getProviderVideo(elPlayer);
      if (elVideo) {
        elVideo.muted = false;
      }
      elPlayer.muted = false;
    }
  }

  function readPlayerTime(): number {
    const elVideo = getProviderVideo(elPlayer);
    const fromVideo = elVideo?.currentTime;
    if (typeof fromVideo === "number" && Number.isFinite(fromVideo)) {
      return fromVideo;
    }
    return Number(elPlayer.currentTime ?? 0) || 0;
  }

  /**
   * Soft A/V sync. Hard currentTime seeks on audio thrash the buffer (readyState→1)
   * and caused the loops/silence in logs — only hard-align rarely for large drift.
   * Catastrophic drift (>4s) means timelines diverged (seek miss) — never thrash;
   * leave for explicit barrier resync.
   */
  function syncAudioClock(mode: "soft" | "hard" = "soft"): "ok" | "catastrophic" {
    if (!elAudio) {
      return "ok";
    }
    const seconds = readPlayerTime();
    if (!Number.isFinite(seconds)) {
      return "ok";
    }
    const baseRate = Number(elPlayer.playbackRate ?? 1) || 1;
    let drift = 0;
    try {
      drift = elAudio.currentTime - seconds;
    } catch {
      return "ok";
    }

    if (Math.abs(drift) >= AUDIO_CATASTROPHIC_DRIFT) {
      log.warn("audio catastrophic drift — skip thrash", {
        drift: Number(drift.toFixed(3)),
        videoT: seconds,
        audioT: elAudio.currentTime
      });
      try {
        elAudio.pause();
        elAudio.muted = true;
      } catch {
        // ignore
      }
      return "catastrophic";
    }

    if (Math.abs(drift) < AUDIO_HARD_ALIGN_MIN) {
      elAudio.playbackRate = baseRate;
      return "ok";
    }

    if (mode === "hard" || Math.abs(drift) >= AUDIO_HARD_ALIGN) {
      const now = Date.now();
      if (mode !== "hard" && now - lastAudioHardAlignAt < AUDIO_ALIGN_COOLDOWN_MS) {
        const nudge = Math.max(-AUDIO_RATE_NUDGE_MAX, Math.min(AUDIO_RATE_NUDGE_MAX, -drift * 0.15));
        elAudio.playbackRate = baseRate + nudge;
        return "ok";
      }
      // Soft mode with medium drift: rate-nudge only — hard seeks mid-play cause loops
      if (mode !== "hard") {
        const nudge = Math.max(-AUDIO_RATE_NUDGE_MAX, Math.min(AUDIO_RATE_NUDGE_MAX, -drift * 0.2));
        elAudio.playbackRate = baseRate + nudge;
        return "ok";
      }
      lastAudioHardAlignAt = now;
      log.debug("audio hard-align", { drift: Number(drift.toFixed(3)), to: seconds, mode });
      try {
        elAudio.currentTime = seconds;
      } catch {
        // ignore
      }
      elAudio.playbackRate = baseRate;
      return "ok";
    }

    if (Math.abs(drift) > 0.08) {
      const nudge = Math.max(-AUDIO_RATE_NUDGE_MAX, Math.min(AUDIO_RATE_NUDGE_MAX, -drift * 0.2));
      elAudio.playbackRate = baseRate + nudge;
    } else {
      elAudio.playbackRate = baseRate;
    }
    return "ok";
  }

  function applyUserVolumeToAudio() {
    if (!elAudio) {
      return;
    }
    elAudio.volume = Number(elPlayer.volume ?? 1);
    elAudio.muted = Boolean(elPlayer.muted);
  }

  async function releaseAudioWhenPlaying(gen: number, reason: string) {
    if (!isCurrent(gen) || !elAudio || elPlayer.paused || isBusy() || isRebuffering) {
      log.debug(`audio release skip (${reason})`, {
        current: isCurrent(gen),
        hasAudio: Boolean(elAudio),
        paused: elPlayer.paused,
        busy: isBusy(),
        rebuffer: isRebuffering
      });
      return;
    }

    // Never play while audio is mid-seek — wait, don't recreate thrash (log: jump 6166)
    if (elAudio.seeking || elAudio.readyState < 2) {
      log.debug(`audio not ready for play (${reason})`, {
        seeking: elAudio.seeking,
        readyState: elAudio.readyState,
        t: elAudio.currentTime
      });
      await waitForEvent(elAudio, "canplay", 6_000, () => isCurrent(gen), "audio-canplay");
      if (!isCurrent(gen) || !elAudio || elPlayer.paused || isBusy() || isRebuffering) {
        return;
      }
    }

    const audio = elAudio;
    if (!audio) {
      return;
    }

    // Hard-align to video so we never get "sound only" 13s ahead
    const videoT = readPlayerTime();
    if (Math.abs(audio.currentTime - videoT) > 0.35) {
      syncAudioClock("hard");
      if (audio.seeking) {
        await waitForEvent(audio, "seeked", AUDIO_SEEK_WAIT_MS, () => isCurrent(gen), "audio-align");
      }
    }

    const syncResult = syncAudioClock(
      reason.startsWith("load") || reason.startsWith("seek") || reason.includes("user")
        ? "hard"
        : "soft"
    );
    if (syncResult === "catastrophic") {
      const resyncT = readPlayerTime();
      log.warn(`audio barrier resync (${reason})`, { videoT: resyncT });
      await ensureAudioAt(resyncT, gen);
      if (!isCurrent(gen) || !elAudio) {
        return;
      }
    }
    const liveAudio = elAudio;
    if (!liveAudio) {
      return;
    }
    applyUserVolumeToAudio();
    if (liveAudio.paused || liveAudio.ended) {
      log.debug(`audio release play (${reason})`, mediaSnapshot(liveAudio));
      try {
        await liveAudio.play();
        log.debug("audio playing", mediaSnapshot(liveAudio));
      } catch (error) {
        log.warn("audio.play failed, retry", { error: String(error) });
        if (!isCurrent(gen) || !elAudio) {
          return;
        }
        await new Promise<void>(resolve => {
          window.setTimeout(resolve, 150);
        });
        if (!isCurrent(gen) || !elAudio || elPlayer.paused || isBusy() || elAudio.seeking) {
          return;
        }
        if (syncAudioClock("soft") === "catastrophic") {
          return;
        }
        applyUserVolumeToAudio();
        try {
          await elAudio.play();
          log.debug("audio retry ok", mediaSnapshot(elAudio));
        } catch (retryError) {
          log.error("audio.play retry failed", { error: String(retryError) });
        }
      }
    }
  }

  function hardResetProviderVideo() {
    for (const element of elPlayer.querySelectorAll("video")) {
      if (!(element instanceof HTMLVideoElement)) {
        continue;
      }
      log.debug("hard-reset video", mediaSnapshot(element));
      try {
        element.pause();
        element.removeAttribute("src");
        while (element.firstChild) {
          element.removeChild(element.firstChild);
        }
        element.load();
      } catch {
        // ignore
      }
    }
  }

  async function seekMediaTo(
    media: HTMLMediaElement | MediaPlayerLike,
    time: number,
    gen: number,
    label: string,
    timeoutMs: number
  ) {
    const seconds = Math.max(0, time);
    log.debug(`set currentTime (${label})`, { seconds });
    try {
      media.currentTime = seconds;
    } catch {
      // ignore
    }
    const element = media instanceof HTMLMediaElement ? media : getProviderVideo(elPlayer);
    if (element && !element.seeking && Math.abs(element.currentTime - seconds) < 0.35) {
      log.debug(`${label} already near target`, { t: element.currentTime, time: seconds });
      return true;
    }
    return waitForEvent(media, "seeked", timeoutMs, () => isCurrent(gen), label);
  }

  /**
   * Logs showed seek "succeeding" at 6761 when target was 6227 — verify landing.
   * Re-seek up to SEEK_VERIFY_ATTEMPTS; return actual time landed.
   */
  async function ensureSeekLanded(
    target: number,
    gen: number,
    label: string
  ): Promise<number> {
    let actual = readPlayerTime();
    for (let attempt = 0; attempt < SEEK_VERIFY_ATTEMPTS; attempt += 1) {
      if (!isCurrent(gen)) {
        return actual;
      }
      actual = readPlayerTime();
      const miss = Math.abs(actual - target);
      if (miss <= SEEK_LAND_TOLERANCE_S) {
        if (attempt > 0) {
          log.info(`${label} seek landed after retry`, { actual, target, attempt });
        }
        return actual;
      }
      log.warn(`${label} seek miss — retry`, {
        actual,
        target,
        miss: Number(miss.toFixed(2)),
        attempt
      });
      // Direct on provider video — Vidstack sometimes ignores second currentTime set
      const elVideo = getProviderVideo(elPlayer);
      if (elVideo) {
        try {
          elVideo.pause();
          elVideo.currentTime = target;
        } catch {
          // ignore
        }
        await waitForEvent(elVideo, "seeked", EVENT_WAIT_MS, () => isCurrent(gen), `${label}-retry-v`);
      } else {
        await seekMediaTo(elPlayer, target, gen, `${label}-retry`, EVENT_WAIT_MS);
      }
    }
    actual = readPlayerTime();
    if (Math.abs(actual - target) > SEEK_LAND_TOLERANCE_S) {
      log.error(`${label} seek failed to land`, { actual, target });
    }
    return actual;
  }

  async function ensureAudioAt(target: number, gen: number): Promise<void> {
    if (!isCurrent(gen)) {
      return;
    }
    const url = activeAudioUrl
      ?? (elAudio?.src ? (elAudio.src.split("#")[0] ?? null) : null);
    if (!url) {
      return;
    }

    try {
      // First attach — create once with #t=
      if (!elAudio) {
        log.debug("audio attach", { target });
        const audio = ensureAudio(url, target);
        await waitForEvent(audio, "loadedmetadata", 6_000, () => isCurrent(gen), "audio-meta");
        if (!isCurrent(gen) || !elAudio) {
          return;
        }
        if (Math.abs(audio.currentTime - target) > SEEK_LAND_TOLERANCE_S) {
          await seekMediaTo(audio, target, gen, "load-audio", AUDIO_SEEK_WAIT_MS);
        }
        await waitForEvent(audio, "canplay", 8_000, () => isCurrent(gen), "audio-canplay");
        return;
      }

      // Still loading initial metadata — wait, do NOT treat currentTime=0 as 6000s jump
      if (elAudio.readyState < 1 || (elAudio.seeking && elAudio.readyState < 2)) {
        log.debug("audio still loading — wait", mediaSnapshot(elAudio));
        await waitForEvent(elAudio, "loadedmetadata", 6_000, () => isCurrent(gen), "audio-meta-wait");
        if (!isCurrent(gen) || !elAudio) {
          return;
        }
        await waitForEvent(elAudio, "canplay", 8_000, () => isCurrent(gen), "audio-canplay-wait");
        if (!isCurrent(gen) || !elAudio) {
          return;
        }
      }

      const audioTime = Number(elAudio.currentTime);
      const jump = Number.isFinite(audioTime) ? Math.abs(audioTime - target) : 0;

      // Only recreate for real large jumps after audio has valid position
      if (jump > AUDIO_RECREATE_JUMP_S && elAudio.readyState >= 1 && audioTime > 1) {
        log.debug("audio recreate for large seek", {
          jump: Number(jump.toFixed(1)),
          target
        });
        ensureAudio(url, target);
        await waitForEvent(elAudio!, "loadedmetadata", 6_000, () => isCurrent(gen), "audio-meta");
        if (!isCurrent(gen) || !elAudio) {
          return;
        }
        await waitForEvent(elAudio, "canplay", 8_000, () => isCurrent(gen), "audio-canplay");
        return;
      }

      if (jump > SEEK_LAND_TOLERANCE_S) {
        await seekMediaTo(elAudio, target, gen, "load-audio", AUDIO_SEEK_WAIT_MS);
      }
    } catch {
      // best-effort
    }
  }

  function maybeRecoverAudio(reason: string) {
    if (!elAudio || !wantsPlaying || elPlayer.paused || isBusy()) {
      return;
    }
    if (state !== "playing" && state !== "ready") {
      return;
    }
    // Never recover into underrun — that restarts the 0.2s play/reset loop
    if (!hasPlayableBuffer()) {
      return;
    }

    // Only recover if audio actually stopped — never thrash with hard seeks on small drift
    if (elAudio.paused || elAudio.ended) {
      log.warn(`audio recover play (${reason})`, mediaSnapshot(elAudio));
      void releaseAudioWhenPlaying(generation, `recover:${reason}`);
      return;
    }

    // Soft sync only
    syncAudioClock("soft");
  }

  function onTimeUpdate() {
    if (isBusy()) {
      return;
    }
    if (state !== "playing" && state !== "ready") {
      return;
    }
    const seconds = Number(elPlayer.currentTime ?? 0);
    // Don't let a spurious 0 clobber mid-file lastKnown while MSE buffer is at 1h+
    if (
      isMseActive()
      && Number.isFinite(seconds)
      && seconds < 0.5
      && lastKnownGoodTime > 5
    ) {
      const elVideo = getProviderVideo(elPlayer);
      const midBuf = elVideo && elVideo.buffered.length > 0
        && elVideo.buffered.start(0) > 5;
      if (midBuf) {
        restoreMsePlayhead("time-update-zero");
        maybeRecoverAudio("time-update");
        return;
      }
    }
    if (Number.isFinite(seconds) && seconds >= 0) {
      lastKnownGoodTime = seconds;
    }
    maybeRecoverAudio("time-update");
  }

  function onPlaying() {
    log.debug("event playing", {
      state,
      locked: isTransitionLocked,
      userSeek: isUserSeekPending,
      video: mediaSnapshot(getProviderVideo(elPlayer))
    });
    if (isBusy()) {
      // Progressive only: kill intermediate autoplay during load
      if (!isMseActive()) {
        log.debug("suppress play during busy — re-pause");
        runPause(() => {
          try {
            elPlayer.pause?.();
          } catch {
            // ignore
          }
        });
      }
      return;
    }
    if (!hasPlayableBuffer()) {
      log.debug("playing ignored — buffer too thin", {
        ahead: bufferAheadSeconds(getProviderVideo(elPlayer))
      });
      return;
    }
    if (!wantsPlaying && !playbackIntent) {
      // User explicitly paused — don't revive
      return;
    }
    setState("playing");
    wantsPlaying = true;
    playbackIntent = true;
    armPauseGrace(800);
    void releaseAudioWhenPlaying(generation, "playing-event");
  }

  function onPause() {
    log.debug("event pause", {
      state,
      wantsPlaying,
      intent: playbackIntent,
      locked: isTransitionLocked,
      grace: Date.now() < ignorePauseUntil,
      video: mediaSnapshot(getProviderVideo(elPlayer))
    });
    if (isBusy()) {
      suspendAudio("pause-busy");
      return;
    }
    // Explicit pause (engine.pause / intentional gesture cleared wantsPlaying) — stay paused
    if (!wantsPlaying) {
      playbackIntent = false;
      suspendAudio("pause");
      if (state !== "error" && state !== "idle") {
        setState("ready");
      }
      return;
    }
    // wantsPlaying still true → ghost pause (scrub side-effect, MSE flap).
    // Intentional pause must clear wantsPlaying first via engine.pause()
    // (main.ts media-pause-request / surface click — capture phase runs before this).
    if (Date.now() < ignorePauseUntil) {
      log.debug("ghost pause during grace — re-play");
      void playMediaElements("pause-grace").then(ok => {
        if (ok && !isBusy() && wantsPlaying) {
          setState("playing");
          armPauseGrace(600);
        }
      });
      return;
    }
    // Outside grace: stay paused visually but keep intent for scrub resume / keep-playing.
    // Do NOT auto-play here — that fights intentional click-to-pause when the gesture
    // signal is late. keep-playing poll + scrub seek handle legitimate resumes.
    log.debug("pause with intent kept (no auto re-play)", {
      intent: playbackIntent
    });
    suspendAudio("pause-keep-intent");
    if (state !== "error" && state !== "idle") {
      setState("ready");
    }
  }

  function onWaiting() {
    if (isBusy()) {
      log.debug("waiting during transition (ignored for audio thrash)", {
        video: mediaSnapshot(getProviderVideo(elPlayer))
      });
      return;
    }
    // Mid-file MSE: playhead snapped to 0 while buffer only exists at resume point
    if (isMseActive() && restoreMsePlayhead("waiting")) {
      const ahead = bufferAheadSeconds(getProviderVideo(elPlayer));
      if (wantsPlaying && ahead >= 0.35) {
        log.info("waiting recovered via playhead restore", { ahead });
        void requestPlay("waiting-restore");
        return;
      }
    }
    const ahead = bufferAheadSeconds(getProviderVideo(elPlayer));
    log.warn("event waiting/stalled", {
      state,
      video: mediaSnapshot(getProviderVideo(elPlayer)),
      audio: mediaSnapshot(elAudio),
      ahead
    });
    // YouTube-style rebuffer: hard pause, wait for cushion, single resume
    if (wantsPlaying) {
      startRebuffer("waiting");
    } else {
      suspendAudio("waiting");
      if (state === "playing") {
        setState("ready");
      }
    }
  }

  function onVolumeChange() {
    // Only track user preference when not mid-transition mute / busy
    if (transitionMuteDepth === 0 && !isBusy()) {
      userWantsMuted = Boolean(elPlayer.muted);
    }
    if (elAudio) {
      applyUserVolumeToAudio();
    }
    if (isMseActive() && transitionMuteDepth === 0) {
      syncVideoElementFromPlayer();
    }
  }

  function onRateChange() {
    if (elAudio && !isBusy()) {
      syncAudioClock("soft");
    }
    if (isMseActive()) {
      syncVideoElementFromPlayer();
    }
  }

  /**
   * Debounced handoff of a user scrub into engine.seek().
   * Progressive: usually fired from `seeked`.
   * MSE: often must fire from `seeking` — HTMLMediaElement never reaches `seeked`
   * when the target is outside MediaSource buffered ranges (log: stuck seeking RS=1).
   */
  function clearUserSeekPending() {
    isUserSeekPending = false;
    userSeekPendingSince = 0;
    if (userSeekWatchdogId) {
      window.clearTimeout(userSeekWatchdogId);
      userSeekWatchdogId = 0;
    }
  }

  function scheduleUserSeekCommit(source: string, preferredTime?: number) {
    if (userSeekDebounceId) {
      window.clearTimeout(userSeekDebounceId);
    }
    userSeekDebounceId = window.setTimeout(() => {
      userSeekDebounceId = 0;
      if (disposed) {
        clearUserSeekPending();
        return;
      }
      // Prefer the time the user scrubbed to; during stuck MSE seeking currentTime
      // is already the target even though seeked never fires.
      const fromPlayer = readPlayerTime();
      const finalTarget = preferredTime != null && Number.isFinite(preferredTime)
        ? preferredTime
        : fromPlayer;
      // Scrub keeps playing if user had watch intent OR was playing when scrub started
      const shouldPlay = userSeekWasPlaying || wantsPlaying || playbackIntent;
      log.info("user scrub commit", {
        source,
        finalTarget,
        fromPlayer,
        shouldPlay,
        wasPlaying: userSeekWasPlaying,
        intent: playbackIntent,
        mse: isMseActive()
      });
      // Preserve play intent across the full MediaSource reload
      if (shouldPlay) {
        wantsPlaying = true;
        playbackIntent = true;
      }
      // seek() takes over lock; clear pending so isBusy is driven by seeking state
      clearUserSeekPending();
      void seek(finalTarget, { wasPlaying: shouldPlay }).catch(error => {
        log.warn("user scrub seek failed", { error: String(error) });
        clearUserSeekPending();
        clearAllTransitionMute();
      });
    }, USER_SEEK_DEBOUNCE_MS);
  }

  function onSeeking() {
    // Engine-owned seek already locked
    if (isTransitionLocked || state === "loading" || state === "switching" || state === "seeking") {
      return;
    }
    if (Date.now() < ignoreUserSeekUntil) {
      log.debug("seeking ignored — post-load grace");
      return;
    }
    const seekTarget = Number(elPlayer.currentTime ?? 0) || readPlayerTime();
    // Ignore tiny/spurious seeks (Vidstack snaps after MSE attach)
    if (Math.abs(seekTarget - lastKnownGoodTime) < 0.5
      && bufferAheadSeconds(getProviderVideo(elPlayer), seekTarget) > 1) {
      log.debug("seeking ignored — near last known time", { seekTarget, lastKnownGoodTime });
      return;
    }
    // Capture play intent BEFORE we pause for scrub
    if (!isUserSeekPending) {
      const elVideo = getProviderVideo(elPlayer);
      userSeekWasPlaying = playbackIntent
        || wantsPlaying
        || state === "playing"
        || !(elVideo?.paused ?? Boolean(elPlayer.paused));
      // If user has been watching this session, resume after scrub even if chrome paused
      if (playbackIntent) {
        userSeekWasPlaying = true;
      }
      userSeekPendingSince = Date.now();
    }
    isUserSeekPending = true;
    const aheadAtTarget = bufferAheadSeconds(getProviderVideo(elPlayer), seekTarget);
    log.debug("event seeking (user)", {
      t: seekTarget,
      wasPlaying: userSeekWasPlaying,
      intent: playbackIntent,
      aheadAtTarget,
      mse: isMseActive()
    });
    // Don't leave isUserSeekPending stuck forever if seeked never fires
    if (userSeekWatchdogId) {
      window.clearTimeout(userSeekWatchdogId);
    }
    userSeekWatchdogId = window.setTimeout(() => {
      userSeekWatchdogId = 0;
      if (isUserSeekPending && !isTransitionLocked && state !== "seeking") {
        log.warn("user-seek watchdog — clear pending / commit");
        if (isMseActive() && bufferAheadSeconds(getProviderVideo(elPlayer), readPlayerTime()) < 0.35) {
          scheduleUserSeekCommit("watchdog-mse", readPlayerTime());
        } else {
          clearUserSeekPending();
        }
      }
    }, 900);

    suspendAudio("seeking");
    // Pause video during scrub — prevents 0.2s play/reset flap while buffer empty.
    // Mute is applied only inside seek()/loadQuality (not here) so cancelled scrubs
    // cannot leave the player permanently muted.
    runPause(() => {
      try {
        elPlayer.pause?.();
        getProviderVideo(elPlayer)?.pause();
      } catch {
        // ignore
      }
    });

    // MSE: seeked never fires when target is outside SourceBuffer ranges.
    // Commit scrub from seeking so mse.seek() can rebuffer around the target.
    if (isMseActive() && aheadAtTarget < 0.35) {
      log.info("MSE scrub outside buffer — commit without seeked", {
        seekTarget,
        aheadAtTarget
      });
      scheduleUserSeekCommit("seeking-mse", seekTarget);
    }
  }

  function onSeeked() {
    if (isTransitionLocked || state === "loading" || state === "switching" || state === "seeking") {
      // Engine-driven seek owns completion
      return;
    }
    if (Date.now() < ignoreUserSeekUntil) {
      clearUserSeekPending();
      return;
    }
    if (!isUserSeekPending) {
      // Spurious seeked without our seeking — still treat as scrub if jumped far
      const target = readPlayerTime();
      if (Math.abs(target - lastKnownGoodTime) < 0.5) {
        return;
      }
      isUserSeekPending = true;
      userSeekWasPlaying = playbackIntent || wantsPlaying || state === "playing";
    }
    const target = readPlayerTime();
    log.debug("event seeked (user) → engine.seek", { t: target });
    scheduleUserSeekCommit("seeked", target);
  }

  function onProgress() {
    const elVideo = getProviderVideo(elPlayer);
    if (!elVideo) {
      return;
    }
    const now = Date.now();
    if (now - lastProgressLogAt < 2000) {
      return;
    }
    lastProgressLogAt = now;
    log.debug("progress", {
      buffered: formatBuffered(elVideo),
      ahead: bufferAheadSeconds(elVideo),
      t: elVideo.currentTime,
      audioBuffered: formatBuffered(elAudio),
      state
    });
  }

  /**
   * MSE attaches blob: URL on the provider <video>; Vidstack play() alone often
   * leaves that element paused → keep-playing spam with state=playing.
   */
  async function playMediaElements(reason: string): Promise<boolean> {
    if (!wantsPlaying && !playbackIntent) {
      return false;
    }
    // Never start playback while still holding a transition mute
    clearAllTransitionMute();
    restoreUserMute();
    syncVideoElementFromPlayer();
    // Fix playhead before play — otherwise play() seeks to t=0 with mid buffer
    restoreMsePlayhead(`playMedia:${reason}`);
    const elVideo = getProviderVideo(elPlayer);
    // Force unmute if user didn't mute (MSE + progressive)
    if (!userWantsMuted) {
      if (elVideo) {
        elVideo.muted = false;
      }
      elPlayer.muted = false;
    }
    try {
      if (isMseActive() && elVideo) {
        // If still seeking outside buffer after restore, wait briefly for seeked
        if (elVideo.seeking && bufferAheadSeconds(elVideo) < 0.2) {
          await new Promise<void>(resolve => {
            const timer = window.setTimeout(() => resolve(), 800);
            elVideo.addEventListener("seeked", () => {
              window.clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          restoreMsePlayhead(`playMedia-after-seek:${reason}`);
        }
        await elVideo.play();
        try {
          await elPlayer.play?.();
        } catch {
          // Vidstack may not own the blob src — native video play is enough
        }
      } else {
        await elPlayer.play?.();
        if (elVideo?.paused) {
          await elVideo.play();
        }
      }
    } catch (error) {
      log.warn(`playMedia failed (${reason})`, {
        error: String(error),
        mse: isMseActive(),
        video: mediaSnapshot(elVideo)
      });
      return false;
    }
    if (elVideo) {
      return !elVideo.paused;
    }
    return !elPlayer.paused;
  }

  function isProviderPaused(): boolean {
    const elVideo = getProviderVideo(elPlayer);
    if (elVideo) {
      return elVideo.paused;
    }
    return Boolean(elPlayer.paused);
  }

  async function requestPlay(reason: string) {
    wantsPlaying = true;
    playbackIntent = true;
    // rebuffer-done must run after stopRebufferPoll cleared isRebuffering
    if (isBusy()) {
      log.debug(`requestPlay ignored — busy (${reason})`, { state });
      return;
    }
    if (isRebuffering && reason !== "rebuffer-done") {
      log.debug(`requestPlay ignored — rebuffering (${reason})`);
      return;
    }
    restoreMsePlayhead(`requestPlay:${reason}`);
    const elVideo = getProviderVideo(elPlayer);
    let ahead = bufferAheadSeconds(elVideo);
    const need = reason === "rebuffer-done" ? REBUFFER_TARGET_S * 0.9 : MIN_PLAY_AHEAD_S;
    if (ahead < need) {
      // One more restore attempt — thin buffer often means wrong playhead
      if (restoreMsePlayhead(`requestPlay-thin:${reason}`)) {
        ahead = bufferAheadSeconds(elVideo);
      }
    }
    if (ahead < need) {
      log.debug(`requestPlay defer — thin buffer (${reason})`, { ahead, need });
      if (wantsPlaying && !isRebuffering) {
        startRebuffer(`thin:${reason}`);
      }
      return;
    }
    // Already playing on the real media element — don't spam play()
    if (elVideo && !elVideo.paused && !elVideo.seeking) {
      if (state !== "playing") {
        setState("playing");
      }
      return;
    }
    log.debug(`requestPlay (${reason})`, { ahead, mse: isMseActive() });
    const ok = await playMediaElements(reason);
    if (disposed || isBusy()) {
      return;
    }
    if (ok) {
      armPauseGrace(1_200);
      setState("playing");
      await releaseAudioWhenPlaying(generation, reason);
    } else {
      log.warn(`requestPlay still paused (${reason})`, mediaSnapshot(elVideo));
    }
  }

  function healthTick() {
    if (disposed) {
      return;
    }

    // MSE: if user scrub left us stuck (seeking forever, no seeked), force commit.
    if (
      isMseActive()
      && isUserSeekPending
      && !isTransitionLocked
      && state !== "seeking"
      && state !== "loading"
      && state !== "switching"
      && userSeekPendingSince > 0
      && Date.now() - userSeekPendingSince > 900
    ) {
      const stuckTarget = Number(elPlayer.currentTime ?? 0) || readPlayerTime();
      const ahead = bufferAheadSeconds(getProviderVideo(elPlayer), stuckTarget);
      if (ahead < 0.35) {
        log.warn("MSE scrub stuck — force commit", {
          stuckTarget,
          ahead,
          pendingMs: Date.now() - userSeekPendingSince
        });
        scheduleUserSeekCommit("health-stuck-mse", stuckTarget);
        return;
      }
    }

    if (isBusy()) {
      return;
    }
    const elVideo = getProviderVideo(elPlayer);
    if (!elVideo) {
      return;
    }

    const time = elVideo.currentTime;
    const ahead = bufferAheadSeconds(elVideo);
    const isAdvancing = lastHealthTime >= 0 && Math.abs(time - lastHealthTime) > STALL_TIME_EPS;
    const shouldAdvance = wantsPlaying && !elVideo.ended
      && (state === "playing" || state === "ready");

    // Soft underrun: only rebuffer when critically low (waiting event handles most cases).
    // Triggering at 1.1s with MIN=1.2 caused constant pause mid-playback.
    if (shouldAdvance && ahead < 0.4) {
      if (!isRebuffering) {
        startRebuffer("health-underrun");
      }
      lastHealthTime = time;
      return;
    }

    if (shouldAdvance && !elVideo.paused && !isAdvancing && lastHealthTime >= 0) {
      stallTicks += 1;
      if (stallTicks === 2 || stallTicks % 5 === 0) {
        log.warn("stall detected", {
          stallTicks,
          state,
          wantsPlaying,
          video: mediaSnapshot(elVideo),
          audio: mediaSnapshot(elAudio),
          ahead
        });
      }
      if (stallTicks === 3 && ahead > 1.5) {
        log.info("stall soft-recover play()");
        void requestPlay("stall-recover");
      }
    } else if (isAdvancing) {
      if (stallTicks > 0) {
        log.info("stall cleared", { afterTicks: stallTicks, t: time });
      }
      stallTicks = 0;
    }

    lastHealthTime = time;

    if (shouldAdvance && !elVideo.paused && ahead >= MIN_PLAY_AHEAD_S) {
      maybeRecoverAudio("health");
    }
  }

  elPlayer.addEventListener("time-update", onTimeUpdate);
  elPlayer.addEventListener("timeupdate", onTimeUpdate);
  elPlayer.addEventListener("playing", onPlaying);
  elPlayer.addEventListener("pause", onPause);
  elPlayer.addEventListener("waiting", onWaiting);
  elPlayer.addEventListener("stalled", onWaiting);
  elPlayer.addEventListener("volume-change", onVolumeChange);
  elPlayer.addEventListener("volumechange", onVolumeChange);
  elPlayer.addEventListener("rate-change", onRateChange);
  elPlayer.addEventListener("ratechange", onRateChange);
  elPlayer.addEventListener("seeking", onSeeking);
  elPlayer.addEventListener("seeked", onSeeked);
  elPlayer.addEventListener("progress", onProgress);

  const healthPollId = window.setInterval(healthTick, HEALTH_POLL_MS);

  async function finishTransitionPlay(gen: number, shouldPlay: boolean, reason: string) {
    if (!isCurrent(gen)) {
      return;
    }

    // Restore mute BEFORE unlocking busy so volume-change cannot steal transition mute
    clearAllTransitionMute();
    restoreUserMute();

    isTransitionLocked = false;
    isUserSeekPending = false;
    stopRebufferPoll();
    setState("ready");
    syncVideoElementFromPlayer();

    const ahead = bufferAheadSeconds(getProviderVideo(elPlayer));
    log.info(`${reason} ready`, {
      gen,
      shouldPlay,
      intent: playbackIntent,
      muted: userWantsMuted,
      video: mediaSnapshot(getProviderVideo(elPlayer)),
      audio: mediaSnapshot(elAudio),
      ahead
    });

    // If caller said pause but user still has watch intent (scrub while "paused" by ghost), resume
    const effectiveShouldPlay = shouldPlay || playbackIntent || userSeekWasPlaying;

    if (!effectiveShouldPlay) {
      wantsPlaying = false;
      runPause(() => {
        elPlayer.pause?.();
        getProviderVideo(elPlayer)?.pause();
      });
      suspendAudio(`${reason}-paused`);
      return;
    }

    wantsPlaying = true;
    playbackIntent = true;
    // MSE already prefetched a playable intersection; don't wait 4s like progressive adaptive
    const needAhead = isMseActive()
      ? 0.5
      : Math.max(MIN_PLAY_AHEAD_S, adaptiveMinAhead(activeQuality) * 0.75);
    if (ahead < needAhead) {
      log.info(`${reason} defer play until buffer`, { ahead, needAhead, mse: isMseActive() });
      await waitForBufferAhead(
        elPlayer,
        needAhead,
        isMseActive() ? 8_000 : MIN_BUFFER_WAIT_MS,
        () => isCurrent(gen) && !isBusy()
      );
      if (!isCurrent(gen)) {
        return;
      }
    }

    const ok = await playMediaElements(reason);
    if (isCurrent(gen) && ok && !isBusy()) {
      armPauseGrace(1_500);
      armSeekIgnore(700);
      lastKnownGoodTime = readPlayerTime();
      setState("playing");
      await releaseAudioWhenPlaying(gen, reason);
    } else if (isCurrent(gen) && effectiveShouldPlay && isProviderPaused()) {
      log.warn(`${reason} still paused after playMedia`, {
        mse: isMseActive(),
        video: mediaSnapshot(getProviderVideo(elPlayer))
      });
      armPauseGrace(1_000);
      armSeekIgnore(500);
      setState("ready");
    } else if (isCurrent(gen) && !effectiveShouldPlay) {
      armSeekIgnore(500);
    }
  }

  async function loadQualityMse(
    quality: AdFreeQualityOption,
    gen: number,
    resumeAt: number,
    shouldPlay: boolean
  ): Promise<void> {
    if (!quality.audioUrl) {
      clearAllTransitionMute();
      setState("error");
      onError?.("MSE quality missing audio URL");
      isTransitionLocked = false;
      return;
    }

    log.info("loadQuality MSE path", {
      gen,
      label: quality.label,
      resumeAt,
      mime: quality.mimeType
    });

    disposeMse("loadQuality-mse");
    disposeAudio();
    activeAudioUrl = null;
    // Note: caller already hard-reset provider video

    const elVideo = await ensureProviderVideoElement(gen);
    if (!isCurrent(gen)) {
      return;
    }
    if (!elVideo) {
      clearAllTransitionMute();
      isTransitionLocked = false;
      setState("error");
      onError?.("Could not create video element for MSE");
      return;
    }

    setState("loading");
    if (transitionMuteDepth === 0) {
      beginTransitionMute();
    } else {
      setProviderMuted(true);
    }

    const controller = createMseController({
      elVideo,
      log: (message, data) => log.info(`mse ${message}`, data),
      onState: mseState => {
        log.debug("mse state", { mseState, gen });
        // Surface mid-pipeline stages as loading for UI overlay
        if (mseState === "moof-align" || mseState === "av-sync" || mseState === "rebuffer"
          || mseState === "buffering" || mseState === "fetch-init") {
          if (state !== "seeking" && state !== "switching") {
            setState("loading");
          }
        }
      },
      handleUserSeek: false
    });
    mse = controller;

    try {
      const fromPlayer = Number(elPlayer.duration);
      const durationHint = Number.isFinite(fromPlayer) && fromPlayer > 0
        ? fromPlayer
        : streamDurationSeconds > 0
          ? streamDurationSeconds
          : undefined;
      await controller.load({
        videoUrl: quality.videoUrl,
        audioUrl: quality.audioUrl,
        videoMime: quality.mimeType,
        startAt: resumeAt,
        durationHint,
        label: quality.label
      });
    } catch (error) {
      if (!isCurrent(gen)) {
        return;
      }
      disposeMse("load-failed");
      clearAllTransitionMute();
      isTransitionLocked = false;
      setState("error");
      onError?.(error instanceof Error ? error.message : String(error));
      return;
    }

    if (!isCurrent(gen)) {
      return;
    }

    const elVideoReady = getProviderVideo(elPlayer);
    const landed = readPlayerTime();
    // Prefer resumeAt when buffer covers it — don't trust a post-load snap to 0
    let settled = resumeAt > 0 && elVideoReady
      && bufferAheadSeconds(elVideoReady, resumeAt) >= 0.25
      ? resumeAt
      : landed;
    if (elVideoReady && bufferAheadSeconds(elVideoReady, settled) < 0.25) {
      settled = pickBufferedTime(elVideoReady, resumeAt > 0 ? resumeAt : landed)
        ?? landed
        ?? resumeAt;
    }
    if (elVideoReady && Math.abs((elVideoReady.currentTime || 0) - settled) > 0.5) {
      try {
        elVideoReady.currentTime = settled;
      } catch {
        // ignore
      }
    }
    try {
      elPlayer.currentTime = settled;
    } catch {
      // ignore
    }
    lastKnownGoodTime = settled;
    log.info("MSE load ready", {
      t: lastKnownGoodTime,
      landed,
      resumeAt,
      stats: controller.getStats()
    });

    await finishTransitionPlay(gen, shouldPlay, "loadQuality-mse");
  }

  async function loadQuality(
    quality: AdFreeQualityOption,
    opts: { resumeAt?: number; wasPlaying?: boolean } = {}
  ) {
    if (disposed) {
      return;
    }
    if (!/^https?:\/\//i.test(quality.videoUrl)) {
      setState("error");
      onError?.("Invalid stream URL");
      return;
    }

    const gen = ++generation;
    const currentTime = Number(elPlayer.currentTime ?? 0) || 0;
    const fallbackTime = lastKnownGoodTime > 0 ? lastKnownGoodTime : currentTime;
    const resumeAt = Math.max(0, opts.resumeAt ?? fallbackTime);
    const shouldPlay = opts.wasPlaying ?? wantsPlaying;
    const useMse = qualitySupportsMse(quality);

    log.info("loadQuality", {
      gen,
      id: quality.id,
      label: quality.label,
      height: quality.height,
      progressive: quality.isProgressive,
      mse: useMse,
      resumeAt,
      shouldPlay,
      mime: quality.mimeType,
      videoUrl: quality.videoUrl.slice(0, 96),
      hasAudio: Boolean(quality.audioUrl)
    });

    isTransitionLocked = true;
    stopRebufferPoll();
    setState("switching");
    wantsPlaying = shouldPlay;
    stallTicks = 0;
    lastHealthTime = -1;
    suspendAudio("loadQuality");
    disposeAudio();
    disposeMse("loadQuality");

    // Companion audio only for non-MSE adaptive (legacy dual-element path).
    if (!useMse && !quality.isProgressive && quality.audioUrl) {
      activeAudioUrl = quality.audioUrl.split("#")[0] ?? quality.audioUrl;
    } else {
      activeAudioUrl = null;
    }

    // Force paused + muted for entire transition (provider <video> too)
    runPause(() => {
      try {
        elPlayer.pause?.();
      } catch {
        // ignore
      }
    });
    beginTransitionMute();
    hardResetProviderVideo();

    activeQuality = quality;
    onQualityChange?.(quality);

    if (useMse) {
      await loadQualityMse(quality, gen, resumeAt, shouldPlay);
      return;
    }

    // #t= fragment helps range-fetch near resume; may stick mid-video — recovery below
    elPlayer.src = toSingleSrc(quality, resumeAt);
    setState("loading");
    beginTransitionMute();

    queueMicrotask(() => {
      try {
        elPlayer.startLoading?.();
      } catch {
        // ignore
      }
      if (transitionMuteDepth === 0) {
        beginTransitionMute();
      } else {
        setProviderMuted(true);
      }
      runPause(() => {
        try {
          elPlayer.pause?.();
        } catch {
          // ignore
        }
      });
    });

    // Adaptive mid-video needs longer; progress+buffer also counts as ready
    const loadTimeout = quality.isProgressive
      ? canPlayTimeoutMs
      : Math.max(canPlayTimeoutMs, 35_000);
    let canPlayOk = await waitForCanPlay(
      elPlayer,
      loadTimeout,
      () => isCurrent(gen),
      resumeAt
    );
    if (!isCurrent(gen)) {
      return;
    }

    // Recovery: stuck seeking at target with buffer nearby / no canplay
    if (!canPlayOk || !isPlayableEnough(elPlayer, resumeAt)) {
      log.warn("load can-play stuck — recover", {
        resumeAt,
        video: mediaSnapshot(getProviderVideo(elPlayer))
      });
      const elVideo = getProviderVideo(elPlayer);
      if (elVideo) {
        const snapped = snapToNearbyBuffer(elVideo, resumeAt);
        if (snapped != null && Math.abs(snapped - elVideo.currentTime) > 0.2) {
          log.info("snap to nearby buffer", { from: elVideo.currentTime, snapped, resumeAt });
          try {
            elVideo.currentTime = snapped;
          } catch {
            // ignore
          }
          await waitForEvent(elVideo, "seeked", EVENT_WAIT_MS, () => isCurrent(gen), "snap-seeked");
          canPlayOk = await waitForCanPlay(elPlayer, 8_000, () => isCurrent(gen), snapped);
        }
      }
    }

    if (!isCurrent(gen)) {
      return;
    }

    // Second recovery: reload without #t= fragment then manual seek
    if (!isPlayableEnough(elPlayer, resumeAt) && mediaReadyState(elPlayer) < 2) {
      log.warn("reload without #t= fragment");
      hardResetProviderVideo();
      if (transitionMuteDepth === 0) {
        beginTransitionMute();
      } else {
        setProviderMuted(true);
      }
      elPlayer.src = toSingleSrc(quality, 0);
      queueMicrotask(() => {
        try {
          elPlayer.startLoading?.();
        } catch {
          // ignore
        }
      });
      canPlayOk = await waitForCanPlay(elPlayer, 20_000, () => isCurrent(gen), 0);
      if (!isCurrent(gen)) {
        return;
      }
      if (canPlayOk || mediaReadyState(elPlayer) >= 2) {
        await seekMediaTo(elPlayer, resumeAt, gen, "load-video-nofrag", EVENT_WAIT_MS);
        await ensureSeekLanded(resumeAt, gen, "load-video-nofrag");
      }
    }

    if (!isCurrent(gen)) {
      return;
    }

    if (!isPlayableEnough(elPlayer, resumeAt) && mediaReadyState(elPlayer) < 2) {
      clearAllTransitionMute();
      isTransitionLocked = false;
      setState("error");
      onError?.("Stream is taking too long to start. Try 720p or seek closer to a buffered area.");
      return;
    }

    if (transitionMuteDepth === 0) {
      beginTransitionMute();
    } else {
      setProviderMuted(true);
    }
    runPause(() => {
      try {
        elPlayer.pause?.();
      } catch {
        // ignore
      }
    });

    // Seek + verify landing
    await seekMediaTo(elPlayer, resumeAt, gen, "load-video", EVENT_WAIT_MS);
    if (!isCurrent(gen)) {
      return;
    }
    let landed = await ensureSeekLanded(resumeAt, gen, "load-video");
    if (!isCurrent(gen)) {
      return;
    }

    // If still not covered by buffer, snap into nearest range so we can start
    const elVideoAfter = getProviderVideo(elPlayer);
    if (elVideoAfter && bufferAheadSeconds(elVideoAfter, landed) < 0.3) {
      const snapped = snapToNearbyBuffer(elVideoAfter, resumeAt);
      if (snapped != null) {
        log.info("post-seek snap to buffer", { landed, snapped, resumeAt });
        try {
          elVideoAfter.currentTime = snapped;
        } catch {
          // ignore
        }
        await waitForEvent(elVideoAfter, "seeked", EVENT_WAIT_MS, () => isCurrent(gen), "post-snap");
        landed = readPlayerTime();
      }
    }

    let syncAt = landed;
    if (Math.abs(landed - resumeAt) <= SEEK_LAND_TOLERANCE_S * 4) {
      const resumeCovered = bufferAheadSeconds(getProviderVideo(elPlayer), resumeAt) >= 0.3;
      syncAt = resumeCovered ? resumeAt : landed;
    }
    if (Math.abs(landed - resumeAt) > SEEK_LAND_TOLERANCE_S) {
      log.warn("using adjusted sync point after seek miss", { resumeAt, landed, syncAt });
    }
    lastKnownGoodTime = syncAt;

    // Always use full adaptive cushion so first play after quality change doesn't underrun.
    let minAhead = adaptiveMinAhead(quality);
    if (quality.isProgressive) {
      minAhead = shouldPlay ? MIN_BUFFER_AHEAD_PROGRESSIVE_S : 0.8;
    }
    await waitForBufferAhead(elPlayer, minAhead, MIN_BUFFER_WAIT_MS, () => isCurrent(gen));
    if (!isCurrent(gen)) {
      return;
    }

    // Attach companion audio only after video has a real cushion
    if (activeAudioUrl) {
      log.info("attach companion audio after video buffer", {
        ahead: bufferAheadSeconds(getProviderVideo(elPlayer)),
        syncAt
      });
      await ensureAudioAt(syncAt, gen);
      if (!isCurrent(gen)) {
        return;
      }
      const recheck = readPlayerTime();
      if (Math.abs(recheck - syncAt) > SEEK_LAND_TOLERANCE_S) {
        log.warn("video drifted during audio attach — re-land", { recheck, syncAt });
        await ensureSeekLanded(syncAt, gen, "load-video-resync");
      }
    }

    if (!isCurrent(gen)) {
      return;
    }

    const playhead = readPlayerTime();
    if (elAudio && Math.abs(elAudio.currentTime - playhead) > SEEK_LAND_TOLERANCE_S) {
      await ensureAudioAt(playhead, gen);
    }

    elPlayer.playbackRate = Number(elPlayer.playbackRate ?? 1) || 1;
    lastKnownGoodTime = playhead;

    await finishTransitionPlay(gen, shouldPlay, "loadQuality");
  }

  async function seek(time: number, opts: { wasPlaying?: boolean } = {}) {
    if (disposed) {
      return;
    }
    const gen = ++generation;
    const target = Math.max(0, time);
    const shouldPlay = opts.wasPlaying ?? (!elPlayer.paused || wantsPlaying);

    log.info("seek", {
      gen,
      target,
      shouldPlay,
      from: elPlayer.currentTime,
      mse: isMseActive()
    });

    isTransitionLocked = true;
    stopRebufferPoll();
    setState("seeking");
    wantsPlaying = shouldPlay;
    if (shouldPlay) {
      playbackIntent = true;
    }
    stallTicks = 0;
    suspendAudio("seek");

    beginTransitionMute();

    runPause(() => {
      try {
        elPlayer.pause?.();
      } catch {
        // ignore
      }
    });

    // MSE: rebuild MediaSource around target (sidx-backed)
    if (mse?.isActive()) {
      try {
        log.info("mse seek → reload", { target });
        await mse.seek(target);
      } catch (error) {
        if (!isCurrent(gen)) {
          return;
        }
        log.error("mse seek failed", { error: String(error), target });
        clearAllTransitionMute();
        isTransitionLocked = false;
        setState("error");
        onError?.(error instanceof Error ? error.message : String(error));
        return;
      }
      if (!isCurrent(gen)) {
        return;
      }
      lastKnownGoodTime = readPlayerTime();
      log.info("mse seek reload ready", {
        t: lastKnownGoodTime,
        target,
        stats: mse.getStats(),
        video: mediaSnapshot(getProviderVideo(elPlayer))
      });
      await finishTransitionPlay(gen, shouldPlay, "seek-mse");
      return;
    }

    await seekMediaTo(elPlayer, target, gen, "seek-video", EVENT_WAIT_MS);
    if (!isCurrent(gen)) {
      return;
    }
    const landed = await ensureSeekLanded(target, gen, "seek-video");
    if (!isCurrent(gen)) {
      return;
    }

    await waitForCanPlay(elPlayer, EVENT_WAIT_MS, () => isCurrent(gen));
    if (!isCurrent(gen)) {
      return;
    }

    const syncAt = Math.abs(landed - target) <= SEEK_LAND_TOLERANCE_S * 3 ? target : landed;
    await ensureAudioAt(syncAt, gen);
    if (!isCurrent(gen)) {
      return;
    }

    lastKnownGoodTime = readPlayerTime();
    const seekMinAhead = shouldPlay
      ? Math.max(MIN_PLAY_AHEAD_S, adaptiveMinAhead(activeQuality) * 0.6)
      : 0.5;
    await waitForBufferAhead(elPlayer, seekMinAhead, 14_000, () => isCurrent(gen));
    if (!isCurrent(gen)) {
      return;
    }

    await finishTransitionPlay(gen, shouldPlay, "seek");
  }

  async function applySnapshot(snapshot: AdFreePlaybackSnapshot, forcePause: boolean) {
    log.info("applySnapshot", { ...snapshot, forcePause, busy: isBusy() });
    elPlayer.playbackRate = snapshot.playbackRate > 0 ? snapshot.playbackRate : 1;
    elPlayer.volume = Math.min(1, Math.max(0, snapshot.volume));
    elPlayer.muted = snapshot.muted;
    const shouldPlay = !forcePause && snapshot.wasPlaying;

    // Initial load already seeks to the same time — skip redundant seek (was gen1/gen2 race)
    const live = readPlayerTime();
    const nearLive = Math.abs(live - snapshot.currentTime) <= 1.5;
    const nearKnown = Math.abs(lastKnownGoodTime - snapshot.currentTime) <= 1.5;
    if (nearLive || nearKnown) {
      lastKnownGoodTime = Math.max(lastKnownGoodTime, snapshot.currentTime);
      // live≈0 while lastKnown/target mid-file: put playhead back before UI play
      if (!nearLive && nearKnown && isMseActive()) {
        restoreMsePlayhead("applySnapshot");
      }
      if (!forcePause && snapshot.wasPlaying) {
        wantsPlaying = true;
        playbackIntent = true;
        // Already playing with intent — do NOT re-requestPlay (thin-buffer rebuffer
        // flicker right after first ready: pause → grace re-play → flash).
        const alreadyPlaying = !elPlayer.paused || state === "playing" || isRebuffering;
        if (!alreadyPlaying) {
          void requestPlay("applySnapshot-near");
        } else {
          log.debug("applySnapshot near — already playing/rebuffering, skip requestPlay", {
            state,
            paused: elPlayer.paused,
            isRebuffering
          });
        }
      } else {
        wantsPlaying = false;
        playbackIntent = false;
        runPause(() => {
          elPlayer.pause?.();
        });
      }
      log.debug("applySnapshot skipped (already at target)", {
        live: readPlayerTime(),
        target: snapshot.currentTime,
        busy: isBusy(),
        shouldPlay
      });
      return;
    }

    if (isBusy()) {
      lastKnownGoodTime = Math.max(lastKnownGoodTime, snapshot.currentTime);
      log.debug("applySnapshot deferred — busy", { live, target: snapshot.currentTime });
      return;
    }

    await seek(snapshot.currentTime, { wasPlaying: shouldPlay });
  }

  return {
    getState() {
      return state;
    },
    getGeneration() {
      return generation;
    },
    getActiveQuality() {
      return activeQuality;
    },
    getLastKnownGoodTime() {
      return lastKnownGoodTime;
    },
    isSafeToResume,
    isBusy,
    getVideoElement() {
      return getProviderVideo(elPlayer);
    },
    getAudioElement() {
      return elAudio;
    },
    captureSnapshot(videoId) {
      const busy = isBusy();
      const liveTime = Number(elPlayer.currentTime ?? lastKnownGoodTime) || lastKnownGoodTime;
      const seconds = busy ? lastKnownGoodTime : liveTime;
      return {
        videoId,
        currentTime: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
        wasPlaying: !elPlayer.paused || wantsPlaying,
        playbackRate: Number(elPlayer.playbackRate ?? 1) || 1,
        volume: Number(elPlayer.volume ?? 1) || 1,
        muted: Boolean(elPlayer.muted)
      };
    },
    loadQuality,
    seek,
    applySnapshot,
    async play() {
      wantsPlaying = true;
      playbackIntent = true;
      if (isBusy()) {
        log.debug("play() ignored — busy", { state, userSeek: isUserSeekPending });
        return;
      }
      log.info("play()", {
        state,
        ahead: bufferAheadSeconds(getProviderVideo(elPlayer))
      });
      let ahead = bufferAheadSeconds(getProviderVideo(elPlayer));
      if (ahead < MIN_PLAY_AHEAD_S) {
        log.info("play() waiting for buffer", { ahead });
        await waitForBufferAhead(
          elPlayer,
          MIN_PLAY_AHEAD_S,
          8_000,
          () => !disposed && !isBusy()
        );
        if (disposed || isBusy()) {
          log.debug("play() aborted after buffer wait — busy");
          return;
        }
        ahead = bufferAheadSeconds(getProviderVideo(elPlayer));
        if (ahead < 0.35) {
          log.warn("play() still no buffer — abort", { ahead });
          return;
        }
      }
      await requestPlay("play()");
    },
    pause() {
      log.info("pause()");
      wantsPlaying = false;
      playbackIntent = false;
      ignorePauseUntil = 0;
      runPause(() => {
        elPlayer.pause?.();
        getProviderVideo(elPlayer)?.pause();
      });
      suspendAudio("pause()");
      if (!isBusy() && state !== "error" && state !== "idle") {
        setState("ready");
      }
    },
    setWantsPlaying(value) {
      // Never clear wantsPlaying from outside while locked / rebuffering
      // (log: rebuffer pause → wantsPlaying=false → stuck silent video)
      if (!value && (isBusy() || isRebuffering)) {
        log.debug("setWantsPlaying(false) ignored during transition/rebuffer");
        return;
      }
      log.debug(`setWantsPlaying=${value}`);
      wantsPlaying = value;
      if (value) {
        playbackIntent = true;
      } else {
        playbackIntent = false;
        stopRebufferPoll();
      }
    },
    getWantsPlaying() {
      return wantsPlaying;
    },
    dispose() {
      log.info("dispose");
      disposed = true;
      generation += 1;
      clearAllTransitionMute();
      isTransitionLocked = false;
      isUserSeekPending = false;
      stopRebufferPoll();
      if (userSeekDebounceId) {
        window.clearTimeout(userSeekDebounceId);
        userSeekDebounceId = 0;
      }
      if (userSeekWatchdogId) {
        window.clearTimeout(userSeekWatchdogId);
        userSeekWatchdogId = 0;
      }
      window.clearInterval(healthPollId);
      activeAudioUrl = null;
      disposeMse("engine-dispose");
      disposeAudio();
      elPlayer.removeEventListener("time-update", onTimeUpdate);
      elPlayer.removeEventListener("timeupdate", onTimeUpdate);
      elPlayer.removeEventListener("playing", onPlaying);
      elPlayer.removeEventListener("pause", onPause);
      elPlayer.removeEventListener("waiting", onWaiting);
      elPlayer.removeEventListener("stalled", onWaiting);
      elPlayer.removeEventListener("volume-change", onVolumeChange);
      elPlayer.removeEventListener("volumechange", onVolumeChange);
      elPlayer.removeEventListener("rate-change", onRateChange);
      elPlayer.removeEventListener("ratechange", onRateChange);
      elPlayer.removeEventListener("seeking", onSeeking);
      elPlayer.removeEventListener("seeked", onSeeked);
      elPlayer.removeEventListener("progress", onProgress);
      setState("idle");
    }
  };
}

/**
 * Prefer MSE adaptive ≤1080p when available (ad-free high quality without dual-element).
 * Fall back to progressive muxed, then highest remaining.
 */
export function pickDefaultQuality(qualities: AdFreeQualityOption[]): AdFreeQualityOption {
  const mseReady = qualities
    .filter(item => qualitySupportsMse(item))
    .sort((left, right) => (right.height ?? 0) - (left.height ?? 0));
  const mse1080 = mseReady.find(item => (item.height ?? 0) <= 1080 && (item.height ?? 0) >= 720);
  if (mse1080) {
    return mse1080;
  }
  if (mseReady[0] && (mseReady[0].height ?? 0) <= 1440) {
    return mseReady[0];
  }

  const progressive = qualities
    .filter(item => item.isProgressive)
    .sort((left, right) => (right.height ?? 0) - (left.height ?? 0));
  if (progressive[0]) {
    return progressive[0];
  }
  return mseReady[0]
    ?? [...qualities].sort((left, right) => (right.height ?? 0) - (left.height ?? 0))[0];
}

export function orderQualitiesForMenu(qualities: AdFreeQualityOption[]): AdFreeQualityOption[] {
  return [...qualities].sort((left, right) => {
    if (left.isProgressive !== right.isProgressive) {
      return left.isProgressive ? 1 : -1;
    }
    return (right.height ?? 0) - (left.height ?? 0);
  });
}

export function isMediaPlayerLike(element: HTMLElement): element is MediaPlayerLike {
  return element.tagName.toLowerCase() === "media-player";
}
