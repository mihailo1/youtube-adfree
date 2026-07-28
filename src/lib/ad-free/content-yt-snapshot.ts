import type { AdFreePlaybackSnapshot } from "@/lib/ad-free/bridge";
import { readTimeFromLocation } from "@/lib/ad-free/youtube-time";
import { getPlayerHost, getYtPlayer, getYtVideo } from "@/lib/ad-free/content-dom";

/**
 * True when the native player is showing a pre-roll / mid-roll ad.
 * Used so Always Ad-Free can auto-play content instead of inheriting ad time/pause.
 */
/** Compact YT player probe (visibility / ad state). No getComputedStyle (reflow). */
export function probeYouTubeVisibleState() {
  const elHost = getPlayerHost();
  const elPlayer = getYtPlayer();
  const elVideo = getYtVideo();
  let playerState: number | null = null;
  try {
    playerState = elPlayer?.getPlayerState?.() ?? null;
  } catch {
    playerState = null;
  }
  return {
    hasHost: Boolean(elHost),
    hostActiveClass: Boolean(elHost?.classList.contains("ytdl-ad-free-active")),
    isAd: isYouTubeShowingAd(),
    playerState,
    // 1=playing, 2=paused, 3=buffering, 5=cued, -1=unstarted
    video: elVideo
      ? {
        paused: elVideo.paused,
        muted: elVideo.muted,
        t: Number(elVideo.currentTime.toFixed(2)),
        rs: elVideo.readyState
      }
      : null
  };
}

export function isYouTubeShowingAd(): boolean {
  const elHost = getPlayerHost() ?? getYtPlayer();
  if (elHost) {
    if (elHost.classList.contains("ad-showing")
      || elHost.classList.contains("ad-interrupting")
      || elHost.classList.contains("ytp-ad-player-overlay")
      || elHost.hasAttribute("ad-showing")) {
      return true;
    }
  }
  // Overlay / module presence (YouTube markup varies)
  if (document.querySelector(
    "#movie_player.ad-showing, "
    + "#movie_player.ad-interrupting, "
    + ".html5-video-player.ad-showing, "
    + ".ytp-ad-player-overlay:not([style*='display: none']), "
    + ".ytp-ad-module .ytp-ad-player-overlay, "
    + ".video-ads .ad-showing, "
    + ".ytp-ad-text.ytp-ad-preview-text, "
    + ".ytp-ad-skip-button, "
    + ".ytp-skip-ad-button, "
    + "button.ytp-ad-skip-button-modern"
  )) {
    return true;
  }
  return false;
}

export function captureYouTubeSnapshot(videoId: string): AdFreePlaybackSnapshot {
  const elPlayer = getYtPlayer();
  const elVideo = getYtVideo();
  const isAd = isYouTubeShowingAd();
  const urlTime = readTimeFromLocation();

  let currentTime = 0;
  try {
    currentTime = elPlayer?.getCurrentTime?.() ?? elVideo?.currentTime ?? 0;
  } catch {
    currentTime = elVideo?.currentTime ?? 0;
  }
  // During ads the HTML5 clock is the ad, not content — prefer URL t= / start
  if (isAd) {
    currentTime = urlTime > 0 ? urlTime : 0;
  } else if ((!Number.isFinite(currentTime) || currentTime < 0.5) && urlTime > 0) {
    currentTime = urlTime;
  }

  let wasPlaying = false;
  try {
    const state = elPlayer?.getPlayerState?.();
    // 1 = playing, 3 = buffering (still an active watch intent)
    wasPlaying = state === 1 || state === 3
      || Boolean(elVideo && !elVideo.paused && !elVideo.ended);
  } catch {
    wasPlaying = Boolean(elVideo && !elVideo.paused && !elVideo.ended);
  }
  // Always Ad-Free mid-ad: user opened a video to watch — autoplay content
  if (isAd) {
    wasPlaying = true;
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
