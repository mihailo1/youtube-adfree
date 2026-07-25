const KEEP_PLAYING_POLL_MS = 1200;

export type KeepPlayingController = {
  /** User wants media to keep playing (survives window blur / tab backgrounding). */
  setWantsPlaying: (value: boolean) => void;
  getWantsPlaying: () => boolean;
  /** Allow the next pause() calls (player switch or intentional user pause). */
  allowPause: <T>(run: () => T) => T;
  dispose: () => void;
};

type PlayableElement = HTMLElement & {
  paused?: boolean;
  play?: () => Promise<void>;
};

/**
 * Keep playback running when the OS/browser window loses focus.
 * Visibility spoof alone is not enough - Chrome still pauses media; we re-assert play.
 */
export function installKeepPlaying(): KeepPlayingController {
  let wantsPlaying = false;
  let allowPauseDepth = 0;

  const protoHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
  const protoHasFocus = Document.prototype.hasFocus;

  const getRealHidden = () => {
    try {
      return Boolean(protoHidden?.get?.call(document));
    } catch {
      return false;
    }
  };

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
  } catch {
    // Properties may already be non-configurable
  }

  const blockBubble = (event: Event) => {
    event.stopImmediatePropagation();
  };
  document.addEventListener("visibilitychange", blockBubble, true);
  window.addEventListener("pagehide", blockBubble, true);
  window.addEventListener("blur", blockBubble, true);
  window.addEventListener("freeze", blockBubble, true);

  const isBackgrounded = () => {
    try {
      return getRealHidden() || !protoHasFocus.call(document);
    } catch {
      return false;
    }
  };

  const originalPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function patchedPause(this: HTMLMediaElement) {
    if (wantsPlaying && allowPauseDepth === 0 && isBackgrounded()) {
      return;
    }
    return originalPause.call(this);
  };

  const resumeAll = () => {
    if (!wantsPlaying) {
      return;
    }

    for (const el of document.querySelectorAll("video, audio")) {
      const media = el as HTMLMediaElement;
      if (media.paused && media.src) {
        void media.play().catch(() => {});
      }
    }

    const elPlayer = document.querySelector("media-player") as PlayableElement | null;
    if (elPlayer?.paused) {
      void elPlayer.play?.().catch(() => {});
    }
  };

  const onFocus = () => {
    if (!wantsPlaying) {
      return;
    }
    resumeAll();
    window.setTimeout(resumeAll, 50);
    window.setTimeout(resumeAll, 250);
  };

  window.addEventListener("focus", onFocus);
  document.addEventListener("resume", onFocus as EventListener);

  const pollId = window.setInterval(() => {
    if (!wantsPlaying) {
      return;
    }

    const elVideo = document.querySelector("video");
    const elAudio = document.querySelector("audio");
    if (elVideo?.paused || elAudio?.paused) {
      resumeAll();
    }
  }, KEEP_PLAYING_POLL_MS);

  return {
    setWantsPlaying(value) {
      wantsPlaying = value;
      if (value) {
        resumeAll();
      }
    },
    getWantsPlaying: () => wantsPlaying,
    allowPause(run) {
      allowPauseDepth += 1;
      try {
        return run();
      } finally {
        allowPauseDepth -= 1;
      }
    },
    dispose() {
      window.clearInterval(pollId);
      HTMLMediaElement.prototype.pause = originalPause;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", blockBubble, true);
      window.removeEventListener("pagehide", blockBubble, true);
      window.removeEventListener("blur", blockBubble, true);
      window.removeEventListener("freeze", blockBubble, true);
    }
  };
}
