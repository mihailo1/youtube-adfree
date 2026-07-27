/**
 * Byte-range fetch for googlevideo from the extension page context.
 */

import { findInitEnd } from "./mp4-boxes";

export type RangeFetchResult = {
  bytes: Uint8Array;
  status: number;
  contentLength: number | null;
  contentRange: string | null;
};

export async function fetchByteRange(
  url: string,
  start: number,
  end: number | null,
  signal?: AbortSignal
): Promise<RangeFetchResult> {
  const rangeHeader = end == null ? `bytes=${start}-` : `bytes=${start}-${end}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Range: rangeHeader
    },
    credentials: "omit",
    signal
  });

  if (!(response.status === 206 || response.status === 200)) {
    throw new Error(`Range fetch failed HTTP ${response.status} for ${rangeHeader}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  const contentRange = response.headers.get("Content-Range");
  let contentLength: number | null = null;
  if (contentRange) {
    const match = /\/(\d+)\s*$/.exec(contentRange);
    if (match?.[1]) {
      contentLength = Number(match[1]);
    }
  }
  if (contentLength == null) {
    const headerLen = response.headers.get("Content-Length");
    if (headerLen && response.status === 200) {
      contentLength = Number(headerLen);
    }
  }

  return {
    bytes: buffer,
    status: response.status,
    contentLength,
    contentRange
  };
}

/** Probe total size via Range: bytes=0-0 */
export async function probeContentLength(url: string, signal?: AbortSignal): Promise<number> {
  const result = await fetchByteRange(url, 0, 0, signal);
  if (result.contentLength != null && Number.isFinite(result.contentLength)) {
    return result.contentLength;
  }
  // Fallback HEAD
  const head = await fetch(url, { method: "HEAD", credentials: "omit", signal });
  const len = head.headers.get("Content-Length");
  if (len) {
    return Number(len);
  }
  throw new Error("Could not determine content length");
}

export async function fetchInitSegment(
  url: string,
  log: (message: string) => void,
  signal?: AbortSignal
): Promise<{
  init: Uint8Array;
  initEnd: number;
  contentLength: number;
  /** First ~1MB after moov (for sidx probe); may be empty. */
  afterMoov: Uint8Array;
  afterMoovBase: number;
}> {
  const contentLength = await probeContentLength(url, signal);
  log(`content-length=${contentLength}`);

  // Grow window until moov is complete (typically <2MB)
  let windowSize = 256 * 1024;
  const maxWindow = Math.min(contentLength, 4 * 1024 * 1024);

  while (windowSize <= maxWindow) {
    const end = Math.min(windowSize - 1, contentLength - 1);
    const { bytes } = await fetchByteRange(url, 0, end, signal);
    const initEnd = findInitEnd(bytes);
    if (initEnd != null) {
      log(`init segment 0..${initEnd - 1} (${initEnd} bytes)`);
      // Extra window for sidx sitting after moov
      let afterMoov = bytes.byteLength > initEnd
        ? bytes.subarray(initEnd)
        : new Uint8Array(0);
      if (afterMoov.byteLength < 64 * 1024 && initEnd < contentLength - 1) {
        const sidxEnd = Math.min(contentLength - 1, initEnd + 1024 * 1024 - 1);
        const extra = await fetchByteRange(url, initEnd, sidxEnd, signal);
        afterMoov = extra.bytes;
      }
      return {
        init: bytes.subarray(0, initEnd),
        initEnd,
        contentLength,
        afterMoov,
        afterMoovBase: initEnd
      };
    }
    log(`moov not complete in first ${bytes.byteLength} bytes — growing`);
    windowSize *= 2;
  }

  throw new Error("Could not find complete moov in first 4MB");
}
