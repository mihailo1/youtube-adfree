import { createAdFreeLogger, mediaSnapshot } from "@/lib/ad-free/debug-log";

const KEEP_PLAYING_POLL_MS = 1200;
const log = createAdFreeLogger("keep-playing");

export type KeepPlayingController = {
  /** User wants media to keep playing (survives window blur / tab backgrounding). */
  setWantsPlaying: (value: boolean) => void;
  getWantsPlaying: () => boolean;
  /** Allow the next pause() calls (player switch or intentional user pause). */
  allowPause: <T>(run: () => T) => T;
  dispose: () => void;
};

export type KeepPlayingOptions = {
  /**
   * When false, do not force-resume (engine mid seek/quality/load).
   * Defaults to always-safe when omitted.
   */
  isSafeToResume?: () => boolean;
  /**
   * Engine-owned resume. Prefer this over blasting play() on every media element —
   * independent companion-audio resume causes A/V loops and silent drift.
   */
  onForceResume?: () => void;
};

/**
 * Keep playback running when the OS/browser window loses focus.
 * Visibility spoof alone is not enough - Chrome still pauses media; we re-assert play.
 */
export function installKeepPlaying(options: KeepPlayingOptions = {}): KeepPlayingController {
  let wantsPlaying = false;
  let allowPauseDepth = 0;
  let lastResumeAt = 0;
  let lastLoggedBlockAt = 0;
  const isSafeToResume = options.isSafeToResume ?? (() => true);
  const onForceResume = options.onForceResume;

  const protoHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
  const protoVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  const protoHasFocus = Document.prototype.hasFocus;
  const originalHasFocus = document.hasFocus;

  function getRealHidden() {
    try {
      return Boolean(protoHidden?.get?.call(document));
    } catch {
      return false;
    }
  }

  try {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible"
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false
    });
    document.hasFocus = () => true;
    log.debug("visibility spoof installed");
  } catch (error) {
    log.warn("visibility spoof failed", { error: String(error) });
  }

  function blockBubble(event: Event) {
    log.debug(`blocked event ${event.type}`);
    event.stopImmediatePropagation();
  }
  document.addEventListener("visibilitychange", blockBubble, true);
  window.addEventListener("pagehide", blockBubble, true);
  window.addEventListener("blur", blockBubble, true);
  window.addEventListener("freeze", blockBubble, true);

  function isBackgrounded() {
    try {
      return getRealHidden() || !protoHasFocus.call(document);
    } catch {
      return false;
    }
  }

  function mediaHasBuffer(media: HTMLMediaElement): boolean {
    try {
      if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        return true;
      }
      if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && media.networkState === HTMLMediaElement.NETWORK_LOADING) {
        // Still loading next segment — don't force restart
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  const originalPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function patchedPause(this: HTMLMediaElement) {
    if (wantsPlaying && allowPauseDepth === 0 && isBackgrounded()) {
      // Only block pause when we actually have data to keep showing.
      // Blocking pause during underrun freezes a short buffered segment in a loop.
      if (mediaHasBuffer(this)) {
        const now = Date.now();
        if (now - lastLoggedBlockAt > 2000) {
          lastLoggedBlockAt = now;
          log.debug("blocked pause (background + has buffer)", mediaSnapshot(this));
        }
        return;
      }
      log.debug("allow pause (background underrun)", mediaSnapshot(this));
    }
    return originalPause.call(this);
  };

  function resumePlayback(reason: string) {
    if (!wantsPlaying || !isSafeToResume()) {
      log.debug(`resume skip (${reason})`, {
        wantsPlaying,
        safe: isSafeToResume()
      });
      return;
    }

    // Don't hammer play while buffer is empty — causes 0.2s play/reset loop
    const elVideo = document.querySelector("video");
    if (elVideo instanceof HTMLVideoElement) {
      try {
        const ranges = elVideo.buffered;
        let ahead = 0;
        const time = elVideo.currentTime;
        for (let index = 0; index < ranges.length; index += 1) {
          if (time >= ranges.start(index) - 0.15 && time <= ranges.end(index) + 0.05) {
            ahead = ranges.end(index) - time;
            break;
          }
        }
        if (ahead < 0.85 || elVideo.seeking || elVideo.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
          log.debug(`resume defer (${reason}) — underrun/seeking`, {
            ahead,
            readyState: elVideo.readyState,
            seeking: elVideo.seeking
          });
          return;
        }
      } catch {
        // ignore
      }
    }

    const now = Date.now();
    if (now - lastResumeAt < 400) {
      return;
    }
    lastResumeAt = now;
    log.debug(`resume (${reason})`, {
      backgrounded: isBackgrounded(),
      hidden: getRealHidden()
    });

    if (onForceResume) {
      onForceResume();
      return;
    }

    if (elVideo instanceof HTMLVideoElement && elVideo.paused && elVideo.src) {
      void elVideo.play().catch(error => {
        log.warn("video.play failed", { error: String(error) });
      });
    }
  }

  function onFocus() {
    resumePlayback("focus");
    window.setTimeout(() => resumePlayback("focus+50"), 50);
    window.setTimeout(() => resumePlayback("focus+250"), 250);
  }

  function onResumeEvent() {
    resumePlayback("document-resume");
  }

  window.addEventListener("focus", onFocus);
  document.addEventListener("resume", onResumeEvent);

  const pollId = window.setInterval(() => {
    if (!wantsPlaying || !isSafeToResume()) {
      return;
    }

    const elVideo = document.querySelector("video");
    if (!(elVideo instanceof HTMLVideoElement)) {
      return;
    }
    if (elVideo.paused && !elVideo.ended) {
      resumePlayback("poll-video-paused");
    }
  }, KEEP_PLAYING_POLL_MS);

  return {
    setWantsPlaying(value) {
      log.debug(`wantsPlaying=${value}`);
      wantsPlaying = value;
      if (value && isSafeToResume()) {
        resumePlayback("setWantsPlaying");
      }
    },
    getWantsPlaying() {
      return wantsPlaying;
    },
    allowPause(run) {
      allowPauseDepth += 1;
      try {
        return run();
      } finally {
        allowPauseDepth -= 1;
      }
    },
    dispose() {
      log.debug("dispose");
      window.clearInterval(pollId);
      HTMLMediaElement.prototype.pause = originalPause;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", blockBubble, true);
      window.removeEventListener("pagehide", blockBubble, true);
      window.removeEventListener("blur", blockBubble, true);
      window.removeEventListener("freeze", blockBubble, true);
      document.removeEventListener("resume", onResumeEvent);

      try {
        if (protoVisibilityState) {
          Object.defineProperty(document, "visibilityState", protoVisibilityState);
        }
        if (protoHidden) {
          Object.defineProperty(document, "hidden", protoHidden);
        }
        document.hasFocus = originalHasFocus;
      } catch {
        // Properties may be non-configurable in some environments
      }
    }
  };
}
