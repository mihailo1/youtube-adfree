import {
  type AdFreeCaptionTrack,
  extractCaptionsFromPlayerResponse,
  isAdFreeCaptionTrack
} from "@/lib/ad-free/captions";
import {
  type AdFreeChapter,
  extractChaptersFromSource,
  isAdFreeChapter
} from "@/lib/ad-free/chapters";
import { AD_FREE_STREAM_KEY_PREFIX } from "@/lib/ad-free/constants";
import { extractStoryboardSpec } from "@/lib/ad-free/storyboard";
import {
  type AndroidPlayerResponse,
  type AndroidStreamingFormat,
  fetchAndroidPlayerResponse
} from "@/lib/youtube/android-player";
import type { Prettify } from "@/types";

export type { AdFreeCaptionTrack } from "@/lib/ad-free/captions";
export type { AdFreeChapter } from "@/lib/ad-free/chapters";

const ITAG_PROGRESSIVE_HD = 22;
const ITAG_PROGRESSIVE_SD = 18;

export type AdFreeQualityOption = Prettify<{
  id: string;
  label: string;
  height: number;
  width?: number;
  fps?: number;
  itag: number;
  videoUrl: string;
  /** Null for progressive (audio is muxed into videoUrl). */
  audioUrl: string | null;
  isProgressive: boolean;
  mimeType: string;
  bitrate?: number;
}>;

export type AdFreeStreamPayload = Prettify<{
  videoId: string;
  title: string;
  author: string;
  /** Wall-clock length from ANDROID_VR videoDetails (0 if unknown). */
  durationSeconds: number;
  /** @deprecated kept for older session payloads */
  progressiveUrl: string | null;
  /** @deprecated kept for older session payloads */
  videoUrl: string | null;
  audioUrl: string | null;
  qualityLabel: string;
  qualities: AdFreeQualityOption[];
  selectedQualityId: string;
  captions: AdFreeCaptionTrack[];
  /**
   * Raw YouTube storyboard spec (`playerStoryboardSpecRenderer.spec`).
   * Expanded to sprite frames in the player (see `storyboard.ts`).
   */
  storyboardSpec: string | null;
  /**
   * Video chapters (markersMap / engagementPanels). Empty when the video has none
   * or ANDROID_VR omitted them (watch page may merge later).
   */
  chapters: AdFreeChapter[];
  resolvedAt: number;
}>;

export function adFreeStreamStorageKey(videoId: string) {
  return `${AD_FREE_STREAM_KEY_PREFIX}${videoId}`;
}

export function deriveSelectedFields(selected: AdFreeQualityOption) {
  return {
    progressiveUrl: selected.isProgressive ? selected.videoUrl : null,
    videoUrl: selected.isProgressive ? null : selected.videoUrl,
    audioUrl: selected.audioUrl,
    qualityLabel: selected.label,
    selectedQualityId: selected.id
  };
}

function hasUrl(format: AndroidStreamingFormat): format is AndroidStreamingFormat & { url: string } {
  return typeof format.url === "string" && format.url.length > 0;
}

function pickAdaptiveAudio(response: AndroidPlayerResponse): (AndroidStreamingFormat & { url: string }) | null {
  const formats = (response.streamingData?.adaptiveFormats ?? [])
    .filter(hasUrl)
    .filter(f => f.mimeType.startsWith("audio/"));
  if (formats.length === 0) {
    return null;
  }

  // Prefer m4a/mp4 audio for max browser compatibility, then highest bitrate.
  formats.sort((a, b) => {
    const aIsMp4 = a.mimeType.includes("mp4") ? 1 : 0;
    const bIsMp4 = b.mimeType.includes("mp4") ? 1 : 0;
    if (aIsMp4 !== bIsMp4) {
      return bIsMp4 - aIsMp4;
    }
    return (b.bitrate ?? 0) - (a.bitrate ?? 0);
  });
  return formats[0];
}

function codecScore(mimeType: string) {
  // Prefer avc1/mp4 over vp9/webm for broader playback reliability in <video>.
  if (mimeType.includes("avc1") || mimeType.includes("mp4")) {
    return 2;
  }
  if (mimeType.includes("vp9") || mimeType.includes("webm")) {
    return 1;
  }
  return 0;
}

function shouldPreferVideo(
  candidate: AndroidStreamingFormat & { url: string },
  current: AndroidStreamingFormat & { url: string }
) {
  const codecDelta = codecScore(candidate.mimeType) - codecScore(current.mimeType);
  if (codecDelta !== 0) {
    return codecDelta > 0;
  }
  return (candidate.bitrate ?? 0) > (current.bitrate ?? 0);
}

function qualityKey(format: AndroidStreamingFormat) {
  const height = format.height ?? 0;
  const fps = format.fps ?? 0;
  return `${height}@${fps}`;
}

function labelForFormat(format: AndroidStreamingFormat) {
  if (format.qualityLabel) {
    return format.qualityLabel;
  }
  const height = format.height ?? 0;
  const fps = format.fps;
  if (fps && fps > 30) {
    return `${height}p${fps}`;
  }
  return `${height}p`;
}

function collectAdaptiveQualities(
  response: AndroidPlayerResponse,
  audioUrl: string | null
): AdFreeQualityOption[] {
  const videos = (response.streamingData?.adaptiveFormats ?? [])
    .filter(hasUrl)
    .filter(f => f.mimeType.startsWith("video/") && (f.height ?? 0) > 0);

  const bestByKey = new Map<string, AndroidStreamingFormat & { url: string }>();
  for (const format of videos) {
    const key = qualityKey(format);
    const existing = bestByKey.get(key);
    if (!existing || shouldPreferVideo(format, existing)) {
      bestByKey.set(key, format);
    }
  }

  return [...bestByKey.values()]
    .sort((a, b) => {
      const heightDelta = (b.height ?? 0) - (a.height ?? 0);
      if (heightDelta !== 0) {
        return heightDelta;
      }
      return (b.fps ?? 0) - (a.fps ?? 0);
    })
    .map(format => ({
      id: `a-${format.itag}`,
      label: labelForFormat(format),
      height: format.height ?? 0,
      width: format.width,
      fps: format.fps,
      itag: format.itag,
      videoUrl: format.url,
      audioUrl,
      isProgressive: false,
      mimeType: format.mimeType,
      bitrate: format.bitrate
    }));
}

function collectProgressiveQualities(response: AndroidPlayerResponse): AdFreeQualityOption[] {
  const progressive = (response.streamingData?.formats ?? [])
    .filter(hasUrl)
    .filter(f => f.mimeType.startsWith("video/"));

  // Stable priority for common progressive itags, then the rest by height.
  progressive.sort((a, b) => {
    const rank = (itag: number) => {
      if (itag === ITAG_PROGRESSIVE_HD) {return 2;}
      if (itag === ITAG_PROGRESSIVE_SD) {return 1;}
      return 0;
    };
    const rankDelta = rank(b.itag) - rank(a.itag);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return (b.height ?? 0) - (a.height ?? 0);
  });

  const seenHeights = new Set<number>();
  const options: AdFreeQualityOption[] = [];
  for (const format of progressive) {
    const height = format.height ?? (format.itag === ITAG_PROGRESSIVE_HD ? 720 : format.itag === ITAG_PROGRESSIVE_SD ? 360 : 0);
    if (height > 0 && seenHeights.has(height)) {
      continue;
    }
    if (height > 0) {
      seenHeights.add(height);
    }
    options.push({
      id: `p-${format.itag}`,
      label: `${labelForFormat({
        ...format,
        height: height || format.height
      })} · muxed`,
      height,
      width: format.width,
      fps: format.fps,
      itag: format.itag,
      videoUrl: format.url,
      audioUrl: null,
      isProgressive: true,
      mimeType: format.mimeType,
      bitrate: format.bitrate
    });
  }
  return options;
}

export function buildAdFreeStreamPayload(
  videoId: string,
  response: AndroidPlayerResponse
): AdFreeStreamPayload {
  const status = response.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason = response.playabilityStatus?.reason ?? status;
    throw new Error(`YouTube rejected playback: ${reason}`);
  }

  const title = response.videoDetails?.title ?? "Unknown title";
  const author = response.videoDetails?.author ?? "Unknown author";
  const lengthRaw = response.videoDetails?.lengthSeconds;
  const durationSeconds = lengthRaw != null && Number.isFinite(Number(lengthRaw))
    ? Math.max(0, Number(lengthRaw))
    : 0;
  const adaptiveAudio = pickAdaptiveAudio(response);
  const audioUrl = adaptiveAudio?.url ?? null;

  const progressiveQualities = collectProgressiveQualities(response);
  const adaptiveQualities = collectAdaptiveQualities(response, audioUrl);
  // Progressive (muxed) first for stable default seek; adaptive for higher res.
  const qualities = [...progressiveQualities, ...adaptiveQualities];

  if (qualities.length === 0) {
    throw new Error("No streamable formats found in the ANDROID_VR response");
  }

  // Default: best progressive, else highest adaptive
  const selected = progressiveQualities
    .slice()
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
    ?? adaptiveQualities
      .slice()
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
    ?? qualities[0];

  return {
    videoId,
    title,
    author,
    durationSeconds,
    ...deriveSelectedFields(selected),
    qualities,
    captions: extractCaptionsFromPlayerResponse(response),
    storyboardSpec: extractStoryboardSpec(response),
    // ANDROID_VR rarely includes markersMap; prefer empty and merge from the watch page.
    chapters: extractChaptersFromSource(response, durationSeconds, videoId),
    resolvedAt: Date.now()
  };
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function resolveAdFreeStreamFromPlayerApi({
  videoId,
  customFetch,
  visitorData
}: {
  videoId: string;
  customFetch?: FetchFn;
  visitorData?: string;
}): Promise<AdFreeStreamPayload> {
  const response = await fetchAndroidPlayerResponse({
    videoId,
    customFetch,
    visitorData
  });
  return buildAdFreeStreamPayload(videoId, response);
}

/** Normalize older session payloads that predate the qualities array. */
export function normalizeAdFreeStreamPayload(value: unknown): AdFreeStreamPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.videoId !== "string" || typeof record.title !== "string") {
    return null;
  }

  if (Array.isArray(record.qualities) && record.qualities.length > 0) {
    const qualities = record.qualities.filter(isQualityOption);
    if (qualities.length === 0) {
      return null;
    }
    const selectedQualityId = typeof record.selectedQualityId === "string"
      && qualities.some(q => q.id === record.selectedQualityId)
      ? record.selectedQualityId
      : qualities[0].id;
    const selected = qualities.find(q => q.id === selectedQualityId) ?? qualities[0];
    const captions = Array.isArray(record.captions)
      ? record.captions.filter(isAdFreeCaptionTrack)
      : [];
    const durationSeconds = typeof record.durationSeconds === "number" && record.durationSeconds > 0
      ? record.durationSeconds
      : 0;
    return {
      videoId: record.videoId,
      title: record.title,
      author: typeof record.author === "string" ? record.author : "Unknown author",
      durationSeconds,
      ...deriveSelectedFields(selected),
      qualities,
      captions,
      storyboardSpec: typeof record.storyboardSpec === "string" && record.storyboardSpec.includes("|")
        ? record.storyboardSpec
        : null,
      chapters: Array.isArray(record.chapters)
        ? record.chapters.filter(isAdFreeChapter)
        : [],
      resolvedAt: typeof record.resolvedAt === "number" ? record.resolvedAt : Date.now()
    };
  }

  // Legacy single-URL payload
  const progressiveUrl = typeof record.progressiveUrl === "string" ? record.progressiveUrl : null;
  const videoUrl = typeof record.videoUrl === "string" ? record.videoUrl : null;
  const audioUrl = typeof record.audioUrl === "string" ? record.audioUrl : null;
  const activeUrl = progressiveUrl ?? videoUrl;
  if (!activeUrl) {
    return null;
  }

  const quality: AdFreeQualityOption = {
    id: "legacy-0",
    label: typeof record.qualityLabel === "string" ? record.qualityLabel : "Default",
    height: 0,
    itag: 0,
    videoUrl: activeUrl,
    audioUrl: progressiveUrl ? null : audioUrl,
    isProgressive: Boolean(progressiveUrl),
    mimeType: "video/mp4"
  };

  return {
    videoId: record.videoId,
    title: record.title,
    author: typeof record.author === "string" ? record.author : "Unknown author",
    durationSeconds: typeof record.durationSeconds === "number" && record.durationSeconds > 0
      ? record.durationSeconds
      : 0,
    ...deriveSelectedFields(quality),
    qualities: [quality],
    captions: Array.isArray(record.captions)
      ? record.captions.filter(isAdFreeCaptionTrack)
      : [],
    storyboardSpec: typeof record.storyboardSpec === "string" && record.storyboardSpec.includes("|")
      ? record.storyboardSpec
      : null,
    chapters: Array.isArray(record.chapters)
      ? record.chapters.filter(isAdFreeChapter)
      : [],
    resolvedAt: typeof record.resolvedAt === "number" ? record.resolvedAt : Date.now()
  };
}

function isQualityOption(value: unknown): value is AdFreeQualityOption {
  if (!value || typeof value !== "object") {
    return false;
  }
  const q = value as Record<string, unknown>;
  return typeof q.id === "string"
    && typeof q.label === "string"
    && typeof q.videoUrl === "string"
    && typeof q.isProgressive === "boolean"
    && (typeof q.audioUrl === "string" || q.audioUrl === null);
}
