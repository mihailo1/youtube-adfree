/**
 * Ad-Free diagnostic logger (alpha-friendly).
 *
 * - Default level: **info** (debug is silent unless raised)
 * - Ring buffer in each context + forward to background **session log**
 * - Export from popup Settings → Diagnostics
 * - DevTools (optional): `__ytdlAfLog.copy()` / `.dump()` / `.clear()`
 *
 * Console filter: `[ytdl-af]`
 */

import {
  compactLogData,
  detectLogContext,
  type SessionLogEntry,
  type SessionLogLevel
} from "@/lib/ad-free/session-log";
import { MessageType, sendMessage } from "@/lib/messaging/messaging";

export type AdFreeLogLevel = SessionLogLevel;

export type AdFreeLogEntry = {
  timestamp: number;
  iso: string;
  level: AdFreeLogLevel;
  scope: string;
  message: string;
  data?: unknown;
  context?: string;
};

const RING_MAX = 400;
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
  // On for alpha diagnostics (session export)
  return true;
}

const ring: AdFreeLogEntry[] = [];
let isEnabled = readEnabledDefault();
/** Alpha default: info — skip noisy debug chatter. */
let minLevel: AdFreeLogLevel = "info";
const logContext = detectLogContext();

/** Background SW installs this so logs never self-message. */
let sessionSink: ((entry: SessionLogEntry) => void) | null = null;

export function setAdFreeSessionLogSink(
  sink: ((entry: SessionLogEntry) => void) | null
) {
  sessionSink = sink;
}

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

function forwardToSession(entry: AdFreeLogEntry) {
  const sessionEntry: SessionLogEntry = {
    timestamp: entry.timestamp,
    iso: entry.iso,
    level: entry.level,
    scope: entry.scope,
    message: entry.message,
    data: compactLogData(entry.data),
    context: entry.context ?? logContext
  };

  if (sessionSink) {
    sessionSink(sessionEntry);
    return;
  }

  try {
    void sendMessage(MessageType.AdFreeLogAppend, { entry: sessionEntry }).catch(() => {
      // SW sleeping / no receiver — local ring still has the line
    });
  } catch {
    // ignore
  }
}

export function adFreeLog(
  scope: string,
  message: string,
  data?: unknown,
  level: AdFreeLogLevel = "info"
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
    data,
    context: logContext
  };
  pushEntry(entry);
  forwardToSession(entry);

  // Console: short line; data only for warn/error to keep DevTools calm
  const line = `${PREFIX} ${scope}: ${message}`;
  if (level === "warn" || level === "error") {
    toConsole(level, line, data);
  } else if (data === undefined) {
    toConsole(level, line);
  } else {
    toConsole(level, line, data);
  }
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

function formatRingText(): string {
  return ring
    .map(entry => {
      const payload = entry.data === undefined ? "" : ` ${compactLogData(entry.data) ?? ""}`;
      return `${entry.iso} ${entry.level.toUpperCase()} ${entry.scope} ${entry.message}${payload}`;
    })
    .join("\n");
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
      return formatRingText();
    },
    async copy() {
      const body = api.text();
      try {
        await navigator.clipboard.writeText(body);
        console.info(`${PREFIX} local log copied (${ring.length} lines)`);
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
      console.info(`${PREFIX} logging ${value ? "on" : "off"}`);
    },
    setMinLevel(level: AdFreeLogLevel) {
      minLevel = level;
    }
  };

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
}

installGlobalApi();

export function getAdFreeLogText(): string {
  return formatRingText();
}
