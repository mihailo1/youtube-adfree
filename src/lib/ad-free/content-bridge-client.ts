import {
  AD_FREE_BRIDGE_TYPE,
  type AdFreeBridgeFromPlayer,
  type AdFreeBridgeToPlayer,
  type AdFreePlaybackSnapshot,
  isBridgeMessage,
  isValidSnapshot
} from "@/lib/ad-free/bridge";
import { BRIDGE_TIMEOUT_MS, getIframe } from "@/lib/ad-free/content-dom";

export function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function postToPlayer(message: AdFreeBridgeToPlayer) {
  getIframe()?.contentWindow?.postMessage(message, "*");
}

export function waitForBridgeMessage<T extends AdFreeBridgeFromPlayer>(
  predicate: (message: AdFreeBridgeFromPlayer) => message is T,
  timeoutMs = BRIDGE_TIMEOUT_MS
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Ad-Free player bridge timeout"));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.source !== getIframe()?.contentWindow) {
        return;
      }
      if (!isBridgeMessage(event.data)) {
        return;
      }
      const message: AdFreeBridgeFromPlayer = event.data as AdFreeBridgeFromPlayer;
      if (!predicate(message)) {
        return;
      }
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(message);
    }

    window.addEventListener("message", onMessage);
  });
}

export async function requestPlayerSnapshot(
  videoId: string,
  lastSnapshot: AdFreePlaybackSnapshot | null
): Promise<AdFreePlaybackSnapshot | null> {
  const elIframe = getIframe();
  if (!elIframe?.contentWindow) {
    return lastSnapshot?.videoId === videoId ? lastSnapshot : null;
  }

  const requestId = createRequestId();
  try {
    postToPlayer({
      type: AD_FREE_BRIDGE_TYPE,
      action: "get-state",
      requestId
    });

    const response = await waitForBridgeMessage(
      (message): message is Extract<AdFreeBridgeFromPlayer, { action: "state" }> =>
        message.action === "state"
        && message.requestId === requestId
        && isValidSnapshot(message.snapshot),
      BRIDGE_TIMEOUT_MS
    );

    return response.snapshot;
  } catch {
    return lastSnapshot?.videoId === videoId ? lastSnapshot : null;
  }
}

export async function pushSnapshotToPlayer(
  snapshot: AdFreePlaybackSnapshot,
  forcePause: boolean
): Promise<void> {
  if (!getIframe()?.contentWindow) {
    return;
  }

  const requestId = createRequestId();
  postToPlayer({
    type: AD_FREE_BRIDGE_TYPE,
    action: "set-state",
    requestId,
    snapshot,
    forcePause
  });

  try {
    await waitForBridgeMessage(
      (message): message is Extract<AdFreeBridgeFromPlayer, { action: "set-state-done" }> =>
        message.action === "set-state-done"
        && (!message.requestId || message.requestId === requestId),
      2_500
    );
  } catch {
    // ignore
  }
}
