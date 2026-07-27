/**
 * Ad-Free diagnostic logger.
 *
 * Console: filter by `[ytdl-af]`
 * Dump ring buffer: `window.__ytdlAfLog.dump()` / `.copy()` / `.clear()`
 * Toggle: `window.__ytdlAfLog.setEnabled(true|false)`
 * Levels: debug | info | warn | error
 *
 * Enabled by default in the player iframe; content script reads
 * `localStorage.ytdlAfDebug` ("0" to disable).
 */

export type AdFreeLogLevel = "debug" | "info" | "warn" | "error";

export type AdFreeLogEntry = {
  timestamp: number;
  iso: string;
  level: AdFreeLogLevel;
  scope: string;
  message: string;
  data?: unknown;
};

const RING_MAX = 800;
const PREFIX = "[ytdl-af]";

const LEVEL_RANK: Record<AdFreeLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

type LogApi = {
  enabled: boolean;
  minLevel: AdFreeLogLevel;
  entries: AdFreeLogEntry[];
  dump: () => AdFreeLogEntry[];
  text: () => string;
  copy: () => Promise<void>;
  clear: () => void;
  setEnabled: (value: boolean) => void;
  setMinLevel: (level: AdFreeLogLevel) => void;
};

function readEnabledDefault(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem("ytdlAfDebug");
    if (stored === "0" || stored === "false") {
      return false;
    }
    if (stored === "1" || stored === "true") {
      return true;
    }
  } catch {
    // ignore
  }
  // On by default so 1080p stalls are diagnosable without extra setup
  return true;
}

const ring: AdFreeLogEntry[] = [];
let isEnabled = readEnabledDefault();
let minLevel: AdFreeLogLevel = "debug";

function pushEntry(entry: AdFreeLogEntry) {
  ring.push(entry);
  if (ring.length > RING_MAX) {
    ring.splice(0, ring.length - RING_MAX);
  }
}

function toConsole(level: AdFreeLogLevel, line: string, data?: unknown) {
  const args = data === undefined ? [line] : [line, data];
  if (level === "error") {
    console.error(...args);
    return;
  }
  if (level === "warn") {
    console.warn(...args);
    return;
  }
  if (level === "info") {
    console.info(...args);
    return;
  }
  console.debug(...args);
}

export function adFreeLog(
  scope: string,
  message: string,
  data?: unknown,
  level: AdFreeLogLevel = "debug"
) {
  if (!isEnabled) {
    return;
  }
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
    return;
  }

  const now = Date.now();
  const entry: AdFreeLogEntry = {
    timestamp: now,
    iso: new Date(now).toISOString(),
    level,
    scope,
    message,
    data
  };
  pushEntry(entry);

  const line = `${PREFIX} ${scope} ${message}`;
  toConsole(level, line, data);
}

export function createAdFreeLogger(scope: string) {
  return {
    debug(message: string, data?: unknown) {
      adFreeLog(scope, message, data, "debug");
    },
    info(message: string, data?: unknown) {
      adFreeLog(scope, message, data, "info");
    },
    warn(message: string, data?: unknown) {
      adFreeLog(scope, message, data, "warn");
    },
    error(message: string, data?: unknown) {
      adFreeLog(scope, message, data, "error");
    },
    child(subScope: string) {
      return createAdFreeLogger(`${scope}:${subScope}`);
    }
  };
}

export function formatBuffered(media: HTMLMediaElement | null | undefined): string {
  if (!media) {
    return "none";
  }
  try {
    const ranges = media.buffered;
    if (!ranges || ranges.length === 0) {
      return "empty";
    }
    const parts: string[] = [];
    for (let index = 0; index < ranges.length; index += 1) {
      parts.push(`${ranges.start(index).toFixed(2)}-${ranges.end(index).toFixed(2)}`);
    }
    return parts.join(",");
  } catch {
    return "err";
  }
}

export function bufferAheadSeconds(media: HTMLMediaElement | null | undefined, atTime?: number): number {
  if (!media) {
    return 0;
  }
  try {
    const time = atTime ?? media.currentTime;
    const ranges = media.buffered;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);
      const end = ranges.end(index);
      if (time >= start - 0.15 && time <= end + 0.05) {
        return Math.max(0, end - time);
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

export function mediaSnapshot(media: HTMLMediaElement | null | undefined) {
  if (!media) {
    return null;
  }
  return {
    paused: media.paused,
    muted: media.muted,
    volume: media.volume,
    currentTime: Number(media.currentTime.toFixed(3)),
    readyState: media.readyState,
    networkState: media.networkState,
    ended: media.ended,
    seeking: media.seeking,
    error: media.error ? { code: media.error.code, message: media.error.message } : null,
    buffered: formatBuffered(media),
    ahead: Number(bufferAheadSeconds(media).toFixed(2)),
    src: media.currentSrc?.slice(0, 80) ?? media.src?.slice(0, 80) ?? ""
  };
}

function installGlobalApi() {
  const api: LogApi = {
    get enabled() {
      return isEnabled;
    },
    set enabled(value: boolean) {
      isEnabled = value;
    },
    get minLevel() {
      return minLevel;
    },
    set minLevel(value: AdFreeLogLevel) {
      minLevel = value;
    },
    get entries() {
      return ring.slice();
    },
    dump() {
      return ring.slice();
    },
    text() {
      return ring
        .map(entry => {
          const payload = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
          return `${entry.iso} ${entry.level.toUpperCase()} ${entry.scope} ${entry.message}${payload}`;
        })
        .join("\n");
    },
    async copy() {
      const body = api.text();
      try {
        await navigator.clipboard.writeText(body);
        console.info(`${PREFIX} log copied (${ring.length} entries)`);
      } catch (error) {
        console.warn(`${PREFIX} clipboard failed`, error);
        console.info(body);
      }
    },
    clear() {
      ring.length = 0;
    },
    setEnabled(value: boolean) {
      isEnabled = value;
      try {
        globalThis.localStorage?.setItem("ytdlAfDebug", value ? "1" : "0");
      } catch {
        // ignore
      }
      console.info(`${PREFIX} logging ${value ? "enabled" : "disabled"}`);
    },
    setMinLevel(level: AdFreeLogLevel) {
      minLevel = level;
    }
  };

  // Attach on every common global — extension contexts differ (window / globalThis / self)
  const hosts: unknown[] = [globalThis];
  try {
    if (typeof window !== "undefined") {
      hosts.push(window);
    }
  } catch {
    // ignore
  }
  try {
    if (typeof self !== "undefined") {
      hosts.push(self);
    }
  } catch {
    // ignore
  }

  for (const host of hosts) {
    if (!host || (typeof host !== "object" && typeof host !== "function")) {
      continue;
    }
    try {
      Object.defineProperty(host, "__ytdlAfLog", {
        value: api,
        configurable: true,
        writable: true,
        enumerable: false
      });
    } catch {
      // ignore
    }
  }

  console.info(
    `${PREFIX} log API ready — in DevTools pick the ad-free-player iframe context, then: __ytdlAfLog.copy()`
  );
}

installGlobalApi();

export function getAdFreeLogText(): string {
  return ring
    .map(entry => {
      const payload = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
      return `${entry.iso} ${entry.level.toUpperCase()} ${entry.scope} ${entry.message}${payload}`;
    })
    .join("\n");
}
