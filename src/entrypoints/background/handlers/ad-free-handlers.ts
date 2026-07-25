import { createPageProxyFetch } from "../download/page-proxy-fetch";
import { fetchChannelVideosWithGl } from "@/lib/ad-free/channel-region-list";
import { AD_FREE_VISITOR_DATA_KEY } from "@/lib/ad-free/constants";
import {
  type AdFreeStreamPayload,
  adFreeStreamStorageKey,
  resolveAdFreeStreamFromPlayerApi
} from "@/lib/ad-free/resolve-stream";
import { MessageType, onMessage } from "@/lib/messaging/messaging";

async function findYouTubeTabId(preferredTabId?: number): Promise<number | null> {
  if (preferredTabId != null && preferredTabId >= 0) {
    try {
      const tab = await browser.tabs.get(preferredTabId);
      if (tab.url?.includes("youtube.com")) {
        return preferredTabId;
      }
    } catch {
      // tab may be gone
    }
  }

  const tabs = await browser.tabs.query({ url: ["*://www.youtube.com/*", "*://youtube.com/*"] });
  const active = tabs.find(tab => tab.active && tab.id != null);
  if (active?.id != null) {
    return active.id;
  }

  const first = tabs.find(tab => tab.id != null);
  return first?.id ?? null;
}

async function getStoredVisitorData(): Promise<string | undefined> {
  const result = await browser.storage.local.get(AD_FREE_VISITOR_DATA_KEY);
  const value = result[AD_FREE_VISITOR_DATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function resolveAdFreeStream(
  videoId: string,
  preferredTabId?: number
): Promise<AdFreeStreamPayload> {
  const youtubeTabId = await findYouTubeTabId(preferredTabId);
  const errors: string[] = [];

  // 1) Prefer page-proxy: real cookies + ytcfg.VISITOR_DATA substitution (avoids 403)
  if (youtubeTabId != null) {
    try {
      const pageProxyFetch = createPageProxyFetch(youtubeTabId);
      return await resolveAdFreeStreamFromPlayerApi({
        videoId,
        customFetch: pageProxyFetch
      });
    } catch (error) {
      errors.push(`page-proxy: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    errors.push("page-proxy: no YouTube tab open");
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
    `Could not resolve stream. Keep a YouTube watch tab open and try again. (${errors.join(" | ")})`
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

  onMessage(MessageType.ResolveChannelRegionList, async ({ data, sender }) => {
    const youtubeTabId = await findYouTubeTabId(sender.tab?.id);
    const gl = data.gl ?? "US";
    const errors: string[] = [];

    if (youtubeTabId != null) {
      try {
        const pageProxyFetch = createPageProxyFetch(youtubeTabId);
        return await fetchChannelVideosWithGl({
          channelId: data.channelId,
          gl,
          customFetch: pageProxyFetch
        });
      } catch (error) {
        errors.push(`page-proxy: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      errors.push("page-proxy: no YouTube tab open");
    }

    try {
      return await fetchChannelVideosWithGl({
        channelId: data.channelId,
        gl
      });
    } catch (error) {
      errors.push(`background: ${error instanceof Error ? error.message : String(error)}`);
    }

    throw new Error(`Could not load channel list (${errors.join(" | ")})`);
  });
}
