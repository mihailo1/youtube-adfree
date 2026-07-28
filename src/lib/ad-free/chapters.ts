/**
 * YouTube video chapters for the ad-free Vidstack player.
 *
 * Sources (in priority order when merging):
 * 1. `markersMap` on multiMarkersPlayerBar (DESCRIPTION_CHAPTERS preferred)
 * 2. `engagementPanels` → macroMarkersListRenderer
 * 3. Nested `chapterRenderer` lists elsewhere in ytInitialData / player response
 *
 * Output is consumed as a Vidstack `kind: "chapters"` text track so the default
 * layout can draw progress-bar segments, active fill, hover title + storyboard.
 */

import type { Prettify } from "@/types";

export type AdFreeChapter = Prettify<{
  /** Inclusive start (seconds). */
  startSeconds: number;
  /** Exclusive end (seconds); last chapter uses video duration when known. */
  endSeconds: number;
  title: string;
}>;

const INITIAL_DATA_PATTERNS = [
  /ytInitialData\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s,
  /var\s+ytInitialData\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s
] as const;

const PLAYER_RESPONSE_PATTERNS = [
  /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s,
  /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSimpleText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.simpleText === "string") {
    return value.simpleText.trim();
  }
  if (Array.isArray(value.runs)) {
    return value.runs
      .map(run => (isRecord(run) && typeof run.text === "string" ? run.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function readStartSeconds(node: Record<string, unknown>): number | null {
  const millisKeys = [
    "timeRangeStartMillis",
    "startTimeMillis",
    "startTimeMs",
    "onTapTimeMillis"
  ] as const;
  for (const key of millisKeys) {
    const raw = node[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      return raw / 1000;
    }
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
      return Number(raw) / 1000;
    }
  }
  const secondsKeys = ["startTimeSeconds", "startSeconds"] as const;
  for (const key of secondsKeys) {
    const raw = node[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      return raw;
    }
  }
  return null;
}

type RawChapter = { startSeconds: number; title: string };

function pushChapter(out: RawChapter[], startSeconds: number, title: string) {
  const cleaned = title.trim();
  if (!(startSeconds >= 0) || !cleaned) {
    return;
  }
  out.push({ startSeconds, title: cleaned });
}

/** Extract from a single chapter-like renderer node. */
function readChapterNode(node: unknown, out: RawChapter[]) {
  if (!isRecord(node)) {
    return;
  }
  // Unwrap common wrappers
  const renderer = isRecord(node.chapterRenderer)
    ? node.chapterRenderer
    : isRecord(node.macroMarkersListItemRenderer)
      ? node.macroMarkersListItemRenderer
      : isRecord(node.markerRenderer)
        ? node.markerRenderer
        : node;

  if (!isRecord(renderer)) {
    return;
  }

  const start = readStartSeconds(renderer);
  if (start == null) {
    return;
  }
  const title = readSimpleText(renderer.title)
    || readSimpleText(renderer.headline)
    || readSimpleText(renderer.label);
  pushChapter(out, start, title);
}

/**
 * Prefer DESCRIPTION_CHAPTERS over AUTO_CHAPTERS when both exist in markersMap.
 */
function extractFromMarkersMap(root: unknown, out: RawChapter[]) {
  const maps: unknown[] = [];
  collectByKey(root, "markersMap", maps, 0, 12);
  let best: RawChapter[] = [];
  let bestScore = -1;

  for (const map of maps) {
    const entries = normalizeMarkersMap(map);
    for (const entry of entries) {
      const key = String(entry.key ?? "").toUpperCase();
      const value = entry.value;
      if (!isRecord(value)) {
        continue;
      }
      const chaptersRaw = value.chapters;
      if (!Array.isArray(chaptersRaw) || chaptersRaw.length === 0) {
        continue;
      }
      const bucket: RawChapter[] = [];
      for (const item of chaptersRaw) {
        readChapterNode(item, bucket);
      }
      if (bucket.length === 0) {
        continue;
      }
      // DESCRIPTION > KEY_CONCEPTS > AUTO > other
      let score = bucket.length;
      if (key.includes("DESCRIPTION")) {
        score += 1000;
      } else if (key.includes("KEY_CONCEPT") || key.includes("KEY_MOMENT")) {
        score += 500;
      } else if (key.includes("AUTO")) {
        score += 100;
      }
      if (score > bestScore) {
        bestScore = score;
        best = bucket;
      }
    }
  }

  for (const chapter of best) {
    pushChapter(out, chapter.startSeconds, chapter.title);
  }
}

function normalizeMarkersMap(map: unknown): Array<{ key?: string; value?: unknown }> {
  if (Array.isArray(map)) {
    return map.filter(isRecord) as Array<{ key?: string; value?: unknown }>;
  }
  if (isRecord(map)) {
    // Some payloads use an object map keyed by chapter type
    return Object.entries(map).map(([key, value]) => ({ key, value }));
  }
  return [];
}

function extractFromMacroMarkers(root: unknown, out: RawChapter[]) {
  const lists: unknown[] = [];
  collectByKey(root, "macroMarkersListRenderer", lists, 0, 12);
  for (const list of lists) {
    if (!isRecord(list) || !Array.isArray(list.contents)) {
      continue;
    }
    for (const item of list.contents) {
      readChapterNode(item, out);
    }
  }
}

function extractLooseChapterRenderers(root: unknown, out: RawChapter[]) {
  const nodes: unknown[] = [];
  collectByKey(root, "chapterRenderer", nodes, 0, 14);
  for (const node of nodes) {
    readChapterNode({ chapterRenderer: node }, out);
  }
}

/** Depth-limited walk that collects values for a property name. */
function collectByKey(
  root: unknown,
  key: string,
  out: unknown[],
  depth: number,
  maxDepth: number
) {
  if (depth > maxDepth || out.length > 40) {
    return;
  }
  if (Array.isArray(root)) {
    for (const item of root) {
      collectByKey(item, key, out, depth + 1, maxDepth);
    }
    return;
  }
  if (!isRecord(root)) {
    return;
  }
  if (key in root) {
    out.push(root[key]);
  }
  for (const value of Object.values(root)) {
    if (value && typeof value === "object") {
      collectByKey(value, key, out, depth + 1, maxDepth);
    }
  }
}

/**
 * Sort, dedupe by start time, and assign endSeconds from the next chapter
 * (or duration / +ε for the last).
 */
export function normalizeChapters(
  raw: Array<{ startSeconds: number; title: string }>,
  durationSeconds = 0
): AdFreeChapter[] {
  if (raw.length === 0) {
    return [];
  }

  const sorted = raw
    .filter(item => Number.isFinite(item.startSeconds) && item.startSeconds >= 0 && item.title)
    .slice()
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const deduped: Array<{ startSeconds: number; title: string }> = [];
  for (const item of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.startSeconds - item.startSeconds) < 0.05) {
      // Keep longer / non-empty title on collision
      if (item.title.length > prev.title.length) {
        prev.title = item.title;
      }
      continue;
    }
    deduped.push({ startSeconds: item.startSeconds, title: item.title });
  }

  // Need at least 2 markers to be meaningful chapters (YouTube requires 3 in description,
  // but API sometimes returns fewer for auto chapters — still useful with 2+).
  if (deduped.length < 2) {
    return [];
  }

  const duration = durationSeconds > 0 ? durationSeconds : 0;
  const chapters: AdFreeChapter[] = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const start = deduped[i].startSeconds;
    const nextStart = deduped[i + 1]?.startSeconds;
    let end = typeof nextStart === "number" ? nextStart : (duration > start ? duration : start + 1);
    if (end <= start) {
      end = start + 0.05;
    }
    chapters.push({
      startSeconds: start,
      endSeconds: end,
      title: deduped[i].title
    });
  }

  // Ensure last cue reaches true duration when known
  if (duration > 0 && chapters.length > 0) {
    const last = chapters[chapters.length - 1];
    if (last.endSeconds < duration) {
      last.endSeconds = duration;
    }
  }

  return chapters;
}

/**
 * Prefer `videoDetails.videoId` on player-response-like blobs.
 * Walk is depth-limited so we don't pick a random recommended video deeper in the tree.
 */
export function readVideoDetailsId(source: unknown, maxDepth = 6): string | null {
  if (!source || maxDepth < 0) {
    return null;
  }
  if (Array.isArray(source)) {
    for (const item of source) {
      const found = readVideoDetailsId(item, maxDepth - 1);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(source)) {
    return null;
  }
  if (isRecord(source.videoDetails) && typeof source.videoDetails.videoId === "string") {
    return source.videoDetails.videoId;
  }
  // Common nests: playerResponse / playerData
  for (const key of ["playerResponse", "playerData", "response"] as const) {
    if (key in source) {
      const found = readVideoDetailsId(source[key], maxDepth - 1);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function sourceBelongsToVideo(source: unknown, videoId: string): boolean {
  if (!videoId) {
    return true;
  }
  const detailsId = readVideoDetailsId(source);
  if (detailsId) {
    return detailsId === videoId;
  }
  // ytInitialData often has no top-level videoDetails but mentions the watch id.
  try {
    const json = JSON.stringify(source);
    return json.includes(`"videoId":"${videoId}"`);
  } catch {
    return false;
  }
}

/**
 * When a large blob mentions several videos (recommended rail), still extract
 * chapters if the result fits **this** duration. Prefer blobs that match videoId.
 */
function extractChaptersLoose(
  source: unknown,
  durationSeconds: number,
  expectedVideoId?: string
): AdFreeChapter[] {
  if (!source) {
    return [];
  }
  // Strict path first
  if (expectedVideoId && sourceBelongsToVideo(source, expectedVideoId)) {
    const strict = extractChaptersFromSource(source, durationSeconds, expectedVideoId);
    if (strict.length >= 2) {
      return strict;
    }
  }
  // Fallback: pull markersMap / macroMarkers and keep only if they fit duration
  const raw: RawChapter[] = [];
  extractFromMarkersMap(source, raw);
  if (raw.length < 2) {
    extractFromMacroMarkers(source, raw);
  }
  if (raw.length < 2) {
    extractLooseChapterRenderers(source, raw);
  }
  const normalized = normalizeChapters(raw, durationSeconds);
  return finalizeChapters(normalized, durationSeconds);
}

/**
 * Drop chapters that clearly belong to a different (usually longer) video.
 */
export function chaptersFitDuration(
  chapters: AdFreeChapter[],
  durationSeconds: number
): boolean {
  if (chapters.length < 2) {
    return false;
  }
  if (!(durationSeconds > 0)) {
    return true;
  }
  // Any chapter that starts well after the video ends is stale (wrong video).
  for (const chapter of chapters) {
    if (chapter.startSeconds > durationSeconds + 2) {
      return false;
    }
  }
  const lastStart = chapters[chapters.length - 1]?.startSeconds ?? 0;
  // Whole chapter map is much longer than this video → wrong source.
  if (lastStart > durationSeconds * 1.15 + 5) {
    return false;
  }
  return true;
}

function finalizeChapters(
  chapters: AdFreeChapter[],
  durationSeconds: number
): AdFreeChapter[] {
  if (chapters.length < 2) {
    return [];
  }
  if (!chaptersFitDuration(chapters, durationSeconds)) {
    return [];
  }
  return chapters;
}

/**
 * Extract chapter list from any YouTube JSON blob (ytInitialData, playerResponse, …).
 * Pass `expectedVideoId` after SPA navigation so leftover JSON from the previous
 * watch is never reused.
 */
export function extractChaptersFromSource(
  source: unknown,
  durationSeconds = 0,
  expectedVideoId?: string
): AdFreeChapter[] {
  if (!source) {
    return [];
  }
  if (expectedVideoId && !sourceBelongsToVideo(source, expectedVideoId)) {
    return [];
  }
  const raw: RawChapter[] = [];
  extractFromMarkersMap(source, raw);
  if (raw.length < 2) {
    extractFromMacroMarkers(source, raw);
  }
  if (raw.length < 2) {
    extractLooseChapterRenderers(source, raw);
  }
  return finalizeChapters(normalizeChapters(raw, durationSeconds), durationSeconds);
}

function tryParseJsonObject(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Parse chapters from a script/HTML string (ytInitialData + ytInitialPlayerResponse).
 * Prefer player response blobs that match `expectedVideoId`.
 */
export function extractChaptersFromHtml(
  html: string,
  durationSeconds = 0,
  expectedVideoId?: string
): AdFreeChapter[] {
  if (expectedVideoId && !html.includes(expectedVideoId)) {
    return [];
  }

  const blobs: unknown[] = [];
  // Prefer player response first — tighter binding to the watched video.
  for (const pattern of [...PLAYER_RESPONSE_PATTERNS, ...INITIAL_DATA_PATTERNS]) {
    const match = html.match(pattern);
    const jsonText = match?.[1];
    if (!jsonText) {
      continue;
    }
    if (expectedVideoId && !jsonText.includes(expectedVideoId)) {
      continue;
    }
    const parsed = tryParseJsonObject(jsonText);
    if (parsed) {
      blobs.push(parsed);
    }
  }

  let best: AdFreeChapter[] = [];
  for (const blob of blobs) {
    const chapters = extractChaptersFromSource(blob, durationSeconds, expectedVideoId);
    if (chapters.length > best.length) {
      best = chapters;
    }
  }
  return best;
}

function parseClockToSeconds(text: string): number | null {
  const cleaned = text.trim();
  if (!cleaned) {
    return null;
  }
  const parts = cleaned.split(":").map(part => Number(part));
  if (parts.some(part => !Number.isFinite(part))) {
    return null;
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function parseStartFromHref(href: string): number | null {
  try {
    const url = new URL(href, "https://www.youtube.com");
    const t = url.searchParams.get("t") ?? url.searchParams.get("start");
    if (!t) {
      return null;
    }
    // "92s" | "92" | "1h2m3s"
    if (/^\d+$/.test(t)) {
      return Number(t);
    }
    if (/^\d+s$/i.test(t)) {
      return Number(t.slice(0, -1));
    }
    const match = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    if (match) {
      const hours = Number(match[1] ?? 0);
      const minutes = Number(match[2] ?? 0);
      const seconds = Number(match[3] ?? 0);
      return hours * 3600 + minutes * 60 + seconds;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Chapters rendered in the current watch UI (updates on SPA nav; safer than scripts).
 */
function extractChaptersFromLiveDom(
  doc: Document,
  videoId: string,
  durationSeconds: number
): AdFreeChapter[] {
  const flexy = doc.querySelector("ytd-watch-flexy");
  if (flexy) {
    const attrId = flexy.getAttribute("video-id");
    if (attrId && attrId !== videoId) {
      return [];
    }
  }

  const items = doc.querySelectorAll(
    "ytd-macro-markers-list-item-renderer, ytd-chapter-renderer"
  );
  const raw: RawChapter[] = [];

  for (const item of items) {
    if (!(item instanceof HTMLElement)) {
      continue;
    }
    const link = item.querySelector("a[href]") as HTMLAnchorElement | null;
    const href = link?.getAttribute("href") ?? "";
    if (href && videoId && href.includes("v=") && !href.includes(videoId)) {
      // Link points at another video — skip
      continue;
    }

    let start = href ? parseStartFromHref(href) : null;
    if (start == null) {
      const timeEl = item.querySelector(
        "#time, .yt-core-attributed-string, span.ytd-macro-markers-list-item-renderer"
      );
      // Prefer dedicated time nodes when present
      const timeCandidates = item.querySelectorAll("#time, #time-stamp, .time, [id*='time']");
      for (const node of timeCandidates) {
        const parsed = parseClockToSeconds(node.textContent ?? "");
        if (parsed != null) {
          start = parsed;
          break;
        }
      }
      if (start == null && timeEl) {
        start = parseClockToSeconds(timeEl.textContent ?? "");
      }
    }
    if (start == null) {
      continue;
    }

    const titleEl = item.querySelector(
      "h4, #title, .yt-core-attributed-string, yt-formatted-string"
    );
    const title = (titleEl?.textContent ?? link?.textContent ?? "").trim();
    if (!title || title === (item.querySelector("#time")?.textContent ?? "").trim()) {
      continue;
    }
    pushChapter(raw, start, title);
  }

  return finalizeChapters(normalizeChapters(raw, durationSeconds), durationSeconds);
}

/**
 * Content-script safe chapter extract for the **current** watch video only.
 *
 * SPA caveat: script tags often still hold the *previous* video's ytInitialData.
 * Always pass `videoId`. Duration fit rejects maps from a different-length video.
 *
 * Always Ad-Free often runs before engagement panels hydrate — call again later.
 */
export function extractChaptersFromDocument(
  doc: Document = document,
  durationSeconds = 0,
  videoId = ""
): AdFreeChapter[] {
  // 1) Live DOM for this watch page (updates on SPA nav once panels paint)
  if (videoId) {
    const fromDom = extractChaptersFromLiveDom(doc, videoId, durationSeconds);
    if (fromDom.length >= 2) {
      return fromDom;
    }
  }

  // 2) Script blobs that mention this videoId (or any chapter markers + duration fit)
  const scripts = doc.querySelectorAll("script");
  let best: AdFreeChapter[] = [];

  for (const elScript of scripts) {
    const text = elScript.textContent;
    if (!text) {
      continue;
    }
    if (
      !text.includes("markersMap")
      && !text.includes("chapterRenderer")
      && !text.includes("macroMarkersList")
      && !text.includes("DESCRIPTION_CHAPTERS")
      && !text.includes("macroMarkersListItemRenderer")
    ) {
      continue;
    }
    // Prefer scripts that mention the current id; still try others with duration fit
    const mentionsId = !videoId || text.includes(videoId);
    if (!mentionsId && best.length >= 2) {
      continue;
    }

    for (const pattern of [...PLAYER_RESPONSE_PATTERNS, ...INITIAL_DATA_PATTERNS]) {
      const match = text.match(pattern);
      const jsonText = match?.[1];
      if (!jsonText) {
        continue;
      }
      if (videoId && !jsonText.includes(videoId) && !mentionsId) {
        continue;
      }
      const parsed = tryParseJsonObject(jsonText);
      if (!parsed) {
        continue;
      }
      const chapters = videoId
        ? extractChaptersLoose(parsed, durationSeconds, videoId)
        : extractChaptersFromSource(parsed, durationSeconds);
      if (chapters.length > best.length) {
        best = chapters;
      }
    }

    // Also try the whole script as one blob (some embeds omit ytInitial* assignment)
    if (best.length < 2 && mentionsId) {
      const parsed = tryParseJsonObject(text.trim().replace(/^[\s\S]*?=/, "").replace(/;?\s*$/, ""));
      // skip fragile whole-script parse
    }
  }

  if (best.length >= 2) {
    return best;
  }

  // 3) Scoped HTML fallback only when the document string contains this videoId
  if (videoId) {
    const html = doc.documentElement?.innerHTML ?? "";
    if (html.includes(videoId) && html.includes("markersMap")) {
      // Extract only the playerResponse / initialData slices that mention this id
      return extractChaptersFromHtml(html, durationSeconds, videoId);
    }
  }

  return [];
}

export function isAdFreeChapter(value: unknown): value is AdFreeChapter {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.startSeconds === "number"
    && typeof value.endSeconds === "number"
    && typeof value.title === "string"
    && value.startSeconds >= 0
    && value.endSeconds > value.startSeconds
    && value.title.length > 0;
}

/** Vidstack `TextTrackInit` content (json cues). */
export function chaptersToVttContent(chapters: AdFreeChapter[]): {
  cues: Array<{ startTime: number; endTime: number; text: string }>;
} {
  return {
    cues: chapters.map(chapter => ({
      startTime: chapter.startSeconds,
      endTime: chapter.endSeconds,
      text: chapter.title
    }))
  };
}

/**
 * WebVTT body for blob-URL `<track kind="chapters">` fallback.
 */
export function chaptersToWebVtt(chapters: AdFreeChapter[]): string {
  const lines = ["WEBVTT", ""];
  for (const chapter of chapters) {
    lines.push(
      `${formatVttTimestamp(chapter.startSeconds)} --> ${formatVttTimestamp(chapter.endSeconds)}`,
      chapter.title.replace(/\r?\n/g, " "),
      ""
    );
  }
  return lines.join("\n");
}

function formatVttTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}
