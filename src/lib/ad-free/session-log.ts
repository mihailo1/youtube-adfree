/**
 * Chrome-session diagnostic log (in-memory, lives in the background SW).
 * Survives content/player reloads; cleared when the browser session ends
 * (or when the user hits Clear in Settings).
 */

export type SessionLogLevel = "debug" | "info" | "warn" | "error";

export type SessionLogEntry = {
  timestamp: number;
  iso: string;
  level: SessionLogLevel;
  scope: string;
  message: string;
  /** Compact JSON string (already truncated at the source). */
  data?: string;
  /** Origin context: watch | player | background | popup | unknown */
  context?: string;
};

const RING_MAX = 2_000;

let sessionStartedAt = Date.now();
const ring: SessionLogEntry[] = [];

function ensureSessionClock() {
  if (ring.length === 0 && sessionStartedAt <= 0) {
    sessionStartedAt = Date.now();
  }
}

export function appendSessionLog(entry: SessionLogEntry) {
  ensureSessionClock();
  ring.push(entry);
  if (ring.length > RING_MAX) {
    ring.splice(0, ring.length - RING_MAX);
  }
}

export function clearSessionLog() {
  ring.length = 0;
  sessionStartedAt = Date.now();
}

export function getSessionLogCount(): number {
  return ring.length;
}

export function getSessionStartedAt(): number {
  return sessionStartedAt;
}

export function formatSessionLogText(meta?: {
  version?: string;
  userAgent?: string;
}): string {
  const started = new Date(sessionStartedAt).toISOString();
  const exported = new Date().toISOString();
  const header = [
    "YouTube Ad-Free — session diagnostic log",
    `version: ${meta?.version ?? "?"}`,
    `sessionStarted: ${started}`,
    `exported: ${exported}`,
    `entries: ${ring.length}`,
    meta?.userAgent ? `userAgent: ${meta.userAgent}` : null,
    "---"
  ]
    .filter(Boolean)
    .join("\n");

  const body = ring
    .map(entry => {
      const ctx = entry.context ? ` [${entry.context}]` : "";
      const payload = entry.data ? ` ${entry.data}` : "";
      return `${entry.iso} ${entry.level.toUpperCase().padEnd(5)} ${entry.scope}${ctx} ${entry.message}${payload}`;
    })
    .join("\n");

  return body ? `${header}\n${body}\n` : `${header}\n(no entries yet)\n`;
}

export function getSessionLogSnapshot(meta?: {
  version?: string;
  userAgent?: string;
}): {
  text: string;
  count: number;
  sessionStarted: number;
} {
  return {
    text: formatSessionLogText(meta),
    count: ring.length,
    sessionStarted: sessionStartedAt
  };
}

/** Truncate arbitrary log data for storage / export. */
export function compactLogData(data: unknown, maxLen = 400): string | undefined {
  if (data === undefined) {
    return undefined;
  }
  try {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    if (raw.length <= maxLen) {
      return raw;
    }
    return `${raw.slice(0, maxLen)}…`;
  } catch {
    const fallback = String(data);
    return fallback.length <= maxLen ? fallback : `${fallback.slice(0, maxLen)}…`;
  }
}

export function detectLogContext(): string {
  try {
    const href = globalThis.location?.href ?? "";
    if (href.includes("ad-free-player")) {
      return "player";
    }
    if (href.includes("chrome-extension://") || href.includes("moz-extension://")) {
      if (href.includes("popup")) {
        return "popup";
      }
      return "extension";
    }
    if (href.includes("youtube.com")) {
      return "watch";
    }
  } catch {
    // ignore
  }
  try {
    // Service worker / background has no useful location
    if (typeof document === "undefined") {
      return "background";
    }
  } catch {
    // ignore
  }
  return "unknown";
}
