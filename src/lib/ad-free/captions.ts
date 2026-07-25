import type { AndroidCaptionTrack, AndroidPlayerResponse } from "@/lib/youtube/android-player";
import type { Prettify } from "@/types";

export type AdFreeCaptionTrack = Prettify<{
  id: string;
  label: string;
  languageCode: string;
  /** WebVTT URL suitable for <track src>. */
  src: string;
  kind: "subtitles" | "captions";
}>;

export function toVttCaptionUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "vtt");
    return url.href;
  } catch {
    if (/[?&]fmt=/.test(baseUrl)) {
      return baseUrl;
    }
    return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=vtt`;
  }
}

function mapCaptionTrack(track: AndroidCaptionTrack, index: number): AdFreeCaptionTrack | null {
  if (!track.baseUrl) {
    return null;
  }

  const languageCode = track.languageCode || `und-${index}`;
  const label = track.name?.simpleText || languageCode;
  const isAsr = track.kind === "asr";
  return {
    id: track.vssId || `${languageCode}-${index}`,
    label: isAsr ? `${label} (auto)` : label,
    languageCode,
    src: toVttCaptionUrl(track.baseUrl),
    kind: isAsr ? "captions" : "subtitles"
  };
}

export function extractCaptionsFromPlayerResponse(
  response: AndroidPlayerResponse | null | undefined
): AdFreeCaptionTrack[] {
  const raw = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const tracks: AdFreeCaptionTrack[] = [];
  for (const [index, track] of raw.entries()) {
    const mapped = mapCaptionTrack(track, index);
    if (mapped) {
      tracks.push(mapped);
    }
  }
  return tracks;
}

const PLAYER_RESPONSE_PATTERNS = [
  /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s,
  /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s
] as const;

/** Parse caption tracks from page HTML / script text (isolated content script safe). */
export function extractCaptionsFromHtml(html: string): AdFreeCaptionTrack[] {
  for (const pattern of PLAYER_RESPONSE_PATTERNS) {
    const match = html.match(pattern);
    const jsonText = match?.[1];
    if (!jsonText) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonText) as AndroidPlayerResponse;
      const tracks = extractCaptionsFromPlayerResponse(parsed);
      if (tracks.length > 0) {
        return tracks;
      }
    } catch {
      // try next pattern
    }
  }
  return [];
}

export function extractCaptionsFromDocument(doc: Document = document): AdFreeCaptionTrack[] {
  const scripts = doc.querySelectorAll("script");
  for (const elScript of scripts) {
    const text = elScript.textContent;
    if (!text || !text.includes("captionTracks")) {
      continue;
    }
    const tracks = extractCaptionsFromHtml(text);
    if (tracks.length > 0) {
      return tracks;
    }
  }
  return extractCaptionsFromHtml(doc.documentElement?.innerHTML ?? "");
}

export function isAdFreeCaptionTrack(value: unknown): value is AdFreeCaptionTrack {
  if (!value || typeof value !== "object") {
    return false;
  }
  const track = value as Record<string, unknown>;
  return typeof track.id === "string"
    && typeof track.label === "string"
    && typeof track.languageCode === "string"
    && typeof track.src === "string"
    && (track.kind === "subtitles" || track.kind === "captions");
}
