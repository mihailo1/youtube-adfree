/** Parse YouTube t= / start= query (90, 1m30s, 1h2m3s). */
export function parseYoutubeTimeToSeconds(raw: string | null | undefined): number {
  if (!raw) {
    return 0;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return 0;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  const match = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!match) {
    return 0;
  }
  const total = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/** Read t= or start= from the current page URL. */
export function readTimeFromLocation(): number {
  try {
    const params = new URLSearchParams(location.search);
    return parseYoutubeTimeToSeconds(params.get("t"))
      || parseYoutubeTimeToSeconds(params.get("start"));
  } catch {
    return 0;
  }
}

/** Read t= or start= from a URLSearchParams (player iframe query). */
export function readInitialTime(params: URLSearchParams): number {
  return parseYoutubeTimeToSeconds(params.get("t"))
    || parseYoutubeTimeToSeconds(params.get("start"));
}
