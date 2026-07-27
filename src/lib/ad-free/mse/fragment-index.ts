/**
 * Fragment time↔byte index for fMP4 (Phase 2).
 * Prefers ISO-BMFF `sidx` when present; otherwise a bitrate calibration from
 * observed (byte, PTS) samples after the first moof land.
 */

import { parseTopLevelBoxes, readBoxType, readU32 } from "./mp4-boxes";

export type FragmentIndexEntry = {
  /** Presentation time of segment start (seconds). */
  time: number;
  /** Segment duration (seconds). */
  duration: number;
  /** Absolute file offset of moof (or subsegment start). */
  offset: number;
  /** Byte length of this subsegment (moof+mdat). 0 if unknown. */
  size: number;
};

export type FragmentIndex = {
  source: "sidx" | "calibrated" | "linear";
  timescale: number;
  entries: FragmentIndexEntry[];
  /** Exclusive end of init (ftyp+moov [+sidx if folded into init]). */
  mediaStart: number;
  contentLength: number;
};

function readU64(view: DataView, offset: number): number {
  // Safe for file offsets / times that fit in 2^53
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  return high * 0x1_0000_0000 + low;
}

/**
 * Parse a single sidx box body (bytes after the 8/16-byte box header).
 * `boxFileStart` is the absolute file offset of the sidx box start.
 */
export function parseSidxBox(
  boxBytes: Uint8Array,
  boxFileStart: number,
  headerSize: number
): { timescale: number; entries: FragmentIndexEntry[] } | null {
  if (boxBytes.byteLength < headerSize + 12) {
    return null;
  }
  const view = new DataView(boxBytes.buffer, boxBytes.byteOffset, boxBytes.byteLength);
  const version = boxBytes[headerSize] ?? 0;
  let cursor = headerSize + 4; // skip fullbox version+flags

  if (cursor + 8 > boxBytes.byteLength) {
    return null;
  }
  // reference_ID
  cursor += 4;
  const timescale = readU32(view, cursor);
  cursor += 4;
  if (timescale <= 0) {
    return null;
  }

  let earliestPresentationTime: number;
  let firstOffset: number;
  if (version === 0) {
    if (cursor + 8 > boxBytes.byteLength) {
      return null;
    }
    earliestPresentationTime = readU32(view, cursor);
    cursor += 4;
    firstOffset = readU32(view, cursor);
    cursor += 4;
  } else {
    if (cursor + 16 > boxBytes.byteLength) {
      return null;
    }
    earliestPresentationTime = readU64(view, cursor);
    cursor += 8;
    firstOffset = readU64(view, cursor);
    cursor += 8;
  }

  if (cursor + 4 > boxBytes.byteLength) {
    return null;
  }
  // reserved (16) + reference_count (16)
  const referenceCount = view.getUint16(cursor + 2, false);
  cursor += 4;

  // first_offset is relative to the first byte after this sidx box
  const boxSize = boxBytes.byteLength;
  let segmentOffset = boxFileStart + boxSize + firstOffset;
  let timeUnits = earliestPresentationTime;
  const entries: FragmentIndexEntry[] = [];

  for (let index = 0; index < referenceCount; index += 1) {
    if (cursor + 12 > boxBytes.byteLength) {
      break;
    }
    const sizeAndType = readU32(view, cursor);
    cursor += 4;
    const referenceType = (sizeAndType >>> 31) & 1;
    const referencedSize = sizeAndType & 0x7fff_ffff;
    const subsegmentDuration = readU32(view, cursor);
    cursor += 4;
    // SAP fields
    cursor += 4;

    // reference_type 0 = media, 1 = nested sidx — still use for size walk
    void referenceType;

    const time = timeUnits / timescale;
    const duration = subsegmentDuration / timescale;
    entries.push({
      time,
      duration,
      offset: segmentOffset,
      size: referencedSize
    });
    segmentOffset += referencedSize;
    timeUnits += subsegmentDuration;
  }

  if (entries.length === 0) {
    return null;
  }
  return { timescale, entries };
}

/** Find and parse first top-level sidx in buffer starting at file offset baseOffset. */
export function findSidxInBuffer(
  bytes: Uint8Array,
  baseOffset: number
): { timescale: number; entries: FragmentIndexEntry[]; sidxEnd: number } | null {
  const boxes = parseTopLevelBoxes(bytes, baseOffset);
  for (const box of boxes) {
    if (box.type !== "sidx") {
      continue;
    }
    const relativeStart = box.start - baseOffset;
    if (relativeStart < 0 || relativeStart + box.size > bytes.byteLength) {
      // incomplete
      return null;
    }
    const boxBytes = bytes.subarray(relativeStart, relativeStart + box.size);
    const parsed = parseSidxBox(boxBytes, box.start, box.headerSize);
    if (!parsed) {
      continue;
    }
    return {
      timescale: parsed.timescale,
      entries: parsed.entries,
      sidxEnd: box.start + box.size
    };
  }
  return null;
}

/**
 * After moov, fetch a window and try to parse sidx. Returns null if absent.
 */
export async function tryBuildSidxIndex(params: {
  url: string;
  initEnd: number;
  contentLength: number;
  fetchRange: (start: number, end: number) => Promise<Uint8Array>;
  log?: (message: string, data?: unknown) => void;
}): Promise<FragmentIndex | null> {
  const { url, initEnd, contentLength, fetchRange, log } = params;
  void url;
  // sidx usually sits right after moov; allow up to 1MB
  const windowEnd = Math.min(contentLength - 1, initEnd + 1024 * 1024 - 1);
  if (windowEnd <= initEnd) {
    return null;
  }
  const bytes = await fetchRange(initEnd, windowEnd);
  // Re-base: buffer starts at initEnd
  const found = findSidxInBuffer(bytes, initEnd);
  if (!found) {
    // also try full buffer from 0 if caller passed init including moov only
    log?.("sidx not found after moov", { initEnd, window: bytes.byteLength });
    return null;
  }
  log?.("sidx index built", {
    entries: found.entries.length,
    firstTime: found.entries[0]?.time,
    lastTime: found.entries[found.entries.length - 1]?.time,
    timescale: found.timescale
  });
  return {
    source: "sidx",
    timescale: found.timescale,
    entries: found.entries,
    mediaStart: found.sidxEnd,
    contentLength
  };
}

/** Binary search: first entry with time + duration > target (segment covering target). */
export function lookupByteForTime(index: FragmentIndex, time: number): number {
  const entries = index.entries;
  if (entries.length === 0) {
    return index.mediaStart;
  }
  if (time <= (entries[0]?.time ?? 0)) {
    return entries[0]?.offset ?? index.mediaStart;
  }

  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = entries[mid];
    if (!entry) {
      break;
    }
    const end = entry.time + Math.max(entry.duration, 0.001);
    if (time < entry.time) {
      high = mid - 1;
    } else if (time >= end) {
      low = mid + 1;
    } else {
      return entry.offset;
    }
  }
  // Clamp to nearest earlier entry
  const clamped = Math.min(Math.max(low, 0), entries.length - 1);
  return entries[clamped]?.offset ?? index.mediaStart;
}

/**
 * Calibrated constant-bitrate map from one observed (byte, pts) sample.
 * More accurate than pure duration linear when first moof lands off-target.
 */
export function buildCalibratedIndex(params: {
  initEnd: number;
  contentLength: number;
  /** File offset where media was started (after moof align). */
  observedByte: number;
  /** Presentation time decoded at that offset. */
  observedTime: number;
  durationHint?: number;
}): FragmentIndex {
  const { initEnd, contentLength, observedByte, observedTime, durationHint } = params;
  const mediaBytes = Math.max(1, contentLength - initEnd);
  const safeTime = Math.max(observedTime, 0.5);
  const bytesPerSecond = Math.max(1, (observedByte - initEnd) / safeTime);

  // Virtual entries every ~2s for lookup convenience
  const duration = durationHint && durationHint > safeTime
    ? durationHint
    : safeTime + (contentLength - observedByte) / bytesPerSecond;
  const step = Math.max(2, duration / 500);
  const entries: FragmentIndexEntry[] = [];
  for (let time = 0; time < duration; time += step) {
    const offset = Math.min(
      contentLength - 1,
      Math.max(initEnd, Math.floor(initEnd + time * bytesPerSecond))
    );
    entries.push({
      time,
      duration: step,
      offset,
      size: 0
    });
  }
  // Anchor exact observed point
  entries.push({
    time: observedTime,
    duration: step,
    offset: observedByte,
    size: 0
  });
  entries.sort((left, right) => left.time - right.time);

  return {
    source: "calibrated",
    timescale: 1,
    entries,
    mediaStart: initEnd,
    contentLength
  };
}

export function buildLinearIndex(params: {
  initEnd: number;
  contentLength: number;
  duration: number;
}): FragmentIndex {
  const { initEnd, contentLength, duration } = params;
  const safeDuration = Math.max(duration, 1);
  const mediaBytes = Math.max(1, contentLength - initEnd);
  const step = Math.max(2, safeDuration / 500);
  const entries: FragmentIndexEntry[] = [];
  for (let time = 0; time <= safeDuration; time += step) {
    const ratio = Math.min(1, time / safeDuration);
    const offset = Math.floor(initEnd + mediaBytes * ratio);
    entries.push({
      time,
      duration: step,
      offset: Math.min(contentLength - 1, Math.max(initEnd, offset)),
      size: 0
    });
  }
  return {
    source: "linear",
    timescale: 1,
    entries,
    mediaStart: initEnd,
    contentLength
  };
}

/** True if buffer at file baseOffset looks like it starts with moof. */
export function startsWithMoof(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) {
    return false;
  }
  return readBoxType(bytes, 4) === "moof";
}
