/**
 * YouTube-style keyboard shortcuts for the Ad-Free Vidstack player.
 * Mirrors common watch-page hotkeys without binding page-level keys (t, /).
 */

import type { PlaybackEngine } from "@/lib/ad-free/playback-engine";
import type { MediaPlayerLike } from "@/lib/ad-free/playback-engine";

const SEEK_SMALL_S = 5;
const SEEK_LARGE_S = 10;
const VOLUME_STEP = 0.05;
const FRAME_STEP_S = 1 / 30;
const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type HotkeysController = {
  dispose: () => void;
};

export type HotkeysOptions = {
  elPlayer: MediaPlayerLike;
  engine: PlaybackEngine;
  /** Mark intentional play (keep-playing / pause window). */
  onPlayIntent?: () => void;
  /** Mark intentional pause. */
  onPauseIntent?: () => void;
  /** Optional toast for seek flash (e.g. "« 10"). */
  onSeekFlash?: (deltaSeconds: number) => void;
  /** Optional toast for speed change. */
  onSpeedFlash?: (rate: number) => void;
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) {
    return true;
  }
  // Open menus / dialogs — let arrow keys navigate items
  if (target.closest(
    "media-menu-items, .vds-menu-items, media-menu[data-open], .vds-menu[data-open], "
    + "[role='listbox'], [role='menu'], .ytdl-quality-list"
  )) {
    return true;
  }
  return false;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readTime(elPlayer: MediaPlayerLike, engine: PlaybackEngine) {
  const known = engine.getLastKnownGoodTime();
  if (known > 0) {
    return known;
  }
  return Number(elPlayer.currentTime ?? 0) || 0;
}

function readDuration(elPlayer: MediaPlayerLike) {
  const d = Number(elPlayer.duration ?? 0);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function nearestSpeedIndex(rate: number) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < SPEED_STEPS.length; i += 1) {
    const dist = Math.abs(SPEED_STEPS[i] - rate);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function toggleFullscreen(elPlayer: MediaPlayerLike) {
  const anyPlayer = elPlayer as MediaPlayerLike & {
    enterFullscreen?: () => Promise<void>;
    exitFullscreen?: () => Promise<void>;
    fullscreen?: boolean;
  };
  const isFs = Boolean(
    anyPlayer.fullscreen
    || document.fullscreenElement
    || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement
  );
  if (isFs) {
    if (typeof anyPlayer.exitFullscreen === "function") {
      void anyPlayer.exitFullscreen().catch(() => {});
      return;
    }
    void document.exitFullscreen?.().catch(() => {});
    return;
  }
  if (typeof anyPlayer.enterFullscreen === "function") {
    void anyPlayer.enterFullscreen().catch(() => {});
    return;
  }
  void elPlayer.requestFullscreen?.().catch(() => {});
}

function toggleCaptions(engine: PlaybackEngine, elPlayer: MediaPlayerLike) {
  const elVideo = engine.getVideoElement()
    ?? elPlayer.querySelector("video");
  if (!(elVideo instanceof HTMLVideoElement) || elVideo.textTracks.length === 0) {
    // Fall back to caption button
    const elBtn = elPlayer.querySelector(
      "media-caption-button, .vds-caption-button"
    );
    if (elBtn instanceof HTMLElement) {
      elBtn.click();
    }
    return;
  }

  let anyShowing = false;
  for (const track of elVideo.textTracks) {
    if (track.kind !== "subtitles" && track.kind !== "captions") {
      continue;
    }
    if (track.mode === "showing") {
      anyShowing = true;
      break;
    }
  }

  let flipped = false;
  for (const track of elVideo.textTracks) {
    if (track.kind !== "subtitles" && track.kind !== "captions") {
      continue;
    }
    if (anyShowing) {
      track.mode = "hidden";
    } else if (!flipped) {
      track.mode = "showing";
      flipped = true;
    } else {
      track.mode = "hidden";
    }
  }
}

function toggleMute(elPlayer: MediaPlayerLike) {
  elPlayer.muted = !elPlayer.muted;
  const elVideo = elPlayer.querySelector("video");
  if (elVideo instanceof HTMLVideoElement) {
    elVideo.muted = Boolean(elPlayer.muted);
  }
}

function setVolume(elPlayer: MediaPlayerLike, volume: number) {
  const next = clamp(volume, 0, 1);
  elPlayer.volume = next;
  if (next > 0 && elPlayer.muted) {
    elPlayer.muted = false;
  }
  const elVideo = elPlayer.querySelector("video");
  if (elVideo instanceof HTMLVideoElement) {
    elVideo.volume = next;
    elVideo.muted = Boolean(elPlayer.muted);
  }
}

function setRate(elPlayer: MediaPlayerLike, rate: number) {
  const next = clamp(rate, 0.25, 2);
  elPlayer.playbackRate = next;
  const elVideo = elPlayer.querySelector("video");
  if (elVideo instanceof HTMLVideoElement) {
    elVideo.playbackRate = next;
  }
  const elAudio = elPlayer.querySelector("audio");
  if (elAudio instanceof HTMLAudioElement) {
    elAudio.playbackRate = next;
  }
}

export function installHotkeys(options: HotkeysOptions): HotkeysController {
  const {
    elPlayer,
    engine,
    onPlayIntent,
    onPauseIntent,
    onSeekFlash,
    onSpeedFlash
  } = options;

  function seekBy(delta: number) {
    if (engine.isBusy()) {
      return;
    }
    const duration = readDuration(elPlayer);
    const from = readTime(elPlayer, engine);
    const target = duration > 0
      ? clamp(from + delta, 0, Math.max(0, duration - 0.05))
      : Math.max(0, from + delta);
    const wasPlaying = !elPlayer.paused || engine.getWantsPlaying();
    onSeekFlash?.(delta);
    void engine.seek(target, { wasPlaying });
  }

  function seekToFraction(fraction: number) {
    if (engine.isBusy()) {
      return;
    }
    const duration = readDuration(elPlayer);
    if (duration <= 0) {
      return;
    }
    const target = clamp(duration * fraction, 0, Math.max(0, duration - 0.05));
    const wasPlaying = !elPlayer.paused || engine.getWantsPlaying();
    void engine.seek(target, { wasPlaying });
  }

  function togglePlay() {
    if (engine.isBusy()) {
      return;
    }
    const isPaused = Boolean(elPlayer.paused) && !engine.getWantsPlaying();
    if (isPaused) {
      onPlayIntent?.();
      void engine.play();
    } else {
      onPauseIntent?.();
      engine.pause();
    }
  }

  function stepFrame(direction: 1 | -1) {
    if (engine.isBusy()) {
      return;
    }
    // Frame step only while paused (YouTube behavior)
    if (!elPlayer.paused && engine.getWantsPlaying()) {
      return;
    }
    onPauseIntent?.();
    engine.pause();
    const from = readTime(elPlayer, engine);
    const duration = readDuration(elPlayer);
    const target = duration > 0
      ? clamp(from + direction * FRAME_STEP_S, 0, duration)
      : Math.max(0, from + direction * FRAME_STEP_S);
    void engine.seek(target, { wasPlaying: false });
  }

  function nudgeSpeed(direction: 1 | -1) {
    const current = Number(elPlayer.playbackRate ?? 1) || 1;
    const idx = nearestSpeedIndex(current);
    const nextIdx = clamp(idx + direction, 0, SPEED_STEPS.length - 1);
    const next = SPEED_STEPS[nextIdx];
    setRate(elPlayer, next);
    onSpeedFlash?.(next);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }

    const key = event.key;
    const code = event.code;

    // Space / k — play-pause
    if (key === " " || key === "Spacebar" || key === "k" || key === "K" || key === "MediaPlayPause") {
      event.preventDefault();
      event.stopPropagation();
      togglePlay();
      return;
    }

    // j / l — ±10s
    if (key === "j" || key === "J") {
      event.preventDefault();
      seekBy(-SEEK_LARGE_S);
      return;
    }
    if (key === "l" || key === "L") {
      event.preventDefault();
      seekBy(SEEK_LARGE_S);
      return;
    }

    // Arrows — seek / volume
    if (key === "ArrowLeft") {
      event.preventDefault();
      seekBy(-SEEK_SMALL_S);
      return;
    }
    if (key === "ArrowRight") {
      event.preventDefault();
      seekBy(SEEK_SMALL_S);
      return;
    }
    if (key === "ArrowUp") {
      event.preventDefault();
      setVolume(elPlayer, (Number(elPlayer.volume) || 0) + VOLUME_STEP);
      return;
    }
    if (key === "ArrowDown") {
      event.preventDefault();
      setVolume(elPlayer, (Number(elPlayer.volume) || 0) - VOLUME_STEP);
      return;
    }

    // m — mute
    if (key === "m" || key === "M") {
      event.preventDefault();
      toggleMute(elPlayer);
      return;
    }

    // f — fullscreen
    if (key === "f" || key === "F") {
      event.preventDefault();
      toggleFullscreen(elPlayer);
      return;
    }

    // c — captions
    if (key === "c" || key === "C") {
      event.preventDefault();
      toggleCaptions(engine, elPlayer);
      return;
    }

    // i — picture-in-picture
    if (key === "i" || key === "I") {
      event.preventDefault();
      const elVideo = engine.getVideoElement()
        ?? elPlayer.querySelector("video");
      if (!(elVideo instanceof HTMLVideoElement) || typeof elVideo.requestPictureInPicture !== "function") {
        return;
      }
      if (document.pictureInPictureElement === elVideo) {
        void document.exitPictureInPicture?.().catch(() => {});
      } else {
        void elVideo.requestPictureInPicture().catch(() => {});
      }
      return;
    }

    // 0–9 — jump to n×10%
    if (/^[0-9]$/.test(key) && !event.shiftKey) {
      event.preventDefault();
      seekToFraction(Number(key) / 10);
      return;
    }

    // < / > speed (Shift+, / Shift+.)
    if (key === "<" || (key === "," && event.shiftKey) || code === "Comma" && event.shiftKey) {
      event.preventDefault();
      nudgeSpeed(-1);
      return;
    }
    if (key === ">" || (key === "." && event.shiftKey) || code === "Period" && event.shiftKey) {
      event.preventDefault();
      nudgeSpeed(1);
      return;
    }

    // , / . frame step when paused
    if (key === "," || code === "Comma") {
      event.preventDefault();
      stepFrame(-1);
      return;
    }
    if (key === "." || code === "Period") {
      event.preventDefault();
      stepFrame(1);
    }
  }

  // Single window capture listener (iframe document) — avoid double-fire with elPlayer
  window.addEventListener("keydown", onKeyDown, true);

  // Click video surface → focus player so subsequent keys work without second click
  function onPointerDown(event: PointerEvent) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.closest(
      "media-menu, media-menu-button, media-controls, .vds-controls, .ytdl-quality-section, "
      + "input, button, a, media-time-slider, media-volume-slider"
    )) {
      return;
    }
    try {
      elPlayer.focus({ preventScroll: true });
    } catch {
      elPlayer.tabIndex = 0;
      elPlayer.focus();
    }
  }
  elPlayer.addEventListener("pointerdown", onPointerDown, true);

  if (!elPlayer.hasAttribute("tabindex")) {
    elPlayer.tabIndex = 0;
  }

  return {
    dispose() {
      window.removeEventListener("keydown", onKeyDown, true);
      elPlayer.removeEventListener("pointerdown", onPointerDown, true);
    }
  };
}
