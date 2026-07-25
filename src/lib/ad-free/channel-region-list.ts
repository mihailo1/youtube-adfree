import type { Prettify } from "@/types";

const BROWSE_URL = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false";
const PLAYLIST_URL_PREFIX = "https://www.youtube.com/playlist?list=";
const INITIAL_DATA_PATTERN = /var ytInitialData\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s;
const CLIENT_VERSION_PATTERN = /"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/;
const VISITOR_DATA_PATTERN = /"visitorData":"([^"]+)"/;
const CHANNEL_ID_PATTERN = /"channelId":"(UC[\w-]{22})"/;
const EXTERNAL_ID_PATTERN = /"externalId":"(UC[\w-]{22})"/;
const BROWSE_ID_PATTERN = /"browseId":"(UC[\w-]{22})"/;
const MAX_CONTINUATION_PAGES = 20;
const DEFAULT_GL = "US";
const DEFAULT_HL = "en";
const DEFAULT_CLIENT_VERSION = "2.20240101.00.00";

export type ChannelVideoItem = Prettify<{
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  lengthText: string | null;
  publishedTimeText: string | null;
}>;

export type ChannelRegionListResult = Prettify<{
  channelId: string;
  uploadsPlaylistId: string;
  gl: string;
  videos: ChannelVideoItem[];
}>;

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type BrowseClient = {
  clientVersion: string;
  visitorData: string;
  gl: string;
  hl: string;
};

function channelIdToUploadsPlaylistId(channelId: string): string {
  if (channelId.startsWith("UC") && channelId.length >= 24) {
    return `UU${channelId.slice(2)}`;
  }
  return channelId;
}

export function extractChannelIdFromText(text: string): string | null {
  for (const pattern of [CHANNEL_ID_PATTERN, EXTERNAL_ID_PATTERN, BROWSE_ID_PATTERN]) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function extractChannelIdFromUrl(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    const channelMatch = url.pathname.match(/\/channel\/(UC[\w-]{22})/);
    if (channelMatch?.[1]) {
      return channelMatch[1];
    }
  } catch {
    // ignore
  }
  return null;
}

export function isChannelVideosPath(pathname: string): boolean {
  // /@handle/videos, /channel/UC…/videos, /c/name/videos, /user/name/videos
  if (/\/videos\/?$/.test(pathname)) {
    return /\/(@|channel\/|c\/|user\/)/.test(pathname);
  }
  // Some layouts use /videos?view=0&sort=dd…
  if (pathname.includes("/videos")) {
    return /\/(@|channel\/|c\/|user\/)/.test(pathname);
  }
  return false;
}

function extractInnertubeMeta(html: string, gl: string, hl: string): BrowseClient {
  const [, clientVersion = DEFAULT_CLIENT_VERSION] = html.match(CLIENT_VERSION_PATTERN) ?? [];
  const [, visitorData = ""] = html.match(VISITOR_DATA_PATTERN) ?? [];
  return {
    clientVersion,
    visitorData,
    gl,
    hl
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function readSimpleText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  if (typeof record.simpleText === "string") {
    return record.simpleText;
  }
  const runs = record.runs;
  if (Array.isArray(runs)) {
    return runs
      .map(run => {
        const runRecord = asRecord(run);
        return typeof runRecord?.text === "string" ? runRecord.text : "";
      })
      .join("") || null;
  }
  return null;
}

function pickThumbnail(videoId: string, thumbnails: unknown): string | null {
  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    const last = asRecord(thumbnails[thumbnails.length - 1]);
    if (typeof last?.url === "string") {
      return last.url;
    }
  }
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function videoFromPlaylistRenderer(renderer: Record<string, unknown>): ChannelVideoItem | null {
  const videoId = typeof renderer.videoId === "string" ? renderer.videoId : null;
  if (!videoId) {
    return null;
  }
  const title = readSimpleText(renderer.title) ?? videoId;
  const lengthText = readSimpleText(renderer.lengthText);
  const publishedTimeText = readSimpleText(renderer.videoInfo)
    ?? readSimpleText(renderer.publishedTimeText);
  const thumb = asRecord(renderer.thumbnail);
  return {
    videoId,
    title,
    thumbnailUrl: pickThumbnail(videoId, thumb?.thumbnails),
    lengthText,
    publishedTimeText
  };
}

function videoFromGridRenderer(renderer: Record<string, unknown>): ChannelVideoItem | null {
  const videoId = typeof renderer.videoId === "string" ? renderer.videoId : null;
  if (!videoId) {
    return null;
  }
  const title = readSimpleText(renderer.title) ?? videoId;
  // length often lives in thumbnailOverlays
  let overlayLength: string | null = null;
  const overlays = renderer.thumbnailOverlays;
  if (Array.isArray(overlays)) {
    for (const overlay of overlays) {
      const rec = asRecord(overlay);
      const timeOverlay = asRecord(rec?.thumbnailOverlayTimeStatusRenderer);
      const text = readSimpleText(timeOverlay?.text);
      if (text) {
        overlayLength = text;
        break;
      }
    }
  }
  const lengthText = overlayLength ?? readSimpleText(renderer.lengthText);
  const publishedTimeText = readSimpleText(renderer.publishedTimeText);
  const thumb = asRecord(renderer.thumbnail);
  return {
    videoId,
    title,
    thumbnailUrl: pickThumbnail(videoId, thumb?.thumbnails),
    lengthText,
    publishedTimeText
  };
}

function videoFromRichItem(item: Record<string, unknown>): ChannelVideoItem | null {
  const content = asRecord(item.content);
  const videoRenderer = asRecord(content?.videoRenderer);
  if (videoRenderer) {
    return videoFromGridRenderer(videoRenderer);
  }
  const lockup = asRecord(content?.lockupViewModel);
  // lockup path is newer; try contentId
  if (lockup) {
    const contentId = typeof lockup.contentId === "string" ? lockup.contentId : null;
    if (contentId && contentId.length === 11) {
      const metadata = asRecord(lockup.metadata);
      const title = readSimpleText(metadata?.title) ?? contentId;
      return {
        videoId: contentId,
        title,
        thumbnailUrl: pickThumbnail(contentId, null),
        lengthText: null,
        publishedTimeText: null
      };
    }
  }
  return null;
}

function collectVideosFromUnknown(node: unknown, out: Map<string, ChannelVideoItem>, depth = 0) {
  if (depth > 40 || node == null) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectVideosFromUnknown(item, out, depth + 1);
    }
    return;
  }
  const record = asRecord(node);
  if (!record) {
    return;
  }

  if (record.playlistVideoRenderer) {
    const item = videoFromPlaylistRenderer(asRecord(record.playlistVideoRenderer)!);
    if (item) {
      out.set(item.videoId, item);
    }
  }
  if (record.gridVideoRenderer) {
    const item = videoFromGridRenderer(asRecord(record.gridVideoRenderer)!);
    if (item) {
      out.set(item.videoId, item);
    }
  }
  if (record.videoRenderer) {
    const item = videoFromGridRenderer(asRecord(record.videoRenderer)!);
    if (item) {
      out.set(item.videoId, item);
    }
  }
  if (record.richItemRenderer) {
    const item = videoFromRichItem(asRecord(record.richItemRenderer)!);
    if (item) {
      out.set(item.videoId, item);
    }
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      collectVideosFromUnknown(value, out, depth + 1);
    }
  }
}

function extractContinuationToken(node: unknown, depth = 0): string | null {
  if (depth > 40 || node == null) {
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const token = extractContinuationToken(item, depth + 1);
      if (token) {
        return token;
      }
    }
    return null;
  }
  const record = asRecord(node);
  if (!record) {
    return null;
  }
  const cont = asRecord(record.continuationItemRenderer);
  const endpoint = asRecord(cont?.continuationEndpoint);
  const command = asRecord(endpoint?.continuationCommand);
  if (typeof command?.token === "string") {
    return command.token;
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const token = extractContinuationToken(value, depth + 1);
      if (token) {
        return token;
      }
    }
  }
  return null;
}

async function browseInnertube({
  body,
  visitorData,
  customFetch
}: {
  body: Record<string, unknown>;
  visitorData: string;
  customFetch?: FetchFn;
}): Promise<unknown> {
  const performFetch = customFetch ?? fetch;
  const response = await performFetch(BROWSE_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {})
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`InnerTube browse HTTP ${response.status}`);
  }
  return response.json();
}

function buildBrowseBody({
  browseId,
  continuation,
  client
}: {
  browseId?: string;
  continuation?: string;
  client: BrowseClient;
}) {
  return {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: client.clientVersion,
        gl: client.gl,
        hl: client.hl,
        ...(client.visitorData ? { visitorData: client.visitorData } : {})
      }
    },
    ...(browseId ? { browseId } : {}),
    ...(continuation ? { continuation } : {})
  };
}

export async function fetchChannelVideosWithGl({
  channelId,
  gl = DEFAULT_GL,
  hl = DEFAULT_HL,
  customFetch
}: {
  channelId: string;
  gl?: string;
  hl?: string;
  customFetch?: FetchFn;
}): Promise<ChannelRegionListResult> {
  const uploadsPlaylistId = channelIdToUploadsPlaylistId(channelId);
  const performFetch = customFetch ?? fetch;

  // Bootstrap: playlist HTML gives visitorData + first page (region still IP-biased on HTML,
  // but we re-fetch via browse with explicit gl for continuations and primary list).
  const playlistResponse = await performFetch(
    `${PLAYLIST_URL_PREFIX}${encodeURIComponent(uploadsPlaylistId)}`,
    { credentials: "include" }
  );
  if (!playlistResponse.ok) {
    throw new Error(`Playlist page HTTP ${playlistResponse.status}`);
  }
  const html = await playlistResponse.text();
  const client = extractInnertubeMeta(html, gl, hl);

  const videos = new Map<string, ChannelVideoItem>();

  // Seed from playlist HTML if present
  const initialMatch = html.match(INITIAL_DATA_PATTERN);
  if (initialMatch?.[1]) {
    try {
      collectVideosFromUnknown(JSON.parse(initialMatch[1]), videos);
    } catch {
      // ignore parse errors
    }
  }

  // Primary listing via browse VL + uploads playlist with forced gl
  const browseId = `VL${uploadsPlaylistId}`;
  let json = await browseInnertube({
    body: buildBrowseBody({ browseId, client }),
    visitorData: client.visitorData,
    customFetch
  });
  collectVideosFromUnknown(json, videos);

  let continuation = extractContinuationToken(json);
  let pages = 0;
  while (continuation && pages < MAX_CONTINUATION_PAGES) {
    pages += 1;
    json = await browseInnertube({
      body: buildBrowseBody({ continuation, client }),
      visitorData: client.visitorData,
      customFetch
    });
    const before = videos.size;
    collectVideosFromUnknown(json, videos);
    continuation = extractContinuationToken(json);
    // Stop if a page adds nothing and no new token logic needed
    if (videos.size === before && !continuation) {
      break;
    }
  }

  return {
    channelId,
    uploadsPlaylistId,
    gl,
    videos: [...videos.values()]
  };
}

/** Parse video IDs currently rendered on a channel Videos tab. */
export function collectVisibleVideoIdsFromDocument(doc: Document = document): Set<string> {
  const ids = new Set<string>();
  const anchors = doc.querySelectorAll<HTMLAnchorElement>(
    "a[href*='/watch?v='], a[href*='watch?v=']"
  );
  for (const elAnchor of anchors) {
    try {
      const href = elAnchor.href || elAnchor.getAttribute("href") || "";
      const url = new URL(href, location.origin);
      const videoId = url.searchParams.get("v");
      if (videoId && /^[\w-]{11}$/.test(videoId)) {
        ids.add(videoId);
      }
    } catch {
      // ignore
    }
  }
  // Newer lockup content-id classes
  for (const el of doc.querySelectorAll("[class*='content-id-']")) {
    const match = el.className.match(/content-id-([\w-]{11})/);
    if (match?.[1]) {
      ids.add(match[1]);
    }
  }
  return ids;
}
