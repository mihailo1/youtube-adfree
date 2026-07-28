/**
 * Ad-Free "use by default on watch pages" preference.
 * Stored in extension options (`isAdFreeDefault`), default false.
 *
 * Also mirrored to `localStorage.ytdlAfDefault` so content script can cover
 * the player at document_start before storage.async resolves (kills flash of YT).
 */

import { optionsItem, setOption } from "@/lib/storage/storage";

/** Sync mirror for early boot (document_start). */
export const AD_FREE_DEFAULT_LS_KEY = "ytdlAfDefault";

export function readAdFreeDefaultFromLocalCache(): boolean {
  try {
    const value = globalThis.localStorage?.getItem(AD_FREE_DEFAULT_LS_KEY);
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}

export function writeAdFreeDefaultLocalCache(enabled: boolean) {
  try {
    if (enabled) {
      globalThis.localStorage?.setItem(AD_FREE_DEFAULT_LS_KEY, "1");
    } else {
      globalThis.localStorage?.removeItem(AD_FREE_DEFAULT_LS_KEY);
    }
  } catch {
    // ignore
  }
}

export async function getAdFreeDefaultEnabled(): Promise<boolean> {
  try {
    const options = await optionsItem.getValue();
    const enabled = options.isAdFreeDefault === true;
    // Keep page localStorage in sync for next navigation's document_start
    writeAdFreeDefaultLocalCache(enabled);
    return enabled;
  } catch {
    return readAdFreeDefaultFromLocalCache();
  }
}

export async function setAdFreeDefaultEnabled(enabled: boolean): Promise<void> {
  writeAdFreeDefaultLocalCache(enabled);
  await setOption({
    key: "isAdFreeDefault",
    value: enabled
  });
}

/** Subscribe to option changes (content script / popup / player). */
export function watchAdFreeDefaultEnabled(
  onChange: (enabled: boolean) => void
): () => void {
  return optionsItem.watch(value => {
    const enabled = value.isAdFreeDefault === true;
    writeAdFreeDefaultLocalCache(enabled);
    onChange(enabled);
  });
}
