import {
  appendSessionLog,
  clearSessionLog,
  getSessionLogSnapshot,
  type SessionLogEntry
} from "@/lib/ad-free/session-log";
import { setAdFreeSessionLogSink } from "@/lib/ad-free/debug-log";
import { MessageType, onMessage } from "@/lib/messaging/messaging";

function meta() {
  let version = "?";
  try {
    version = browser.runtime.getManifest().version;
  } catch {
    // ignore
  }
  let userAgent = "";
  try {
    userAgent = navigator.userAgent;
  } catch {
    // ignore
  }
  return { version, userAgent };
}

export function registerSessionLogHandlers() {
  // Logs produced inside the SW append directly (no self-messaging).
  setAdFreeSessionLogSink(entry => {
    appendSessionLog(toSessionEntry(entry));
  });

  onMessage(MessageType.AdFreeLogAppend, ({ data }) => {
    if (!data?.entry) {
      return;
    }
    appendSessionLog(data.entry as SessionLogEntry);
  });

  onMessage(MessageType.AdFreeLogGet, () => getSessionLogSnapshot(meta()));

  onMessage(MessageType.AdFreeLogClear, () => {
    clearSessionLog();
  });

  appendSessionLog({
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    level: "info",
    scope: "session",
    message: "background ready",
    data: compactMeta(),
    context: "background"
  });
}

function compactMeta(): string | undefined {
  try {
    return JSON.stringify({ version: browser.runtime.getManifest().version });
  } catch {
    return undefined;
  }
}

function toSessionEntry(entry: {
  timestamp: number;
  iso: string;
  level: SessionLogEntry["level"];
  scope: string;
  message: string;
  data?: unknown;
  context?: string;
}): SessionLogEntry {
  let data: string | undefined;
  if (typeof entry.data === "string") {
    data = entry.data;
  } else if (entry.data !== undefined) {
    try {
      data = JSON.stringify(entry.data);
    } catch {
      data = String(entry.data);
    }
  }
  return {
    timestamp: entry.timestamp,
    iso: entry.iso,
    level: entry.level,
    scope: entry.scope,
    message: entry.message,
    data,
    context: entry.context ?? "background"
  };
}
