import type { Prettify } from "@/types";

const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
const ANDROID_VR_CLIENT_NAME = "ANDROID_VR";
const ANDROID_VR_CLIENT_VERSION = "1.65.10";
const ANDROID_VR_SDK_VERSION = 32;
const ANDROID_VR_DEVICE_MAKE = "Oculus";
const ANDROID_VR_DEVICE_MODEL = "Quest 3";
const ANDROID_VR_USER_AGENT =
  "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L) gzip";
const ANDROID_VR_OS_NAME = "Android";
const ANDROID_VR_OS_VERSION = "12L";
const CONTENT_TYPE_JSON = "application/json";

// Placeholder substituted in MAIN-world by page-sabr-fetch.content.ts so the BG
// never needs to read ytcfg.VISITOR_DATA directly (extension contexts cannot
// reach the page's ytcfg).
const VISITOR_DATA_TOKEN = "__YTDL_VISITOR_DATA__";

export type AndroidStreamingFormat = Prettify<{
  itag: number;
  url?: string;
  mimeType: string;
  contentLength?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  qualityLabel?: string;
  audioChannels?: number;
  audioSampleRate?: string;
}>;

export type AndroidCaptionTrack = Prettify<{
  baseUrl?: string;
  name?: { simpleText?: string };
  languageCode?: string;
  kind?: string;
  vssId?: string;
  isTranslatable?: boolean;
}>;

export type AndroidPlayerResponse = Prettify<{
  videoDetails?: {
    title?: string;
    author?: string;
    lengthSeconds?: string;
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  streamingData?: {
    formats?: AndroidStreamingFormat[];
    adaptiveFormats?: AndroidStreamingFormat[];
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: AndroidCaptionTrack[];
    };
  };
}>;

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type FetchAndroidPlayerResponseParams = Prettify<{
  videoId: string;
  customFetch?: FetchFn;
  // Real visitorData for extension-context fetches. When omitted, the
  // VISITOR_DATA_TOKEN placeholder is used so MAIN-world page-proxy can
  // substitute ytcfg.VISITOR_DATA.
  visitorData?: string;
}>;

// Fetches a YouTube InnerTube `/player` response using the ANDROID_VR client
// (X-YouTube-Client-Name 28). yt-dlp's `android_vr` extractor relies on the
// same client because it is the only first-party client that returns direct
// CDN URLs for all adaptive formats without requiring a PO token, without
// forcing SABR, and without imposing the 4 MB per-request range cap that the
// plain `ANDROID` client enforces.
//
// `credentials: "include"` alone (with `visitorData` embedded in the context)
// is sufficient to pass YouTube's anti-bot gate. Without `visitorData` the
// response is `LOGIN_REQUIRED: "Sign in to confirm you're not a bot"`.
// Extension-origin fetches are often HTTP 403 - prefer customFetch via the
// YouTube tab page-proxy (see createPageProxyFetch).
export async function fetchAndroidPlayerResponse({
  videoId, customFetch, visitorData
}: FetchAndroidPlayerResponseParams): Promise<AndroidPlayerResponse> {
  const resolvedVisitorData = visitorData || VISITOR_DATA_TOKEN;
  const body = {
    context: {
      client: {
        clientName: ANDROID_VR_CLIENT_NAME,
        clientVersion: ANDROID_VR_CLIENT_VERSION,
        deviceMake: ANDROID_VR_DEVICE_MAKE,
        deviceModel: ANDROID_VR_DEVICE_MODEL,
        androidSdkVersion: ANDROID_VR_SDK_VERSION,
        userAgent: ANDROID_VR_USER_AGENT,
        osName: ANDROID_VR_OS_NAME,
        osVersion: ANDROID_VR_OS_VERSION,
        hl: "en",
        gl: "US",
        visitorData: resolvedVisitorData
      }
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true
  };
  const performFetch = customFetch ?? fetch;
  const response = await performFetch(INNERTUBE_PLAYER_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": CONTENT_TYPE_JSON,
      ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {})
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`ANDROID_VR player API HTTP ${response.status}`);
  }

  return response.json();
}

export type ResolvedAndroidUrls = Prettify<{
  videoUrl: string | null;
  videoContentLength: number;
  audioUrl: string | null;
  audioContentLength: number;
  extraAudioUrls: {
    url: string | null;
    contentLength: number;
  }[];
}>;

function parseContentLength(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

type ResolveAndroidUrlsParams = Prettify<{
  videoId: string;
  videoItag?: number;
  audioItag?: number;
  extraAudioItags?: number[];
  customFetch?: FetchFn;
}>;

export async function resolveAndroidUrls({
  videoId, videoItag, audioItag, extraAudioItags, customFetch
}: ResolveAndroidUrlsParams): Promise<ResolvedAndroidUrls> {
  const response = await fetchAndroidPlayerResponse({
    videoId,
    customFetch
  });
  const isPlayable = response.playabilityStatus?.status === "OK";
  if (!isPlayable) {
    throw new Error(`ANDROID_VR player not playable: ${response.playabilityStatus?.status} ${response.playabilityStatus?.reason ?? ""}`);
  }

  const adaptiveFormats = response.streamingData?.adaptiveFormats ?? [];
  const progressiveFormats = response.streamingData?.formats ?? [];
  const allFormats = [...adaptiveFormats, ...progressiveFormats];

  const videoMatch = videoItag != null ? allFormats.find(format => format.itag === videoItag) : null;
  const audioMatch = audioItag != null ? allFormats.find(format => format.itag === audioItag) : null;
  const extraAudioUrls = (extraAudioItags ?? []).map(itag => {
    const match = allFormats.find(format => format.itag === itag);
    return {
      url: match?.url ?? null,
      contentLength: parseContentLength(match?.contentLength)
    };
  });

  return {
    videoUrl: videoMatch?.url ?? null,
    videoContentLength: parseContentLength(videoMatch?.contentLength),
    audioUrl: audioMatch?.url ?? null,
    audioContentLength: parseContentLength(audioMatch?.contentLength),
    extraAudioUrls
  };
}
