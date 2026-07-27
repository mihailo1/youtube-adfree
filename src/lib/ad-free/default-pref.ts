/**
 * Ad-Free "use by default on watch pages" preference.
 * Stored in extension options (`isAdFreeDefault`), default false.
 */

import { optionsItem, setOption } from "@/lib/storage/storage";

export async function getAdFreeDefaultEnabled(): Promise<boolean> {
  try {
    const options = await optionsItem.getValue();
    return options.isAdFreeDefault === true;
  } catch {
    return false;
  }
}

export async function setAdFreeDefaultEnabled(enabled: boolean): Promise<void> {
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
    onChange(value.isAdFreeDefault === true);
  });
}
