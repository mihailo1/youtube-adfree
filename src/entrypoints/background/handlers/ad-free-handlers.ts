import { createPageProxyFetch } from "../download/page-proxy-fetch";
import { AD_FREE_VISITOR_DATA_KEY } from "@/lib/ad-free/constants";
import {
  type AdFreeStreamPayload,
  adFreeStreamStorageKey,
  resolveAdFreeStreamFromPlayerApi
} from "@/lib/ad-free/resolve-stream";
import { MessageType, onMessage } from "@/lib/messaging/messaging";

const RECEIVING_END_HINT =
  "Content script not loaded on YouTube tab. Open https://www.youtube.com/watch?v=… and hard-refresh (Cmd+Shift+R) after reloading the extension.";

function isReceivingEndMissing(message: string): boolean {
  return message.includes("Receiving end does not exist")
    || message.includes("Could not establish connection");
}

/** Ordered YouTube tab ids: preferred → active → rest (www only; matches content_scripts). */
async function listYouTubeTabIds(preferredTabId?: number): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<number>();

  function pushId(tabId: number | undefined) {
    if (tabId == null || seen.has(tabId)) {
      return;
    }
    seen.add(tabId);
    ids.push(tabId);
  }

  if (preferredTabId != null && preferredTabId >= 0) {
    try {
      const tab = await browser.tabs.get(preferredTabId);
      if (tab.url?.includes("youtube.com")) {
        pushId(preferredTabId);
      }
    } catch {
      // tab may be gone
    }
  }

  // Content scripts match only https://www.youtube.com/*
  const tabs = await browser.tabs.query({ url: ["*://www.youtube.com/*"] });
  const active = tabs.find(tab => tab.active && tab.id != null);
  pushId(active?.id);
  for (const tab of tabs) {
    pushId(tab.id);
  }

  return ids;
}

async function getStoredVisitorData(): Promise<string | undefined> {
  const result = await browser.storage.local.get(AD_FREE_VISITOR_DATA_KEY);
  const value = result[AD_FREE_VISITOR_DATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sleep(ms: number) {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

async function resolveAdFreeStream(
  videoId: string,
  preferredTabId?: number
): Promise<AdFreeStreamPayload> {
  const errors: string[] = [];
  // Content scripts may still be injecting when Ad-Free runs at document_start
  const rounds = 4;

  for (let round = 0; round < rounds; round += 1) {
    if (round > 0) {
      await sleep(300 * round);
    }
    const youtubeTabIds = await listYouTubeTabIds(preferredTabId);
    errors.length = 0;

    // 1) Prefer page-proxy: real cookies + ytcfg.VISITOR_DATA substitution (avoids 403).
    if (youtubeTabIds.length === 0) {
      errors.push("page-proxy: no www.youtube.com tab open");
    } else {
      let anyReceivingEndMissing = false;
      for (const tabId of youtubeTabIds) {
        try {
          const pageProxyFetch = createPageProxyFetch(tabId);
          return await resolveAdFreeStreamFromPlayerApi({
            videoId,
            customFetch: pageProxyFetch
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isReceivingEndMissing(message)) {
            anyReceivingEndMissing = true;
            errors.push(`page-proxy tab ${tabId}: no content script`);
            continue;
          }
          // 403 often means proxy not ready or visitor token not yet in page
          if (/403/.test(message) && round < rounds - 1) {
            errors.push(`page-proxy tab ${tabId}: ${message} (retry)`);
            continue;
          }
          errors.push(`page-proxy tab ${tabId}: ${message}`);
        }
      }
      if (anyReceivingEndMissing && round < rounds - 1) {
        continue;
      }
      if (anyReceivingEndMissing) {
        errors.push(RECEIVING_END_HINT);
      }
    }
  }

  // 2) Direct BG fetch with stored visitorData (often still 403 on Chrome)
  const visitorData = await getStoredVisitorData();
  try {
    return await resolveAdFreeStreamFromPlayerApi({
      videoId,
      visitorData
    });
  } catch (error) {
    errors.push(`background: ${error instanceof Error ? error.message : String(error)}`);
  }

  throw new Error(
    `Could not resolve stream. Keep a refreshed YouTube watch tab open and try again. (${errors.join(" | ")})`
  );
}

async function storeStreamPayload(payload: AdFreeStreamPayload) {
  const key = adFreeStreamStorageKey(payload.videoId);
  await browser.storage.session.set({ [key]: payload });
}

export function registerAdFreeHandlers() {
  onMessage(MessageType.ResolveAdFreeStream, async ({ data, sender }) => {
    const payload = await resolveAdFreeStream(data.videoId, sender.tab?.id);
    await storeStreamPayload(payload);
    return payload;
  });

  // Resolve + store only; the content script mounts the in-page player overlay.
  onMessage(MessageType.OpenAdFreePlayer, async ({ data, sender }) => {
    const payload = await resolveAdFreeStream(data.videoId, sender.tab?.id);
    await storeStreamPayload(payload);
  });

  // Content scripts cannot always write chrome.storage.session directly
  // (needs setAccessLevel). Prefer this path for page-side merges.
  onMessage(MessageType.StoreAdFreeStreamPayload, async ({ data }) => {
    await storeStreamPayload(data.payload);
  });
}
