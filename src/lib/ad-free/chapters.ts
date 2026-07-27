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
 * Extract chapter list from any YouTube JSON blob (ytInitialData, playerResponse, …).
 */
export function extractChaptersFromSource(
  source: unknown,
  durationSeconds = 0
): AdFreeChapter[] {
  if (!source) {
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
  return normalizeChapters(raw, durationSeconds);
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
 */
export function extractChaptersFromHtml(html: string, durationSeconds = 0): AdFreeChapter[] {
  const blobs: unknown[] = [];
  for (const pattern of [...INITIAL_DATA_PATTERNS, ...PLAYER_RESPONSE_PATTERNS]) {
    const match = html.match(pattern);
    const jsonText = match?.[1];
    if (!jsonText) {
      continue;
    }
    const parsed = tryParseJsonObject(jsonText);
    if (parsed) {
      blobs.push(parsed);
    }
  }

  let best: AdFreeChapter[] = [];
  for (const blob of blobs) {
    const chapters = extractChaptersFromSource(blob, durationSeconds);
    if (chapters.length > best.length) {
      best = chapters;
    }
  }
  return best;
}

/**
 * Content-script safe: scan page scripts for chapter metadata.
 */
export function extractChaptersFromDocument(
  doc: Document = document,
  durationSeconds = 0
): AdFreeChapter[] {
  const scripts = doc.querySelectorAll("script");
  let best: AdFreeChapter[] = [];

  for (const elScript of scripts) {
    const text = elScript.textContent;
    if (!text) {
      continue;
    }
    // Cheap prefilter
    if (
      !text.includes("markersMap")
      && !text.includes("chapterRenderer")
      && !text.includes("macroMarkersList")
      && !text.includes("DESCRIPTION_CHAPTERS")
    ) {
      continue;
    }
    const chapters = extractChaptersFromHtml(text, durationSeconds);
    if (chapters.length > best.length) {
      best = chapters;
    }
  }

  if (best.length >= 2) {
    return best;
  }

  // Last resort: full HTML (can be heavy; only if nothing found)
  return extractChaptersFromHtml(doc.documentElement?.innerHTML ?? "", durationSeconds);
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
