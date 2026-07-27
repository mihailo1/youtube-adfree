/**
 * YouTube storyboard previews (scrubber hover).
 *
 * Source: `playerResponse.storyboards.playerStoryboardSpecRenderer.spec`
 * (same shape ANDROID_VR / WEB return).
 *
 * Spec shape (yt-dlp / NewPipe compatible):
 * ```
 * <baseUrlWith$L$N>|W#H#frames#cols#rows#intervalMs#name#sigh|...
 * ```
 * - `$L` → quality level index (0 = coarsest)
 * - `$N` → name template (often `M$M` for multi-sheet)
 * - `$M` → zero-based sprite-sheet index
 *
 * Each sheet is a JPEG grid; we expand every cell into a Vidstack
 * `ThumbnailImageInit` so the time slider can show the right frame on hover.
 */

export type StoryboardLevel = {
  /** Cell pixel size */
  width: number;
  height: number;
  /** Total frames across all sheets for this level */
  frameCount: number;
  columns: number;
  rows: number;
  /** Nominal frame duration (seconds); may be refined with video duration */
  intervalSeconds: number;
  /** Level index used in `$L` ($0..n) */
  levelIndex: number;
  /** URL template still containing `$M` for multi-sheet levels */
  urlTemplate: string;
};

/** Subset of Vidstack `ThumbnailImageInit` (coords = crop inside sprite). */
export type StoryboardThumb = {
  url: string;
  startTime: number;
  endTime: number;
  width: number;
  height: number;
  coords: { x: number; y: number };
};

export type StoryboardSpecSource = {
  storyboards?: {
    playerStoryboardSpecRenderer?: { spec?: string };
    playerLiveStoryboardSpecRenderer?: { spec?: string };
  };
  /** Some clients nest the renderer at the top level */
  playerStoryboardSpecRenderer?: { spec?: string };
};

/**
 * Pull raw `spec` string from a player response-like object.
 */
export function extractStoryboardSpec(source: unknown): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const root = source as StoryboardSpecSource & Record<string, unknown>;
  const fromStoryboards = root.storyboards?.playerStoryboardSpecRenderer?.spec
    ?? root.storyboards?.playerLiveStoryboardSpecRenderer?.spec;
  if (typeof fromStoryboards === "string" && fromStoryboards.includes("|")) {
    return fromStoryboards;
  }
  const top = root.playerStoryboardSpecRenderer?.spec;
  if (typeof top === "string" && top.includes("|")) {
    return top;
  }
  return null;
}

function toAbsoluteYtimg(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  if (url.startsWith("//")) {
    return `https:${url}`;
  }
  return `https://i.ytimg.com/${url.replace(/^\//, "")}`;
}

/**
 * Parse all quality levels from a storyboard spec string.
 * Returns coarsest → finest (same order as YouTube `$L` indices).
 */
export function parseStoryboardSpec(spec: string): StoryboardLevel[] {
  const parts = spec.split("|").map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return [];
  }

  const baseUrl = toAbsoluteYtimg(parts[0]);
  const levels: StoryboardLevel[] = [];

  for (let levelIndex = 0; levelIndex < parts.length - 1; levelIndex += 1) {
    const args = parts[levelIndex + 1].split("#");
    if (args.length < 8) {
      continue;
    }
    const width = Number(args[0]);
    const height = Number(args[1]);
    const frameCount = Number(args[2]);
    const columns = Number(args[3]);
    const rows = Number(args[4]);
    const intervalMs = Number(args[5]);
    const name = args[6] ?? "M$M";
    const sigh = args[7] ?? "";

    if (![width, height, frameCount, columns, rows].every(n => Number.isFinite(n) && n > 0)) {
      continue;
    }

    // yt-dlp: base.replace('$L', L).replace('$N', N) + '&sigh=' + sigh
    // Keep sigh raw (already URL-safe from YouTube; encoding can break it).
    let urlTemplate = baseUrl
      .replace(/\$L/g, String(levelIndex))
      .replace(/\$N/g, name);
    if (sigh && !/[?&]sigh=/.test(urlTemplate)) {
      urlTemplate += (urlTemplate.includes("?") ? "&" : "?") + `sigh=${sigh}`;
    }

    levels.push({
      width,
      height,
      frameCount,
      columns,
      rows,
      intervalSeconds: intervalMs > 0 ? intervalMs / 1000 : 0,
      levelIndex,
      urlTemplate
    });
  }

  return levels;
}

/**
 * Prefer a mid/high quality board: good scrub detail without the heaviest sheet.
 * Falls back to finest available.
 */
export function pickStoryboardLevel(levels: StoryboardLevel[]): StoryboardLevel | null {
  if (levels.length === 0) {
    return null;
  }
  // Finest is last; if 3+ levels, pick second-finest for balance
  if (levels.length >= 3) {
    return levels[levels.length - 2];
  }
  return levels[levels.length - 1];
}

function sheetUrl(template: string, sheetIndex: number): string {
  return template.replace(/\$M/g, String(sheetIndex));
}

/**
 * Expand one storyboard level into Vidstack thumbnail cues.
 *
 * @param durationSeconds - Video length (from videoDetails); used to space frames
 *   when the level omits interval or to clamp the last sheet.
 */
export function storyboardLevelToThumbs(
  level: StoryboardLevel,
  durationSeconds: number
): StoryboardThumb[] {
  const perSheet = level.columns * level.rows;
  if (perSheet <= 0 || level.frameCount <= 0) {
    return [];
  }

  const sheetCount = Math.ceil(level.frameCount / perSheet);
  // Prefer explicit interval from spec; else even spacing across duration
  let interval = level.intervalSeconds;
  if (!(interval > 0) && durationSeconds > 0) {
    interval = durationSeconds / level.frameCount;
  }
  if (!(interval > 0)) {
    interval = 2;
  }

  const thumbs: StoryboardThumb[] = [];
  let frameIndex = 0;

  for (let sheet = 0; sheet < sheetCount; sheet += 1) {
    const url = sheetUrl(level.urlTemplate, sheet);
    const framesInSheet = Math.min(perSheet, level.frameCount - frameIndex);

    for (let local = 0; local < framesInSheet; local += 1) {
      const col = local % level.columns;
      const row = Math.floor(local / level.columns);
      const startTime = frameIndex * interval;
      let endTime = startTime + interval;
      if (durationSeconds > 0) {
        endTime = Math.min(endTime, durationSeconds);
      }
      if (durationSeconds > 0 && startTime >= durationSeconds) {
        break;
      }

      thumbs.push({
        url,
        startTime,
        endTime: Math.max(endTime, startTime + 0.05),
        width: level.width,
        height: level.height,
        coords: {
          x: col * level.width,
          y: row * level.height
        }
      });
      frameIndex += 1;
    }
  }

  // Ensure last cue reaches end of video so hover near the end still matches
  if (thumbs.length > 0 && durationSeconds > 0) {
    const last = thumbs[thumbs.length - 1];
    if (last.endTime < durationSeconds) {
      last.endTime = durationSeconds;
    }
  }

  return thumbs;
}

/**
 * Full pipeline: raw player response / stored spec → Vidstack thumbs.
 */
export function buildStoryboardThumbs(options: {
  spec?: string | null;
  playerResponse?: unknown;
  durationSeconds: number;
}): StoryboardThumb[] {
  const spec = options.spec ?? extractStoryboardSpec(options.playerResponse);
  if (!spec) {
    return [];
  }
  const levels = parseStoryboardSpec(spec);
  const level = pickStoryboardLevel(levels);
  if (!level) {
    return [];
  }
  return storyboardLevelToThumbs(level, options.durationSeconds);
}

/** Light metadata for session storage (avoid bloating with expanded thumbs). */
export type AdFreeStoryboardMeta = {
  /** Raw YouTube spec string */
  spec: string;
  /** Selected level index for debugging */
  levelIndex: number;
  width: number;
  height: number;
  frameCount: number;
};

const PLAYER_RESPONSE_PATTERNS = [
  /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s,
  /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s
] as const;

/**
 * Pull storyboard spec from watch-page HTML (isolated content script safe).
 * Fallback when ANDROID_VR omits `storyboards`.
 */
export function extractStoryboardSpecFromHtml(html: string): string | null {
  for (const pattern of PLAYER_RESPONSE_PATTERNS) {
    const match = html.match(pattern);
    const jsonText = match?.[1];
    if (!jsonText) {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      const spec = extractStoryboardSpec(parsed);
      if (spec) {
        return spec;
      }
    } catch {
      // try next pattern
    }
  }
  // Lightweight regex if full JSON parse is too heavy / truncated
  const loose = html.match(
    /"playerStoryboardSpecRenderer"\s*:\s*\{\s*"spec"\s*:\s*"((?:\\.|[^"\\])*)"/
  );
  if (loose?.[1]) {
    try {
      return JSON.parse(`"${loose[1]}"`) as string;
    } catch {
      return loose[1].replace(/\\u0026/g, "&").replace(/\\"/g, '"');
    }
  }
  return null;
}

export function extractStoryboardSpecFromDocument(doc: Document = document): string | null {
  const scripts = doc.querySelectorAll("script");
  for (const elScript of scripts) {
    const text = elScript.textContent;
    if (!text || !text.includes("Storyboard")) {
      continue;
    }
    const spec = extractStoryboardSpecFromHtml(text);
    if (spec) {
      return spec;
    }
  }
  return extractStoryboardSpecFromHtml(doc.documentElement?.innerHTML ?? "");
}
