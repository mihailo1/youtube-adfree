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
  // Prefer structured metadata over a random first "channelId" in the page blob
  const preferredPatterns = [
    /"channelMetadataRenderer"\s*:\s*\{[\s\S]*?"externalId"\s*:\s*"(UC[\w-]{22})"/,
    /"channelMetadataRenderer"\s*:\s*\{[\s\S]*?"channelId"\s*:\s*"(UC[\w-]{22})"/,
    /"externalId"\s*:\s*"(UC[\w-]{22})"/,
    /"ownerChannelId"\s*:\s*"(UC[\w-]{22})"/,
    /"browseId"\s*:\s*"(UC[\w-]{22})"/,
    CHANNEL_ID_PATTERN,
    EXTERNAL_ID_PATTERN,
    BROWSE_ID_PATTERN
  ];
  for (const pattern of preferredPatterns) {
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

/** Best-effort channel id from the live channel page DOM / scripts. */
export function extractChannelIdFromDocument(doc: Document = document): string | null {
  const fromUrl = extractChannelIdFromUrl(doc.location?.href ?? location.href);
  if (fromUrl) {
    return fromUrl;
  }

  const metaChannel = doc.querySelector('meta[itemprop="channelId"]')?.getAttribute("content");
  if (metaChannel && /^UC[\w-]{22}$/.test(metaChannel)) {
    return metaChannel;
  }

  for (const selector of ['link[rel="canonical"]', 'meta[property="og:url"]', 'link[itemprop="url"]']) {
    const el = doc.querySelector(selector);
    const href = el?.getAttribute("href") || el?.getAttribute("content") || "";
    const id = extractChannelIdFromUrl(href);
    if (id) {
      return id;
    }
  }

  // Visible links to /channel/UC…
  for (const elAnchor of doc.querySelectorAll<HTMLAnchorElement>('a[href*="/channel/UC"]')) {
    const id = extractChannelIdFromUrl(elAnchor.href || elAnchor.getAttribute("href") || "");
    if (id) {
      return id;
    }
  }

  // ytInitialData / embedded config in scripts (prefer channel metadata blocks)
  for (const elScript of doc.querySelectorAll("script")) {
    const text = elScript.textContent;
    if (!text || text.length < 50) {
      continue;
    }
    if (
      !text.includes("channelMetadataRenderer")
      && !text.includes("externalId")
      && !text.includes("browseId")
      && !text.includes("channelId")
    ) {
      continue;
    }
    const id = extractChannelIdFromText(text);
    if (id) {
      return id;
    }
  }

  // Last resort: large HTML slice (may include related-channel noise)
  return extractChannelIdFromText(doc.documentElement?.innerHTML?.slice(0, 1_500_000) ?? "");
}

export type ChannelListTab = "videos" | "streams";

export function isChannelVideosPath(pathname: string): boolean {
  if (!/\/(@|channel\/|c\/|user\/)/.test(pathname)) {
    return false;
  }
  return /\/videos(\/|$)/.test(pathname);
}

export function isChannelStreamsPath(pathname: string): boolean {
  if (!/\/(@|channel\/|c\/|user\/)/.test(pathname)) {
    return false;
  }
  // Live tab: /streams (current) and legacy /live
  return /\/(streams|live)(\/|$)/.test(pathname);
}

export function isChannelListPath(pathname: string): boolean {
  return isChannelVideosPath(pathname) || isChannelStreamsPath(pathname);
}

export function channelListTabFromPath(pathname: string): ChannelListTab {
  return isChannelStreamsPath(pathname) ? "streams" : "videos";
}

/** Innertube browse params for channel tabs (base64url). */
const CHANNEL_TAB_PARAMS: Record<ChannelListTab, string> = {
  // "videos"
  videos: "EgZ2aWRlb3PyBgQKAjoA",
  // "streams" / live
  streams: "EgdzdHJlYW1z8gYECgJ6AA%3D%3D"
};

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
  params,
  client
}: {
  browseId?: string;
  continuation?: string;
  params?: string;
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
    ...(params ? { params } : {}),
    ...(continuation ? { continuation } : {})
  };
}

async function collectBrowsePages({
  initialBody,
  client,
  customFetch,
  videos
}: {
  initialBody: Record<string, unknown>;
  client: BrowseClient;
  customFetch?: FetchFn;
  videos: Map<string, ChannelVideoItem>;
}) {
  let json = await browseInnertube({
    body: initialBody,
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
    if (videos.size === before && !continuation) {
      break;
    }
  }
}

export async function fetchChannelVideosWithGl({
  channelId,
  gl = DEFAULT_GL,
  hl = DEFAULT_HL,
  tab = "videos",
  customFetch
}: {
  channelId: string;
  gl?: string;
  hl?: string;
  tab?: ChannelListTab;
  customFetch?: FetchFn;
}): Promise<ChannelRegionListResult> {
  const uploadsPlaylistId = channelIdToUploadsPlaylistId(channelId);
  const performFetch = customFetch ?? fetch;

  // Bootstrap: channel or playlist HTML for clientVersion + visitorData
  const bootstrapUrl = tab === "streams"
    ? `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/streams`
    : `${PLAYLIST_URL_PREFIX}${encodeURIComponent(uploadsPlaylistId)}`;

  const bootstrapResponse = await performFetch(bootstrapUrl, { credentials: "include" });
  if (!bootstrapResponse.ok) {
    throw new Error(`Channel bootstrap HTTP ${bootstrapResponse.status}`);
  }
  const html = await bootstrapResponse.text();
  const client = extractInnertubeMeta(html, gl, hl);

  const videos = new Map<string, ChannelVideoItem>();

  const initialMatch = html.match(INITIAL_DATA_PATTERN);
  if (initialMatch?.[1]) {
    try {
      collectVideosFromUnknown(JSON.parse(initialMatch[1]), videos);
    } catch {
      // ignore parse errors
    }
  }

  if (tab === "streams") {
    // Channel Live/Streams tab with forced gl
    await collectBrowsePages({
      initialBody: buildBrowseBody({
        browseId: channelId,
        params: CHANNEL_TAB_PARAMS.streams,
        client
      }),
      client,
      customFetch,
      videos
    });
  } else {
    // Uploads playlist (includes most VODs / past lives that landed in uploads)
    await collectBrowsePages({
      initialBody: buildBrowseBody({
        browseId: `VL${uploadsPlaylistId}`,
        client
      }),
      client,
      customFetch,
      videos
    });

    // Also pull the Videos tab browse (sometimes differs from UU playlist ordering/set)
    try {
      await collectBrowsePages({
        initialBody: buildBrowseBody({
          browseId: channelId,
          params: CHANNEL_TAB_PARAMS.videos,
          client
        }),
        client,
        customFetch,
        videos
      });
    } catch {
      // non-fatal
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
