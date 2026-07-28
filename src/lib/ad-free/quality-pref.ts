/**
 * Remember last Ad-Free playback quality (height + progressive vs adaptive).
 * Stored in extension local storage — survives reloads (unlike session payload).
 */

import type { AdFreeQualityOption } from "@/lib/ad-free/resolve-stream";

const STORAGE_KEY = "local:adFreeQualityPref";

export type AdFreeQualityPref = {
  /** Preferred vertical resolution (e.g. 1080). */
  height: number;
  /** When true, prefer progressive muxed; else prefer adaptive/MSE at that height. */
  preferProgressive: boolean;
  updatedAt: number;
};

const prefItem = storage.defineItem<AdFreeQualityPref | null>(STORAGE_KEY, {
  fallback: null
});

export async function getAdFreeQualityPref(): Promise<AdFreeQualityPref | null> {
  try {
    const value = await prefItem.getValue();
    if (!value || typeof value.height !== "number" || value.height <= 0) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function setAdFreeQualityPref(
  quality: Pick<AdFreeQualityOption, "height" | "isProgressive">
): Promise<void> {
  const height = quality.height > 0 ? quality.height : 0;
  if (height <= 0) {
    return;
  }
  try {
    await prefItem.setValue({
      height,
      preferProgressive: quality.isProgressive,
      updatedAt: Date.now()
    });
  } catch {
    // ignore storage failures
  }
}

/**
 * Pick the closest matching quality from the menu list for a saved preference.
 * Returns null when no pref or empty list (caller uses pickDefaultQuality).
 */
export function pickQualityFromPreference(
  qualities: AdFreeQualityOption[],
  pref: AdFreeQualityPref | null
): AdFreeQualityOption | null {
  if (!pref || qualities.length === 0) {
    return null;
  }

  const exactType = qualities.find(
    item => item.height === pref.height && item.isProgressive === pref.preferProgressive
  );
  if (exactType) {
    return exactType;
  }

  const sameHeight = qualities.find(item => item.height === pref.height);
  if (sameHeight) {
    return sameHeight;
  }

  const sorted = [...qualities].sort((left, right) => {
    const distLeft = Math.abs((left.height ?? 0) - pref.height);
    const distRight = Math.abs((right.height ?? 0) - pref.height);
    if (distLeft !== distRight) {
      return distLeft - distRight;
    }
    // Prefer matching progressive flag at equal distance
    if (left.isProgressive !== right.isProgressive) {
      if (pref.preferProgressive) {
        return left.isProgressive ? -1 : 1;
      }
      return left.isProgressive ? 1 : -1;
    }
    return (right.height ?? 0) - (left.height ?? 0);
  });

  return sorted[0] ?? null;
}
