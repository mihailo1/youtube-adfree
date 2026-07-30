export const BUTTON_ID = "ytdl-ad-free-btn";
export const STYLE_ID = "ytdl-ad-free-btn-style";
export const ROOT_ID = "ytdl-ad-free-root";
export const OVERLAY_ID = "ytdl-ad-free-overlay";
export const IFRAME_ID = "ytdl-ad-free-iframe";
export const HOST_ACTIVE_CLASS = "ytdl-ad-free-active";
export const ROOT_ACTIVE_CLASS = "is-active";
export const OBSERVER_DISCONNECT_MS = 30_000;
export const BRIDGE_TIMEOUT_MS = 4_000;

export type YtPlayerEl = HTMLElement & {
  pauseVideo?: () => void;
  playVideo?: () => void;
  play?: () => void;
  stopVideo?: () => void;
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void;
  getCurrentTime?: () => number;
  getPlayerState?: () => number;
  getPlaybackRate?: () => number;
  setPlaybackRate?: (rate: number) => void;
  getVolume?: () => number;
  setVolume?: (volume: number) => void;
  isMuted?: () => boolean;
  mute?: () => void;
  unMute?: () => void;
  loadVideoById?: (...args: unknown[]) => void;
  cueVideoById?: (...args: unknown[]) => void;
};

/** YouTube video id shape (11 chars typical; allow small range for safety). */
const VIDEO_ID_RE = /^[\w-]{6,15}$/;

function normalizeVideoId(raw: string | null | undefined): string | null {
  if (!raw || !VIDEO_ID_RE.test(raw)) {
    return null;
  }
  return raw;
}

/**
 * Extract video id from current page URL.
 * Supports:
 * - /watch?v=ID
 * - /live/ID  (live / premieres often use this — was missing → no Ad-Free button)
 * - /shorts/ID
 * - /embed/ID
 * - /v/ID
 * - youtu.be/ID (if ever on youtube host via redirect)
 */
export function getVideoId(): string | null {
  try {
    const url = new URL(location.href);
    const fromQuery = normalizeVideoId(url.searchParams.get("v"));
    if (fromQuery) {
      return fromQuery;
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";
    // /live/VIDEO_ID, /shorts/VIDEO_ID, /embed/VIDEO_ID, /v/VIDEO_ID
    const pathMatch = path.match(
      /^\/(?:live|shorts|embed|v|e)\/([\w-]{6,15})$/
    );
    if (pathMatch?.[1]) {
      return normalizeVideoId(pathMatch[1]);
    }

    // Rare: /watch/VIDEO_ID
    const watchSlash = path.match(/^\/watch\/([\w-]{6,15})$/);
    if (watchSlash?.[1]) {
      return normalizeVideoId(watchSlash[1]);
    }

    return null;
  } catch {
    return null;
  }
}

/** True when this page is a player watch surface (not home/search). */
export function isPlayerWatchPage(): boolean {
  try {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/watch" || path.startsWith("/watch/")) {
      return true;
    }
    if (/^\/(?:live|shorts|embed|v|e)\//.test(path)) {
      return true;
    }
    return getVideoId() != null;
  } catch {
    return false;
  }
}

export function getPlayerHost(): HTMLElement | null {
  const candidates = [
    document.querySelector<HTMLElement>("#movie_player"),
    document.querySelector<HTMLElement>(".html5-video-player"),
    document.querySelector<HTMLElement>("#ytd-player"),
    document.querySelector<HTMLElement>("#player-container-inner"),
    document.querySelector<HTMLElement>("#player-api")
  ];
  return candidates.find(Boolean) ?? null;
}

export function getYtPlayer(): YtPlayerEl | null {
  const ytElement: YtPlayerEl | null = document.getElementById("movie_player") as YtPlayerEl | null;
  return ytElement;
}

export function getYtVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("#movie_player video.html5-main-video")
    ?? document.querySelector<HTMLVideoElement>("#movie_player video")
    ?? document.querySelector<HTMLVideoElement>(".html5-video-player video");
}

export function getIframe(): HTMLIFrameElement | null {
  const iframeElement: HTMLIFrameElement | null = document.getElementById(IFRAME_ID) as HTMLIFrameElement | null;
  return iframeElement;
}

export function getRoot(): HTMLElement | null {
  return document.getElementById(ROOT_ID);
}
