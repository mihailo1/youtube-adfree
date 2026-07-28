import { registerAdFreeHandlers } from "./handlers/ad-free-handlers";
import { registerChunkHandlers } from "./handlers/chunk-handlers";
import { registerDownloadHandlers } from "./handlers/download-handlers";
import { registerPipelineHandlers } from "./handlers/pipeline-handlers";
import { ensureProcessor } from "./handlers/processor";
import { registerSessionLogHandlers } from "./handlers/session-log-handlers";
import { registerStorageHandlers } from "./handlers/storage-handlers";
import { registerTabLifecycleHandlers } from "./handlers/tab-lifecycle";
import { registerRecentDownloadsRetention } from "./recent/recent-downloads";
import { trackInstall, registerDailyHeartbeat, setUninstallUrl } from "@/lib/analytics/ga4";
import { MessageType, sendMessageToTab } from "@/lib/messaging/messaging";
import { initOffscreenPortListener } from "@/lib/messaging/offscreen-messaging";
import {
  clearLocalStorage,
  musicListItem,
  statusProgressItem,
  videoDetailsItem,
  videoOnlyListItem,
  videoQueueItem
} from "@/lib/storage/storage";
import { registerUpdateCheck } from "@/lib/updates/update-check";
import { onSabrBodyCaptured, startSabrRequestCapture } from "@/lib/youtube/sabr/request-capture";

/**
 * chrome.storage.session is TRUSTED_CONTEXTS-only by default, so content scripts
 * throw "Access to storage is not allowed from this context" on get/set.
 * Ad-free watch + player share the stream payload via session storage.
 */
async function allowSessionStorageForContentScripts() {
  try {
    const session = browser.storage.session as typeof browser.storage.session & {
      setAccessLevel?: (accessLevel: { accessLevel: string }) => Promise<void>;
    };
    if (typeof session.setAccessLevel !== "function") {
      return;
    }
    await session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS"
    });
  } catch {
    // Older browsers / Firefox without session access levels — ignore
  }
}

export default defineBackground(() => {
  void allowSessionStorageForContentScripts();

  initOffscreenPortListener();
  startSabrRequestCapture();
  onSabrBodyCaptured(tabId => {
    // Best-effort push; the content script also pulls via GetCapturedSabrBody with
    // retry, so a missing receiver mid-reload is expected and must not crash the SW
    sendMessageToTab(MessageType.SabrBodyReady, undefined, tabId).catch(() => {});
  });

  registerSessionLogHandlers();
  registerAdFreeHandlers();
  registerChunkHandlers();
  registerDownloadHandlers();
  registerPipelineHandlers();
  registerRecentDownloadsRetention();
  registerStorageHandlers();
  registerTabLifecycleHandlers();

  registerDailyHeartbeat();
  registerUpdateCheck();

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    // Re-apply after update/reload of the extension
    await allowSessionStorageForContentScripts();
    if (reason !== browser.runtime.OnInstalledReason.INSTALL) {
      return;
    }

    await clearLocalStorage();
    await trackInstall();
  });

  void Promise.all([
    statusProgressItem.setValue({}),
    videoQueueItem.setValue([]),
    musicListItem.setValue([]),
    videoOnlyListItem.setValue([]),
    videoDetailsItem.setValue({})
  ]);
  ensureProcessor().catch(() => {});
  void setUninstallUrl();
});
