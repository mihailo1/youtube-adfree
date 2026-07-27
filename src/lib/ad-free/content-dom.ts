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

export function getVideoId(): string | null {
  const url = new URL(location.href);
  if (url.pathname !== "/watch") {
    return null;
  }
  return url.searchParams.get("v");
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
