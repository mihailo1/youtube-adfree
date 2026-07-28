import type { YtPlayerEl } from "@/lib/ad-free/content-dom";
import { getYtPlayer, getYtVideo } from "@/lib/ad-free/content-dom";
import { createAdFreeLogger } from "@/lib/ad-free/debug-log";

const PARK_POLL_MS = 500;
const log = createAdFreeLogger("park");

type ParkedApi = {
  playVideo?: () => void;
  play?: () => void;
  loadVideoById?: (...args: unknown[]) => void;
  cueVideoById?: (...args: unknown[]) => void;
  stopVideo?: () => void;
};

export type YouTubeParkController = {
  isParked: () => boolean;
  isUnloaded: () => boolean;
  park: () => void;
  /**
   * Free the original player from memory: stop decoding, drop media buffers/src.
   * Call after Ad-Free is ready so YT is not competing for RAM/decoder.
   */
  unload: () => void;
  unpark: () => void;
  /**
   * Restore YouTube media after unload (or soft park).
   * Uses loadVideoById when available so an emptied <video> can recover.
   */
  reload: (videoId: string, startSeconds: number, options?: {
    play?: boolean;
    volume?: number;
    muted?: boolean;
    playbackRate?: number;
  }) => void;
};

/**
 * Hard-park the YouTube HTML5 player while Ad-Free owns playback.
 * One-shot pause is not enough — Polymer re-autoplays on focus/ads/SPA.
 * `unload()` goes further and detaches media to free memory.
 */
export function createYouTubeParkController(): YouTubeParkController {
  let isParked = false;
  let isUnloaded = false;
  let pollId = 0;
  let elBoundVideo: HTMLVideoElement | null = null;
  const originals = new WeakMap<object, ParkedApi>();

  function onVideoPlay(event: Event) {
    if (!isParked) {
      return;
    }
    const target = event.currentTarget;
    if (!(target instanceof HTMLVideoElement)) {
      return;
    }
    try {
      target.pause();
      target.muted = true;
      target.volume = 0;
    } catch {
      // ignore
    }
  }

  function enforceParkOnVideo(elVideo: HTMLVideoElement | null) {
    if (!elVideo) {
      return;
    }
    try {
      elVideo.pause();
      elVideo.muted = true;
      elVideo.volume = 0;
    } catch {
      // ignore
    }
  }

  function enforceParkOnApi(elPlayer: YtPlayerEl | null) {
    if (!elPlayer) {
      return;
    }
    try {
      elPlayer.pauseVideo?.();
      elPlayer.mute?.();
      elPlayer.setVolume?.(0);
    } catch {
      // ignore
    }
  }

  function bindVideo(elVideo: HTMLVideoElement | null) {
    if (elBoundVideo === elVideo) {
      return;
    }
    if (elBoundVideo) {
      elBoundVideo.removeEventListener("play", onVideoPlay, true);
      elBoundVideo.removeEventListener("playing", onVideoPlay, true);
    }
    elBoundVideo = elVideo;
    if (elBoundVideo) {
      elBoundVideo.addEventListener("play", onVideoPlay, true);
      elBoundVideo.addEventListener("playing", onVideoPlay, true);
    }
  }

  function patchPlayerApi(elPlayer: YtPlayerEl | null) {
    if (!elPlayer) {
      return;
    }
    if (originals.has(elPlayer)) {
      return;
    }

    const player: YtPlayerEl & ParkedApi = elPlayer;
    const snapshot: ParkedApi = {
      playVideo: player.playVideo?.bind(player),
      play: typeof player.play === "function" ? player.play.bind(player) : undefined,
      loadVideoById: typeof player.loadVideoById === "function"
        ? player.loadVideoById.bind(player)
        : undefined,
      cueVideoById: typeof player.cueVideoById === "function"
        ? player.cueVideoById.bind(player)
        : undefined,
      stopVideo: typeof player.stopVideo === "function"
        ? player.stopVideo.bind(player)
        : undefined
    };
    originals.set(elPlayer, snapshot);

    function blockedPlayVideo() {
      if (isParked) {
        enforceParkOnApi(elPlayer);
        enforceParkOnVideo(getYtVideo());
        return;
      }
      snapshot.playVideo?.();
    }

    try {
      if (snapshot.playVideo) {
        player.playVideo = blockedPlayVideo;
      }
      if (snapshot.play) {
        player.play = function blockedPlay() {
          if (isParked) {
            enforceParkOnApi(elPlayer);
            enforceParkOnVideo(getYtVideo());
            return;
          }
          return snapshot.play?.();
        };
      }
      if (snapshot.loadVideoById) {
        player.loadVideoById = function blockedLoad(...args: unknown[]) {
          if (isParked) {
            enforceParkOnApi(elPlayer);
            return;
          }
          return snapshot.loadVideoById?.(...args);
        };
      }
      if (snapshot.cueVideoById) {
        player.cueVideoById = function blockedCue(...args: unknown[]) {
          if (isParked) {
            return;
          }
          return snapshot.cueVideoById?.(...args);
        };
      }
    } catch {
      // Player API surface varies across YT builds
    }
  }

  function restorePlayerApi(elPlayer: YtPlayerEl | null) {
    if (!elPlayer) {
      return;
    }
    const snapshot = originals.get(elPlayer);
    if (!snapshot) {
      return;
    }
    const player: YtPlayerEl & ParkedApi = elPlayer;
    try {
      if (snapshot.playVideo) {
        player.playVideo = snapshot.playVideo;
      }
      if (snapshot.play) {
        player.play = snapshot.play;
      }
      if (snapshot.loadVideoById) {
        player.loadVideoById = snapshot.loadVideoById;
      }
      if (snapshot.cueVideoById) {
        player.cueVideoById = snapshot.cueVideoById;
      }
    } catch {
      // ignore
    }
    originals.delete(elPlayer);
  }

  function detachVideoElement(elVideo: HTMLVideoElement | null) {
    if (!elVideo) {
      return;
    }
    try {
      elVideo.pause();
      elVideo.removeAttribute("src");
      elVideo.srcObject = null;
      // Drop any <source> children YouTube may have attached
      while (elVideo.firstChild) {
        elVideo.removeChild(elVideo.firstChild);
      }
      elVideo.load();
    } catch {
      // ignore
    }
  }

  function tick() {
    if (!isParked) {
      return;
    }
    const elPlayer = getYtPlayer();
    const elVideo = getYtVideo();
    patchPlayerApi(elPlayer);
    bindVideo(elVideo);
    enforceParkOnApi(elPlayer);
    enforceParkOnVideo(elVideo);
    // If something reattached media while parked, re-detach when unloaded
    if (isUnloaded && elVideo?.src) {
      detachVideoElement(elVideo);
    }
  }

  return {
    isParked() {
      return isParked;
    },
    isUnloaded() {
      return isUnloaded;
    },
    park() {
      log.debug("park");
      isParked = true;
      tick();
      if (!pollId) {
        pollId = window.setInterval(tick, PARK_POLL_MS);
      }
    },
    unload() {
      log.info("unload original");
      isParked = true;
      isUnloaded = true;
      const elPlayer = getYtPlayer();
      const elVideo = getYtVideo();
      patchPlayerApi(elPlayer);
      bindVideo(elVideo);
      try {
        elPlayer?.stopVideo?.();
      } catch {
        // ignore
      }
      enforceParkOnApi(elPlayer);
      detachVideoElement(elVideo);
      if (!pollId) {
        pollId = window.setInterval(tick, PARK_POLL_MS);
      }
    },
    unpark() {
      log.debug("unpark");
      isParked = false;
      if (pollId) {
        window.clearInterval(pollId);
        pollId = 0;
      }
      bindVideo(null);
      restorePlayerApi(getYtPlayer());
      // isUnloaded stays true until reload() so callers know to loadVideoById
    },
    reload(videoId, startSeconds, options = {}) {
      const {
        play = false,
        volume = 1,
        muted = false,
        playbackRate = 1
      } = options;
      log.info("reload original", {
        videoId,
        startSeconds,
        play,
        wasUnloaded: isUnloaded
      });

      isParked = false;
      if (pollId) {
        window.clearInterval(pollId);
        pollId = 0;
      }
      bindVideo(null);
      restorePlayerApi(getYtPlayer());

      const elPlayer = getYtPlayer();
      const elVideo = getYtVideo();
      const time = Math.max(0, startSeconds);

      try {
        elPlayer?.setPlaybackRate?.(playbackRate > 0 ? playbackRate : 1);
        elPlayer?.setVolume?.(Math.round(Math.min(1, Math.max(0, volume)) * 100));
        if (muted) {
          elPlayer?.mute?.();
        } else {
          elPlayer?.unMute?.();
        }
      } catch {
        // ignore
      }
      if (elVideo) {
        try {
          elVideo.playbackRate = playbackRate > 0 ? playbackRate : 1;
          elVideo.volume = Math.min(1, Math.max(0, volume));
          elVideo.muted = muted;
        } catch {
          // ignore
        }
      }

      // Prefer API that matches intent: load (plays) vs cue (paused)
      try {
        if (play && typeof elPlayer?.loadVideoById === "function") {
          elPlayer.loadVideoById({ videoId, startSeconds: time });
        } else if (!play && typeof elPlayer?.cueVideoById === "function") {
          elPlayer.cueVideoById({ videoId, startSeconds: time });
        } else if (typeof elPlayer?.loadVideoById === "function") {
          elPlayer.loadVideoById({ videoId, startSeconds: time });
          if (!play) {
            window.setTimeout(() => {
              try {
                elPlayer.pauseVideo?.();
              } catch {
                // ignore
              }
            }, 200);
          }
        } else if (typeof elPlayer?.cueVideoById === "function") {
          elPlayer.cueVideoById({ videoId, startSeconds: time });
          if (play) {
            elPlayer.playVideo?.();
          }
        } else {
          elPlayer?.seekTo?.(time, true);
          if (elVideo) {
            elVideo.currentTime = time;
          }
          if (play) {
            elPlayer?.playVideo?.();
          } else {
            elPlayer?.pauseVideo?.();
          }
        }
      } catch {
        try {
          elPlayer?.seekTo?.(time, true);
          if (play) {
            elPlayer?.playVideo?.();
          }
        } catch {
          // ignore
        }
      }

      isUnloaded = false;
    }
  };
}
