export const AD_FREE_BRIDGE_TYPE = "ytdl-ad-free-bridge" as const;

export type AdFreePlaybackSnapshot = {
  videoId: string;
  currentTime: number;
  wasPlaying: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
};

export type AdFreeBridgeToPlayer =
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    action: "ping";
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    action: "get-state";
    requestId: string;
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    action: "set-state";
    requestId?: string;
    snapshot: AdFreePlaybackSnapshot;
    /** Always pause after applying time (player switch). */
    forcePause: boolean;
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    action: "pause";
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    /** Late chapters after SPA/Always Ad-Free (page markers hydrate after enable). */
    action: "set-chapters";
    videoId: string;
    chapters: Array<{ startSeconds: number; endSeconds: number; title: string }>;
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    /** Parent → player: YouTube theater/wide layout state. */
    action: "theater-state";
    theater: boolean;
  };

export type AdFreeBridgeFromPlayer =
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    action: "ready";
    videoId: string;
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    action: "state";
    requestId: string;
    snapshot: AdFreePlaybackSnapshot;
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    action: "set-state-done";
    requestId?: string;
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    action: "pong";
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    /** Vidstack controls visibility — hide top chrome (Ad-Free chip) in lockstep. */
    action: "controls-visible";
    visible: boolean;
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    /** Player → parent: toggle YouTube theater (wide) mode. */
    action: "toggle-theater";
  }
  | {
    type: typeof AD_FREE_BRIDGE_TYPE;
    /** Player → parent: ask current theater state. */
    action: "get-theater";
  };

export function isBridgeMessage(data: unknown): data is AdFreeBridgeToPlayer | AdFreeBridgeFromPlayer {
  return Boolean(
    data
    && typeof data === "object"
    && (data as { type?: string }).type === AD_FREE_BRIDGE_TYPE
    && typeof (data as { action?: string }).action === "string"
  );
}

export function isValidSnapshot(value: unknown): value is AdFreePlaybackSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snap = value as Record<string, unknown>;
  return typeof snap.videoId === "string"
    && typeof snap.currentTime === "number"
    && Number.isFinite(snap.currentTime)
    && typeof snap.wasPlaying === "boolean"
    && typeof snap.playbackRate === "number"
    && typeof snap.volume === "number"
    && typeof snap.muted === "boolean";
}
