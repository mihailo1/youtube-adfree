import type { AdFreePlaybackSnapshot } from "@/lib/ad-free/bridge";
import { readTimeFromLocation } from "@/lib/ad-free/youtube-time";
import { getYtPlayer, getYtVideo } from "@/lib/ad-free/content-dom";

export function captureYouTubeSnapshot(videoId: string): AdFreePlaybackSnapshot {
  const elPlayer = getYtPlayer();
  const elVideo = getYtVideo();

  let currentTime = 0;
  try {
    currentTime = elPlayer?.getCurrentTime?.() ?? elVideo?.currentTime ?? 0;
  } catch {
    currentTime = elVideo?.currentTime ?? 0;
  }
  const urlTime = readTimeFromLocation();
  if ((!Number.isFinite(currentTime) || currentTime < 0.5) && urlTime > 0) {
    currentTime = urlTime;
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

export function pauseYouTubePlayer() {
  const elVideo = getYtVideo();
  elVideo?.pause();
  try {
    getYtPlayer()?.pauseVideo?.();
  } catch {
    // ignore
  }
}

export function applyYouTubeSnapshot(snapshot: AdFreePlaybackSnapshot, forcePause: boolean) {
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
