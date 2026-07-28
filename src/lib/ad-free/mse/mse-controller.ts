/**
 * Production MSE dual-track controller (Phase 1–2).
 * fMP4 (ANDROID_VR adaptive): init (ftyp+moov) + moof/mdat via byte-range append.
 * Phase 2: sidx / calibrated time↔byte index, incremental rebuffer with full-reload fallback.
 */

import {
  buildCalibratedIndex,
  buildLinearIndex,
  findSidxInBuffer,
  type FragmentIndex,
  lookupByteForTime
} from "./fragment-index";
import { findMoofOffsetInBuffer, formatBytes } from "./mp4-boxes";
import { fetchByteRange, fetchInitSegment } from "./range-fetch";

export type SpikeTrack = {
  label: string;
  url: string;
  mimeType: string;
  height?: number;
  bitrate?: number;
};

export type SpikePlayerOptions = {
  elVideo: HTMLVideoElement;
  video: SpikeTrack;
  audio: SpikeTrack;
  durationHint?: number;
  /** Start playback near this time (seconds). 0 = from beginning. */
  startAt: number;
  log: (message: string, data?: unknown) => void;
  onState?: (state: string) => void;
  /**
   * When true (default), scrub on the video element rebuffers automatically.
   * Set false when PlaybackEngine owns seek (avoids double rebuffer).
   */
  handleUserSeek?: boolean;
  /**
   * When false, leave play() to the engine (avoids busy re-pause flap).
   * Default true for spike harness.
   */
  autoplay?: boolean;
};

export const MSE_RELOAD_REQUIRED = "MSE_RELOAD_REQUIRED";

export type MseSessionHandle = {
  stop: () => void;
  /** Rebuffer both tracks around wall-clock time (user/engine seek). */
  seek: (time: number) => Promise<void>;
  getStats: () => {
    videoBuffered: string;
    audioBuffered: string;
    videoFetched: number;
    audioFetched: number;
  };
};

/** @deprecated use MseSessionHandle */
export type SpikePlayerHandle = MseSessionHandle;

const CHUNK = 512 * 1024;
const TARGET_AHEAD_S = 12;
const PLAY_AHEAD_S = 3;
/** Max bytes to scan forward from linear estimate to find a moof. */
const MOOF_SCAN_MAX = 8 * 1024 * 1024;
const MOOF_SCAN_WINDOW = 1024 * 1024;
/** First mid-seek video pull — stop as soon as any buffer lands. */
const MID_FIRST_VIDEO_CHUNKS = 6;
/** After first buffer / audio sync, fill a short playable window. */
const MID_FILL_CHUNKS = 12;
/** Audio re-anchor prefetch per attempt (coverTime + minAhead stop early). */
const MID_PREFETCH_AUDIO = 10;
/** 2160p needs more than 6×512KB before first playable second (~0.7s was causing underrun flash). */
const START_PREFETCH_VIDEO = 14;
const START_PREFETCH_AUDIO = 6;
/** Audio re-anchor attempts when A/V timestamps miss each other. */
const AUDIO_SYNC_ATTEMPTS = 6;

/** Cache ftyp+moov (+sidx probe window) across full MediaSource reloads (same quality seek). */
type CachedInit = Awaited<ReturnType<typeof fetchInitSegment>>;
const initSegmentCache = new Map<string, CachedInit>();
const INIT_CACHE_MAX = 6;

async function fetchInitSegmentCached(
  url: string,
  logLine: (message: string) => void,
  signal: AbortSignal
): Promise<CachedInit> {
  const hit = initSegmentCache.get(url);
  if (hit) {
    logLine("init segment cache hit");
    return hit;
  }
  const result = await fetchInitSegment(url, logLine, signal);
  initSegmentCache.set(url, result);
  while (initSegmentCache.size > INIT_CACHE_MAX) {
    const oldest = initSegmentCache.keys().next().value;
    if (oldest == null) {
      break;
    }
    initSegmentCache.delete(oldest);
  }
  return result;
}

function indexEndTime(index: FragmentIndex): number {
  const last = index.entries[index.entries.length - 1];
  if (!last) {
    return 0;
  }
  return last.time + Math.max(0, last.duration);
}

function fullMime(track: SpikeTrack): string {
  return track.mimeType.split(" ").join("");
}

function formatBufferedRanges(ranges: TimeRanges): string {
  if (!ranges.length) {
    return "empty";
  }
  const parts: string[] = [];
  for (let index = 0; index < ranges.length; index += 1) {
    parts.push(`${ranges.start(index).toFixed(1)}-${ranges.end(index).toFixed(1)}`);
  }
  return parts.join(",");
}

function formatBuffered(media: HTMLMediaElement): string {
  try {
    return formatBufferedRanges(media.buffered);
  } catch {
    return "err";
  }
}

function formatSbBuffered(sourceBuffer: SourceBuffer): string {
  try {
    return formatBufferedRanges(sourceBuffer.buffered);
  } catch {
    return "err";
  }
}

function bufferAheadAt(ranges: TimeRanges, time: number): number {
  try {
    for (let index = 0; index < ranges.length; index += 1) {
      if (time >= ranges.start(index) - 0.25 && time <= ranges.end(index)) {
        return ranges.end(index) - time;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

function bufferAhead(media: HTMLMediaElement): number {
  try {
    return bufferAheadAt(media.buffered, media.currentTime);
  } catch {
    return 0;
  }
}

function sourceBufferAhead(sourceBuffer: SourceBuffer, time: number): number {
  return bufferAheadAt(sourceBuffer.buffered, time);
}

function firstBufferedStart(sourceBuffer: SourceBuffer): number | null {
  try {
    if (!sourceBuffer.buffered.length) {
      return null;
    }
    return sourceBuffer.buffered.start(0);
  } catch {
    return null;
  }
}

function firstBufferedEnd(sourceBuffer: SourceBuffer): number | null {
  try {
    if (!sourceBuffer.buffered.length) {
      return null;
    }
    return sourceBuffer.buffered.end(0);
  } catch {
    return null;
  }
}

/** True if any interval of left overlaps any of right. */
function rangesOverlap(left: TimeRanges, right: TimeRanges): boolean {
  try {
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const leftStart = left.start(leftIndex);
      const leftEnd = left.end(leftIndex);
      for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
        const rightStart = right.start(rightIndex);
        const rightEnd = right.end(rightIndex);
        if (leftStart < rightEnd && rightStart < leftEnd) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * True when A/V ranges touch or leave a tiny gap (common after parallel sidx land:
 * video 1983–1986.9, audio 1986.9–2051 — point-touch fails strict overlap).
 */
function rangesNearlyContinuous(
  left: TimeRanges,
  right: TimeRanges,
  slackS = 1.5
): boolean {
  if (rangesOverlap(left, right)) {
    return true;
  }
  try {
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const leftStart = left.start(leftIndex);
      const leftEnd = left.end(leftIndex);
      for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
        const rightStart = right.start(rightIndex);
        const rightEnd = right.end(rightIndex);
        const gap = Math.max(leftStart, rightStart) - Math.min(leftEnd, rightEnd);
        // gap ≤ 0 ⇒ overlap/touch; small positive ⇒ nearly continuous
        if (gap <= slackS) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Earliest time covered by both tracks (approx intersection start). */
function overlapStart(videoSb: SourceBuffer, audioSb: SourceBuffer): number | null {
  try {
    const video = videoSb.buffered;
    const audio = audioSb.buffered;
    let best: number | null = null;
    for (let videoIndex = 0; videoIndex < video.length; videoIndex += 1) {
      const videoStart = video.start(videoIndex);
      const videoEnd = video.end(videoIndex);
      for (let audioIndex = 0; audioIndex < audio.length; audioIndex += 1) {
        const audioStart = audio.start(audioIndex);
        const audioEnd = audio.end(audioIndex);
        const start = Math.max(videoStart, audioStart);
        const end = Math.min(videoEnd, audioEnd);
        if (end - start > 0.05) {
          if (best == null || start < best) {
            best = start;
          }
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

function coversTime(sourceBuffer: SourceBuffer, time: number): boolean {
  return bufferAheadAt(sourceBuffer.buffered, time) > 0
    || (() => {
      try {
        const ranges = sourceBuffer.buffered;
        for (let index = 0; index < ranges.length; index += 1) {
          if (time >= ranges.start(index) - 0.05 && time < ranges.end(index)) {
            return true;
          }
        }
      } catch {
        // ignore
      }
      return false;
    })();
}

function isQuotaExceeded(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return true;
  }
  return String(error).includes("QuotaExceededError");
}

function waitUpdating(sourceBuffer: SourceBuffer): Promise<void> {
  if (!sourceBuffer.updating) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    sourceBuffer.addEventListener("updateend", () => resolve(), { once: true });
  });
}

async function appendChunk(sourceBuffer: SourceBuffer, data: Uint8Array): Promise<void> {
  await waitUpdating(sourceBuffer);
  await new Promise<void>((resolve, reject) => {
    function onEnd() {
      cleanup();
      resolve();
    }
    function onError() {
      cleanup();
      reject(new Error("SourceBuffer error"));
    }
    function cleanup() {
      sourceBuffer.removeEventListener("updateend", onEnd);
      sourceBuffer.removeEventListener("error", onError);
    }
    sourceBuffer.addEventListener("updateend", onEnd);
    sourceBuffer.addEventListener("error", onError);
    try {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      sourceBuffer.appendBuffer(copy);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function evictBefore(
  sourceBuffer: SourceBuffer,
  currentTime: number,
  log: (message: string, data?: unknown) => void,
  label: string
): Promise<boolean> {
  try {
    const ranges = sourceBuffer.buffered;
    if (!ranges.length) {
      return false;
    }
    const keepFrom = Math.max(0, currentTime - 2);
    let removed = false;
    for (let index = 0; index < ranges.length; index += 1) {
      const rangeStart = ranges.start(index);
      const rangeEnd = ranges.end(index);
      if (rangeEnd <= keepFrom) {
        await waitUpdating(sourceBuffer);
        sourceBuffer.remove(rangeStart, rangeEnd);
        await waitUpdating(sourceBuffer);
        removed = true;
      } else if (rangeStart < keepFrom && rangeEnd > keepFrom) {
        await waitUpdating(sourceBuffer);
        sourceBuffer.remove(rangeStart, keepFrom);
        await waitUpdating(sourceBuffer);
        removed = true;
      }
    }
    if (removed) {
      log(`${label} evicted buffer before t=${keepFrom.toFixed(1)}`);
    }
    return removed;
  } catch (error) {
    log(`${label} evict failed`, String(error));
    return false;
  }
}

async function clearBuffered(
  sourceBuffer: SourceBuffer,
  log: (message: string, data?: unknown) => void,
  label: string
): Promise<void> {
  try {
    const ranges = sourceBuffer.buffered;
    if (!ranges.length) {
      return;
    }
    const removeEnd = ranges.end(ranges.length - 1) + 1;
    await waitUpdating(sourceBuffer);
    sourceBuffer.remove(0, removeEnd);
    await waitUpdating(sourceBuffer);
    log(`${label} cleared buffered`);
  } catch (error) {
    log(`${label} clear failed`, String(error));
  }
}

/**
 * Walk forward from a linear byte estimate until a top-level moof header is found.
 */
async function alignToNextMoof(
  url: string,
  estimate: number,
  contentLength: number,
  initEnd: number,
  signal: AbortSignal,
  log: (message: string, data?: unknown) => void,
  label: string
): Promise<number> {
  if (estimate <= initEnd) {
    return initEnd;
  }

  let cursor = Math.min(contentLength - 1, Math.max(initEnd, estimate));
  const scanLimit = Math.min(contentLength, estimate + MOOF_SCAN_MAX);

  while (cursor < scanLimit) {
    if (signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const end = Math.min(cursor + MOOF_SCAN_WINDOW - 1, contentLength - 1);
    const { bytes } = await fetchByteRange(url, cursor, end, signal);
    const relative = findMoofOffsetInBuffer(bytes);
    if (relative != null) {
      const absolute = cursor + relative;
      log(`${label} moof align`, {
        estimate,
        moof: absolute,
        delta: absolute - estimate,
        window: `${cursor}-${end}`
      });
      return absolute;
    }
    const next = end + 1 - 7;
    if (next <= cursor) {
      break;
    }
    cursor = next;
  }

  throw new Error(
    `${label}: no moof within ${formatBytes(MOOF_SCAN_MAX)} after linear estimate ${estimate}`
  );
}

function waitSeeked(elVideo: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (!elVideo.seeking) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const timer = window.setTimeout(() => {
      elVideo.removeEventListener("seeked", onSeeked);
      resolve();
    }, timeoutMs);
    function onSeeked() {
      window.clearTimeout(timer);
      elVideo.removeEventListener("seeked", onSeeked);
      resolve();
    }
    elVideo.addEventListener("seeked", onSeeked);
  });
}

type TrackPump = {
  nextByte: number;
  contentLength: number;
  initEnd: number;
  fetched: number;
  done: boolean;
};

export async function startMseSession(options: SpikePlayerOptions): Promise<MseSessionHandle> {
  const {
    elVideo,
    video,
    audio,
    startAt,
    log,
    onState,
    durationHint,
    handleUserSeek = true,
    autoplay = true
  } = options;
  const abort = new AbortController();

  const videoMime = fullMime(video);
  const audioMime = fullMime(audio);

  log("codec check", {
    video: videoMime,
    videoOk: MediaSource.isTypeSupported(videoMime),
    audio: audioMime,
    audioOk: MediaSource.isTypeSupported(audioMime)
  });

  if (!MediaSource.isTypeSupported(videoMime)) {
    throw new Error(`Video type not supported: ${videoMime}`);
  }
  if (!MediaSource.isTypeSupported(audioMime)) {
    throw new Error(`Audio type not supported: ${audioMime}`);
  }

  onState?.("fetch-init");
  log("fetching video+audio init…");
  const [videoInit, audioInit] = await Promise.all([
    fetchInitSegmentCached(video.url, message => log(`video ${message}`), abort.signal),
    fetchInitSegmentCached(audio.url, message => log(`audio ${message}`), abort.signal)
  ]);

  const duration = durationHint && durationHint > 0 ? durationHint : 0;

  function buildIndexFromInit(
    label: string,
    initEnd: number,
    contentLength: number,
    afterMoov: Uint8Array,
    afterMoovBase: number
  ): FragmentIndex {
    if (afterMoov.byteLength > 0) {
      const sidx = findSidxInBuffer(afterMoov, afterMoovBase);
      if (sidx) {
        log(`${label} sidx index`, {
          entries: sidx.entries.length,
          first: sidx.entries[0]?.time,
          last: sidx.entries[sidx.entries.length - 1]?.time
        });
        return {
          source: "sidx",
          timescale: sidx.timescale,
          entries: sidx.entries,
          mediaStart: sidx.sidxEnd,
          contentLength
        };
      }
    }
    if (duration > 0) {
      log(`${label} linear index (no sidx)`, { duration, initEnd });
      return buildLinearIndex({ initEnd, contentLength, duration });
    }
    return buildLinearIndex({ initEnd, contentLength, duration: 1 });
  }

  let videoIndex = buildIndexFromInit(
    "video",
    videoInit.initEnd,
    videoInit.contentLength,
    videoInit.afterMoov,
    videoInit.afterMoovBase
  );
  let audioIndex = buildIndexFromInit(
    "audio",
    audioInit.initEnd,
    audioInit.contentLength,
    audioInit.afterMoov,
    audioInit.afterMoovBase
  );

  function timeToMediaByte(
    time: number,
    contentLength: number,
    initEnd: number,
    index: FragmentIndex
  ): number {
    if (time <= 0) {
      return initEnd;
    }
    if (index.entries.length > 0) {
      const offset = lookupByteForTime(index, time);
      return Math.min(contentLength - 1, Math.max(initEnd, offset));
    }
    if (duration <= 0) {
      return initEnd;
    }
    const mediaBytes = Math.max(0, contentLength - initEnd);
    const ratio = Math.min(1, Math.max(0, time / duration));
    return Math.min(contentLength - 1, initEnd + Math.floor(mediaBytes * ratio));
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  elVideo.src = objectUrl;

  await new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
    mediaSource.addEventListener("error", () => reject(new Error("MediaSource error")), { once: true });
  });

  log("MediaSource open");
  onState?.("sourceopen");

  // Without duration, Chrome/Vidstack often snap currentTime→0 on play when
  // only mid-file ranges are buffered (stuck seeking at t=0, buffer at 1h+).
  const sidxDuration = Math.max(
    indexEndTime(videoIndex),
    indexEndTime(audioIndex)
  );
  const effectiveDuration = Math.max(duration, sidxDuration);
  if (effectiveDuration > 0 && Number.isFinite(effectiveDuration)) {
    try {
      mediaSource.duration = effectiveDuration;
      log("MediaSource duration set", {
        duration: effectiveDuration,
        fromHint: duration,
        fromSidx: sidxDuration
      });
    } catch (error) {
      log("MediaSource duration set failed", String(error));
    }
  }

  const videoSb = mediaSource.addSourceBuffer(videoMime);
  const audioSb = mediaSource.addSourceBuffer(audioMime);
  videoSb.mode = "segments";
  audioSb.mode = "segments";

  log("appending init segments…");
  await appendChunk(videoSb, videoInit.init);
  await appendChunk(audioSb, audioInit.init);
  log("init appended", {
    videoInit: formatBytes(videoInit.init.byteLength),
    audioInit: formatBytes(audioInit.init.byteLength),
    mode: "segments",
    videoIndex: videoIndex.source,
    audioIndex: audioIndex.source
  });

  const estimateVideo = timeToMediaByte(
    startAt,
    videoInit.contentLength,
    videoInit.initEnd,
    videoIndex
  );
  const estimateAudio = timeToMediaByte(
    startAt,
    audioInit.contentLength,
    audioInit.initEnd,
    audioIndex
  );

  log("media start bytes", {
    startAt,
    duration,
    videoByte: estimateVideo,
    audioByte: estimateAudio,
    videoIndex: videoIndex.source,
    audioIndex: audioIndex.source
  });

  let startByteVideo = estimateVideo;
  let startByteAudio = estimateAudio;

  if (startAt > 0.5) {
    onState?.("moof-align");
    // sidx offsets already point at subsegment (moof) starts — skip the 1MB probe.
    const needVideoAlign = videoIndex.source !== "sidx";
    const needAudioAlign = audioIndex.source !== "sidx";
    if (!needVideoAlign && !needAudioAlign) {
      log("moof align skipped (sidx)", {
        videoByte: startByteVideo,
        audioByte: startByteAudio
      });
    } else {
      const [alignedVideo, alignedAudio] = await Promise.all([
        needVideoAlign
          ? alignToNextMoof(
            video.url,
            estimateVideo,
            videoInit.contentLength,
            videoInit.initEnd,
            abort.signal,
            log,
            "video"
          )
          : Promise.resolve(estimateVideo),
        needAudioAlign
          ? alignToNextMoof(
            audio.url,
            estimateAudio,
            audioInit.contentLength,
            audioInit.initEnd,
            abort.signal,
            log,
            "audio"
          )
          : Promise.resolve(estimateAudio)
      ]);
      startByteVideo = alignedVideo;
      startByteAudio = alignedAudio;
    }
  }

  const videoPump: TrackPump = {
    nextByte: startByteVideo,
    contentLength: videoInit.contentLength,
    initEnd: videoInit.initEnd,
    fetched: videoInit.init.byteLength,
    done: startByteVideo >= videoInit.contentLength
  };
  const audioPump: TrackPump = {
    nextByte: startByteAudio,
    contentLength: audioInit.contentLength,
    initEnd: audioInit.initEnd,
    fetched: audioInit.init.byteLength,
    done: startByteAudio >= audioInit.contentLength
  };

  let stopped = false;
  /** Pause sequential pumps while rebuffering around a seek. */
  let pumpsPaused = false;
  let rebufferBusy = false;
  /** Ignore seeked events from our own programmatic seeks. */
  let suppressUserSeek = true;

  function throwIfStopped(): void {
    if (stopped || abort.signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
  }

  async function appendWithEvict(
    label: string,
    sourceBuffer: SourceBuffer,
    bytes: Uint8Array
  ): Promise<void> {
    throwIfStopped();
    try {
      await appendChunk(sourceBuffer, bytes);
      return;
    } catch (error) {
      if (stopped || abort.signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      if (String(error).includes("removed from the parent media source")) {
        throw new DOMException("aborted", "AbortError");
      }
      if (!isQuotaExceeded(error)) {
        throw error;
      }
      log(`${label} QuotaExceeded — trying evict`);
      const freed = await evictBefore(sourceBuffer, elVideo.currentTime, log, label);
      if (!freed) {
        throw error;
      }
      throwIfStopped();
      await appendChunk(sourceBuffer, bytes);
    }
  }

  type PrefetchOpts = {
    maxChunks: number;
    /** Keep appending until buffer covers this time with this many seconds ahead. */
    coverTime?: number;
    minAhead?: number;
    /** Stop as soon as any buffered range exists (start-from-0). */
    stopOnFirstBuffer?: boolean;
  };

  async function prefetchTrack(
    label: string,
    url: string,
    sourceBuffer: SourceBuffer,
    pump: TrackPump,
    opts: PrefetchOpts
  ): Promise<void> {
    for (let index = 0; index < opts.maxChunks && !pump.done && !stopped; index += 1) {
      throwIfStopped();
      const start = pump.nextByte;
      if (start >= pump.contentLength) {
        pump.done = true;
        break;
      }
      const end = Math.min(start + CHUNK - 1, pump.contentLength - 1);
      const { bytes } = await fetchByteRange(url, start, end, abort.signal);
      await appendWithEvict(label, sourceBuffer, bytes);
      pump.nextByte = start + bytes.byteLength;
      pump.fetched += bytes.byteLength;
      if (bytes.byteLength === 0) {
        pump.done = true;
      }

      if (opts.stopOnFirstBuffer && sourceBuffer.buffered.length > 0) {
        break;
      }
      if (opts.coverTime != null) {
        const ahead = sourceBufferAhead(sourceBuffer, opts.coverTime);
        const minAhead = opts.minAhead ?? PLAY_AHEAD_S;
        if (coversTime(sourceBuffer, opts.coverTime) && ahead >= minAhead) {
          break;
        }
      }
    }
  }

  async function pumpTrack(
    label: string,
    url: string,
    sourceBuffer: SourceBuffer,
    pump: TrackPump,
    prefer: boolean
  ): Promise<void> {
    while (!stopped && !abort.signal.aborted && !pump.done) {
      if (pumpsPaused || rebufferBusy) {
        await new Promise(resolve => window.setTimeout(resolve, 80));
        continue;
      }

      const time = elVideo.currentTime;
      const videoAhead = sourceBufferAhead(videoSb, time);
      const trackAhead = sourceBufferAhead(sourceBuffer, time);

      if (!prefer && videoAhead < 2) {
        await new Promise(resolve => window.setTimeout(resolve, 50));
        continue;
      }

      if (trackAhead >= TARGET_AHEAD_S) {
        await new Promise(resolve => window.setTimeout(resolve, 200));
        continue;
      }

      // Gap at playhead — user seek rebuffer handles big jumps; wait here
      if (bufferAhead(elVideo) < 0.05 && sourceBuffer.buffered.length > 0) {
        await new Promise(resolve => window.setTimeout(resolve, 100));
        continue;
      }

      if (sourceBuffer.buffered.length === 0) {
        await new Promise(resolve => window.setTimeout(resolve, 200));
        continue;
      }

      const start = pump.nextByte;
      if (start >= pump.contentLength) {
        pump.done = true;
        break;
      }
      const end = Math.min(start + CHUNK - 1, pump.contentLength - 1);

      try {
        const { bytes } = await fetchByteRange(url, start, end, abort.signal);
        await appendWithEvict(label, sourceBuffer, bytes);
        pump.nextByte = start + bytes.byteLength;
        pump.fetched += bytes.byteLength;
        if (bytes.byteLength === 0) {
          pump.done = true;
        }
      } catch (error) {
        if (abort.signal.aborted || stopped) {
          return;
        }
        if (String(error).includes("removed from the parent media source")
          || String(error).includes("AbortError")) {
          return;
        }
        log(`${label} pump error`, { error: String(error), start, end });
        if (isQuotaExceeded(error)) {
          await new Promise(resolve => window.setTimeout(resolve, 1500));
        } else {
          await new Promise(resolve => window.setTimeout(resolve, 500));
        }
      }
    }
  }

  /**
   * Build ordered byte candidates for audio so we cover `targetTime`.
   * sidx offsets are moof-aligned — never apply the old 2% linear bias
   * (that walked ~3MB earlier and left SourceBuffer empty mid-seek).
   */
  function audioSyncByteCandidates(targetTime: number): number[] {
    const clamp = (byte: number) => Math.min(
      audioInit.contentLength - 1,
      Math.max(audioInit.initEnd, byte)
    );
    const out: number[] = [];
    const push = (byte: number) => {
      const value = clamp(byte);
      if (!out.includes(value)) {
        out.push(value);
      }
    };

    push(timeToMediaByte(
      targetTime,
      audioInit.contentLength,
      audioInit.initEnd,
      audioIndex
    ));
    // Video often lands a few seconds early of wall-clock seek target
    if (Math.abs(startAt - targetTime) > 0.25) {
      push(timeToMediaByte(
        startAt,
        audioInit.contentLength,
        audioInit.initEnd,
        audioIndex
      ));
    }
    // Prefer the session's original mid-start audio byte (computed before video PTS drift)
    if (startByteAudio > audioInit.initEnd) {
      push(startByteAudio);
    }

    if (audioIndex.source === "sidx" && audioIndex.entries.length > 0) {
      // Neighbour segments around target (earlier first — safer for cover)
      const times = [targetTime - 10, targetTime - 5, targetTime + 5, startAt - 10];
      for (const time of times) {
        if (time > 0) {
          push(timeToMediaByte(
            time,
            audioInit.contentLength,
            audioInit.initEnd,
            audioIndex
          ));
        }
      }
    } else {
      // Linear/calibrated only: slight earlier bias (audio lagged video in spikes)
      const mediaBytes = Math.max(0, audioInit.contentLength - audioInit.initEnd);
      push(out[0]! - Math.floor(mediaBytes * 0.02));
      push(out[0]! - 512 * 1024);
      push(out[0]! - 2 * 1024 * 1024);
    }

    return out;
  }

  /**
   * Re-fetch audio so ranges overlap video PTS after a mid-file land.
   * Prefer wall-clock `targetTime` (seek/chapter target), not early video PTS.
   */
  async function syncAudioToVideoTime(targetTime: number): Promise<boolean> {
    onState?.("av-sync");
    // Already good — never clear a covering buffer
    if (
      coversTime(audioSb, targetTime)
      && (
        rangesOverlap(videoSb.buffered, audioSb.buffered)
        || rangesNearlyContinuous(videoSb.buffered, audioSb.buffered, 2)
      )
    ) {
      log("audio sync skip — already covers", {
        targetTime: targetTime.toFixed(2),
        audioBuf: formatSbBuffered(audioSb)
      });
      return true;
    }

    const candidates = audioSyncByteCandidates(targetTime);
    log("audio sync candidates", {
      targetTime: targetTime.toFixed(2),
      wallClock: startAt,
      index: audioIndex.source,
      candidates: candidates.slice(0, 6)
    });

    for (let attempt = 0; attempt < AUDIO_SYNC_ATTEMPTS && !stopped; attempt += 1) {
      throwIfStopped();

      await clearBuffered(audioSb, log, "audio");
      audioPump.done = false;
      // Re-seed init after full clear — some Chrome builds leave SB unable to
      // decode mid-file moofs until init is present again.
      try {
        await appendChunk(audioSb, audioInit.init);
      } catch {
        // already has init or not updatable — continue
      }

      const estimate = candidates[attempt]
        ?? Math.max(
          audioInit.initEnd,
          (candidates[candidates.length - 1] ?? audioInit.initEnd) - (attempt + 1) * 512 * 1024
        );

      // Prefer exact sidx / candidate byte. Only moof-scan when:
      // - not sidx, or
      // - later attempts after empty buffer (candidate may be slightly off)
      let moof: number;
      if (audioIndex.source === "sidx" && attempt < 3) {
        moof = estimate;
      } else {
        moof = await alignToNextMoof(
          audio.url,
          estimate,
          audioInit.contentLength,
          audioInit.initEnd,
          abort.signal,
          log,
          `audio sync#${attempt}`
        );
      }
      throwIfStopped();
      audioPump.nextByte = moof;

      // Land any audio buffer first, then fill to cover target
      await prefetchTrack("audio", audio.url, audioSb, audioPump, {
        maxChunks: MID_FIRST_VIDEO_CHUNKS,
        stopOnFirstBuffer: true
      });
      if (audioSb.buffered.length > 0) {
        await prefetchTrack("audio", audio.url, audioSb, audioPump, {
          maxChunks: MID_PREFETCH_AUDIO,
          coverTime: targetTime,
          minAhead: 2
        });
      }
      throwIfStopped();

      const audioStart = firstBufferedStart(audioSb);
      const audioEnd = firstBufferedEnd(audioSb);
      log("audio sync result", {
        attempt,
        targetTime: targetTime.toFixed(2),
        estimate,
        moof,
        audioBuf: formatSbBuffered(audioSb),
        covers: coversTime(audioSb, targetTime),
        overlap: rangesOverlap(videoSb.buffered, audioSb.buffered)
      });

      if (
        coversTime(audioSb, targetTime)
        || rangesOverlap(videoSb.buffered, audioSb.buffered)
        || rangesNearlyContinuous(videoSb.buffered, audioSb.buffered, 1.5)
      ) {
        return true;
      }

      if (audioStart == null || audioEnd == null) {
        // Empty after appends — try next candidate (not blind −2MB walks)
        continue;
      }

      if (audioStart > targetTime + 0.5) {
        const lateBy = audioStart - targetTime;
        if (audioIndex.source === "sidx") {
          // One segment earlier via time map
          candidates.push(timeToMediaByte(
            Math.max(0, audioStart - lateBy - 2),
            audioInit.contentLength,
            audioInit.initEnd,
            audioIndex
          ));
        } else {
          const mediaBytes = audioInit.contentLength - audioInit.initEnd;
          const byteShift = duration > 0
            ? Math.floor((lateBy / duration) * mediaBytes)
            : 2 * 1024 * 1024;
          candidates.push(Math.max(audioInit.initEnd, moof - Math.max(byteShift, 512 * 1024)));
        }
        log("audio too late — queue earlier candidate", { lateBy: lateBy.toFixed(1) });
        continue;
      }

      if (audioEnd < targetTime - 0.5) {
        await prefetchTrack("audio", audio.url, audioSb, audioPump, {
          maxChunks: MID_PREFETCH_AUDIO,
          coverTime: targetTime,
          minAhead: 2
        });
        if (coversTime(audioSb, targetTime) || rangesOverlap(videoSb.buffered, audioSb.buffered)) {
          return true;
        }
        if (audioIndex.source === "sidx") {
          candidates.push(timeToMediaByte(
            targetTime + 2,
            audioInit.contentLength,
            audioInit.initEnd,
            audioIndex
          ));
        } else {
          candidates.push(Math.min(
            audioInit.contentLength - 1,
            audioPump.nextByte + 512 * 1024
          ));
        }
        log("audio too early — queue later candidate", {
          earlyBy: (targetTime - (firstBufferedEnd(audioSb) ?? audioEnd)).toFixed(1)
        });
      }
    }

    throwIfStopped();
    return rangesOverlap(videoSb.buffered, audioSb.buffered);
  }

  function mediaPipelineDead(): boolean {
    return Boolean(elVideo.error)
      || mediaSource.readyState === "closed"
      || mediaSource.readyState === "ended";
  }

  /**
   * Incremental rebuffer around wall-clock time (Phase 2).
   * If demuxer/pipeline is dead, throws MSE_RELOAD_REQUIRED for full session rebuild.
   */
  async function rebufferAt(wallTime: number, reason: string): Promise<void> {
    if (stopped || rebufferBusy) {
      return;
    }
    if (mediaPipelineDead()) {
      throw new Error(MSE_RELOAD_REQUIRED);
    }

    rebufferBusy = true;
    pumpsPaused = true;
    suppressUserSeek = true;
    onState?.("rebuffer");
    log("rebufferAt incremental", {
      wallTime: wallTime.toFixed(2),
      reason,
      videoIndex: videoIndex.source,
      audioIndex: audioIndex.source
    });

    try {
      throwIfStopped();
      // Cancel stuck seeking before remove/append
      try {
        if (elVideo.seeking) {
          const safe = firstBufferedStart(videoSb);
          if (safe != null) {
            elVideo.currentTime = safe;
            await waitSeeked(elVideo, 1500);
          }
        }
      } catch {
        // ignore
      }

      await clearBuffered(videoSb, log, "video");
      await clearBuffered(audioSb, log, "audio");
      if (mediaPipelineDead()) {
        throw new Error(MSE_RELOAD_REQUIRED);
      }
      videoPump.done = false;
      audioPump.done = false;

      if (wallTime <= 0.5) {
        videoPump.nextByte = videoInit.initEnd;
        audioPump.nextByte = audioInit.initEnd;
        await Promise.all([
          prefetchTrack("video", video.url, videoSb, videoPump, {
            maxChunks: START_PREFETCH_VIDEO,
            stopOnFirstBuffer: true
          }),
          prefetchTrack("audio", audio.url, audioSb, audioPump, {
            maxChunks: START_PREFETCH_AUDIO,
            stopOnFirstBuffer: true
          })
        ]);
      } else {
        const vEstimate = timeToMediaByte(
          wallTime,
          videoInit.contentLength,
          videoInit.initEnd,
          videoIndex
        );
        videoPump.nextByte = videoIndex.source === "sidx"
          ? vEstimate
          : await alignToNextMoof(
            video.url,
            vEstimate,
            videoInit.contentLength,
            videoInit.initEnd,
            abort.signal,
            log,
            "video rebuffer"
          );
        await prefetchTrack("video", video.url, videoSb, videoPump, {
          maxChunks: MID_FIRST_VIDEO_CHUNKS,
          stopOnFirstBuffer: true
        });
        if (mediaPipelineDead()) {
          throw new Error(MSE_RELOAD_REQUIRED);
        }
        const vStart = firstBufferedStart(videoSb);
        if (vStart == null) {
          throw new Error("rebuffer: no video buffer");
        }
        await prefetchTrack("video", video.url, videoSb, videoPump, {
          maxChunks: MID_FILL_CHUNKS,
          coverTime: vStart,
          minAhead: PLAY_AHEAD_S
        });
        if (videoIndex.source !== "sidx") {
          videoIndex = buildCalibratedIndex({
            initEnd: videoInit.initEnd,
            contentLength: videoInit.contentLength,
            observedByte: videoPump.nextByte > videoInit.initEnd
              ? videoPump.nextByte - CHUNK
              : startByteVideo,
            observedTime: vStart,
            durationHint: duration
          });
        }
        const targetTime = firstBufferedStart(videoSb) ?? wallTime;
        const synced = await syncAudioToVideoTime(targetTime);
        if (!synced) {
          throw new Error("rebuffer: A/V could not overlap");
        }
        const playAt = overlapStart(videoSb, audioSb);
        if (playAt != null) {
          await Promise.all([
            prefetchTrack("video", video.url, videoSb, videoPump, {
              maxChunks: MID_FILL_CHUNKS,
              coverTime: playAt,
              minAhead: PLAY_AHEAD_S
            }),
            prefetchTrack("audio", audio.url, audioSb, audioPump, {
              maxChunks: MID_FILL_CHUNKS,
              coverTime: playAt,
              minAhead: PLAY_AHEAD_S
            })
          ]);
        }
      }

      throwIfStopped();
      if (mediaPipelineDead()) {
        throw new Error(MSE_RELOAD_REQUIRED);
      }
      const seekTarget = overlapStart(videoSb, audioSb)
        ?? firstBufferedStart(videoSb)
        ?? wallTime;
      elVideo.currentTime = seekTarget;
      await waitSeeked(elVideo, 4000);
      log("rebuffer seek", {
        seekTarget,
        videoBuf: formatSbBuffered(videoSb),
        audioBuf: formatSbBuffered(audioSb),
        media: formatBuffered(elVideo),
        drift: (seekTarget - wallTime).toFixed(1)
      });
      if (autoplay) {
        await elVideo.play();
        log("rebuffer play() ok", { t: elVideo.currentTime.toFixed(2) });
      } else {
        log("rebuffer ready (no autoplay)", { t: elVideo.currentTime.toFixed(2) });
      }
      onState?.("playing");
    } catch (error) {
      if (stopped || abort.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log("rebuffer failed", message);
      onState?.("failed");
      if (message.includes(MSE_RELOAD_REQUIRED)
        || message.includes("SourceBuffer")
        || message.includes("appendBuffer")
        || elVideo.error) {
        throw new Error(MSE_RELOAD_REQUIRED);
      }
      throw error instanceof Error ? error : new Error(message);
    } finally {
      rebufferBusy = false;
      pumpsPaused = false;
      suppressUserSeek = false;
    }
  }

  function onUserSeeked() {
    if (stopped || suppressUserSeek || rebufferBusy || abort.signal.aborted) {
      return;
    }
    const time = elVideo.currentTime;
    // Already have playable intersection at playhead — pumps will extend
    if (bufferAhead(elVideo) >= 0.35
      && coversTime(videoSb, time)
      && coversTime(audioSb, time)) {
      void elVideo.play().catch(() => {
        // autoplay / pause race
      });
      return;
    }
    log("user seek outside buffer — rebuffer", {
      t: time.toFixed(2),
      media: formatBuffered(elVideo),
      vBuf: formatSbBuffered(videoSb),
      aBuf: formatSbBuffered(audioSb)
    });
    void rebufferAt(time, "user-seek").catch(error => {
      if (!stopped) {
        log("user seek rebuffer failed (spike: prefer engine full-reload path)", String(error));
      }
    });
  }

  onState?.("buffering");
  const isMid = startAt > 0.5;
  const bothSidx = videoIndex.source === "sidx" && audioIndex.source === "sidx";

  if (isMid && bothSidx) {
    // Dual sidx: start both tracks at exact segment offsets in parallel.
    // Avoids the old "video first → biased audio resync" path that failed mid-seek.
    log("prefetch A/V mid (sidx parallel)…", {
      videoFrom: startByteVideo,
      audioFrom: startByteAudio,
      startAt
    });
    await Promise.all([
      (async () => {
        await prefetchTrack("video", video.url, videoSb, videoPump, {
          maxChunks: MID_FIRST_VIDEO_CHUNKS,
          stopOnFirstBuffer: true
        });
        const vStart = firstBufferedStart(videoSb);
        if (vStart != null) {
          await prefetchTrack("video", video.url, videoSb, videoPump, {
            maxChunks: MID_FILL_CHUNKS,
            coverTime: vStart,
            minAhead: PLAY_AHEAD_S
          });
        }
      })(),
      (async () => {
        await prefetchTrack("audio", audio.url, audioSb, audioPump, {
          maxChunks: MID_FIRST_VIDEO_CHUNKS,
          stopOnFirstBuffer: true
        });
        const aStart = firstBufferedStart(audioSb);
        if (aStart != null) {
          const cover = Math.max(aStart, startAt - 1);
          await prefetchTrack("audio", audio.url, audioSb, audioPump, {
            maxChunks: MID_FILL_CHUNKS,
            coverTime: cover,
            minAhead: PLAY_AHEAD_S
          });
        }
      })()
    ]);
  } else if (isMid) {
    log("prefetch video media…", {
      chunks: MID_FIRST_VIDEO_CHUNKS,
      from: startByteVideo,
      stopOnFirst: true
    });
    // Land first decodable frames ASAP — never pull 16MB before first buffer.
    await prefetchTrack("video", video.url, videoSb, videoPump, {
      maxChunks: MID_FIRST_VIDEO_CHUNKS,
      stopOnFirstBuffer: true
    });
    const vStart = firstBufferedStart(videoSb);
    if (vStart != null) {
      await prefetchTrack("video", video.url, videoSb, videoPump, {
        maxChunks: MID_FILL_CHUNKS,
        coverTime: vStart,
        minAhead: PLAY_AHEAD_S
      });
    }
  } else {
    log("prefetch A/V start…", {
      videoChunks: START_PREFETCH_VIDEO,
      audioChunks: START_PREFETCH_AUDIO,
      from: startByteVideo
    });
    // From t=0 both tracks start near init; pull in parallel.
    await Promise.all([
      prefetchTrack("video", video.url, videoSb, videoPump, {
        maxChunks: START_PREFETCH_VIDEO,
        stopOnFirstBuffer: true
      }),
      prefetchTrack("audio", audio.url, audioSb, audioPump, {
        maxChunks: START_PREFETCH_AUDIO,
        stopOnFirstBuffer: true
      })
    ]);
  }

  if (videoSb.buffered.length === 0) {
    stopped = true;
    abort.abort();
    const message = isMid
      ? "mid start: no decodable video buffer after moof align + prefetch"
      : "start: no decodable video buffer after prefetch";
    log("FAIL", message);
    onState?.("failed");
    try {
      elVideo.removeAttribute("src");
      elVideo.load();
    } catch {
      // ignore
    }
    URL.revokeObjectURL(objectUrl);
    throw new Error(message);
  }

  if (isMid) {
    const targetTime = firstBufferedStart(videoSb) ?? startAt;
    log("A/V sync to video PTS", {
      targetTime: targetTime.toFixed(2),
      videoBuf: formatSbBuffered(videoSb),
      audioBufBefore: formatSbBuffered(audioSb),
      wallClockHint: startAt,
      drift: (targetTime - startAt).toFixed(1),
      bothSidx
    });

    // Calibrate only when we lack sidx — never replace a good sidx map
    if (
      videoIndex.source !== "sidx"
      && targetTime > 0.5
      && startByteVideo > videoInit.initEnd
    ) {
      videoIndex = buildCalibratedIndex({
        initEnd: videoInit.initEnd,
        contentLength: videoInit.contentLength,
        observedByte: startByteVideo,
        observedTime: targetTime,
        durationHint: duration
      });
      log("video index calibrated", {
        source: videoIndex.source,
        observedTime: targetTime,
        observedByte: startByteVideo,
        wallClockHint: startAt
      });
    } else if (videoIndex.source === "sidx") {
      log("keep sidx video index", {
        drift: (targetTime - startAt).toFixed(1),
        wallClockHint: startAt,
        landed: targetTime
      });
    }

    /**
     * Reconcile A/V after parallel sidx land.
     * Prefer *extending* the short track over clearBuffered+resync — logs showed
     * audio already covering wall-clock while video was ~2s short; destructive
     * resync wiped good audio and then failed (chapter menu seeks).
     */
    async function ensureAvPlayable(): Promise<boolean> {
      const wall = startAt;
      const vCoversWall = coversTime(videoSb, wall);
      const aCoversWall = coversTime(audioSb, wall);

      if (vCoversWall && aCoversWall) {
        log("A/V both cover wall clock", {
          wall,
          videoBuf: formatSbBuffered(videoSb),
          audioBuf: formatSbBuffered(audioSb)
        });
        return true;
      }

      // Audio good at seek target — only need more video (common sidx drift)
      if (aCoversWall && !vCoversWall) {
        log("extend video to wall clock", {
          wall,
          videoBuf: formatSbBuffered(videoSb),
          audioBuf: formatSbBuffered(audioSb)
        });
        await prefetchTrack("video", video.url, videoSb, videoPump, {
          maxChunks: MID_FILL_CHUNKS * 2,
          coverTime: wall,
          minAhead: PLAY_AHEAD_S
        });
        if (coversTime(videoSb, wall) && coversTime(audioSb, wall)) {
          return true;
        }
      }

      // Video good — extend audio forward if it ends just before wall
      if (vCoversWall && !aCoversWall) {
        const aEnd = firstBufferedEnd(audioSb);
        if (aEnd != null && aEnd < wall && wall - aEnd < 45) {
          log("extend audio forward to wall clock", { wall, aEnd });
          await prefetchTrack("audio", audio.url, audioSb, audioPump, {
            maxChunks: MID_FILL_CHUNKS * 2,
            coverTime: wall,
            minAhead: PLAY_AHEAD_S
          });
          if (coversTime(audioSb, wall)) {
            return true;
          }
        }
      }

      // Point-touch / tiny gap (video …1986.9 | audio 1986.9…) — grow video into audio
      if (rangesNearlyContinuous(videoSb.buffered, audioSb.buffered, 2)) {
        const aStart = firstBufferedStart(audioSb);
        const vEnd = firstBufferedEnd(videoSb);
        if (aStart != null && vEnd != null && aStart >= vEnd - 0.05) {
          log("bridge tiny A/V gap — extend video", {
            vEnd,
            aStart,
            videoBuf: formatSbBuffered(videoSb),
            audioBuf: formatSbBuffered(audioSb)
          });
          await prefetchTrack("video", video.url, videoSb, videoPump, {
            maxChunks: MID_FILL_CHUNKS * 2,
            coverTime: Math.max(aStart, wall),
            minAhead: PLAY_AHEAD_S
          });
        }
        if (
          rangesOverlap(videoSb.buffered, audioSb.buffered)
          || rangesNearlyContinuous(videoSb.buffered, audioSb.buffered, 0.75)
        ) {
          // Playable if wall is covered by at least one and ranges meet
          if (coversTime(audioSb, wall) || coversTime(videoSb, wall)) {
            return true;
          }
          const playAt = overlapStart(videoSb, audioSb);
          if (playAt != null && Math.abs(playAt - wall) < 15) {
            return true;
          }
        }
      }

      // Last resort: re-anchor audio to wall clock (not early video PTS)
      log("A/V need audio re-anchor", {
        wall,
        targetTime,
        videoBuf: formatSbBuffered(videoSb),
        audioBuf: formatSbBuffered(audioSb)
      });
      return syncAudioToVideoTime(wall);
    }

    let synced = false;
    try {
      synced = await ensureAvPlayable();
    } catch (error) {
      if (stopped || abort.signal.aborted
        || (error instanceof DOMException && error.name === "AbortError")
        || String(error).includes("AbortError")) {
        throw new DOMException("aborted", "AbortError");
      }
      throw error;
    }
    throwIfStopped();
    if (!synced) {
      stopped = true;
      abort.abort();
      const message = "mid start: could not overlap audio with video timestamps";
      log("FAIL", {
        message,
        videoBuf: formatSbBuffered(videoSb),
        audioBuf: formatSbBuffered(audioSb)
      });
      onState?.("failed");
      try {
        elVideo.removeAttribute("src");
        elVideo.load();
      } catch {
        // ignore
      }
      URL.revokeObjectURL(objectUrl);
      throw new Error(message);
    }

    const audioStart = firstBufferedStart(audioSb);
    if (
      audioIndex.source !== "sidx"
      && audioStart != null
      && audioPump.nextByte > audioInit.initEnd
    ) {
      audioIndex = buildCalibratedIndex({
        initEnd: audioInit.initEnd,
        contentLength: audioInit.contentLength,
        observedByte: Math.max(audioInit.initEnd, audioPump.nextByte - CHUNK),
        observedTime: audioStart,
        durationHint: duration
      });
    }

    // Grow cushion around wall clock (prefer wall over early video PTS)
    const playAt = coversTime(videoSb, startAt) && coversTime(audioSb, startAt)
      ? startAt
      : (overlapStart(videoSb, audioSb) ?? startAt);
    await Promise.all([
      prefetchTrack("video", video.url, videoSb, videoPump, {
        maxChunks: MID_FILL_CHUNKS,
        coverTime: playAt,
        minAhead: PLAY_AHEAD_S
      }),
      prefetchTrack("audio", audio.url, audioSb, audioPump, {
        maxChunks: MID_FILL_CHUNKS,
        coverTime: playAt,
        minAhead: PLAY_AHEAD_S
      })
    ]);
  }

  log("buffered after prefetch", {
    video: formatSbBuffered(videoSb),
    audio: formatSbBuffered(audioSb),
    media: formatBuffered(elVideo),
    overlap: overlapStart(videoSb, audioSb),
    ahead: bufferAhead(elVideo).toFixed(2)
  });

  if (
    isMid
    && !rangesOverlap(videoSb.buffered, audioSb.buffered)
    && !rangesNearlyContinuous(videoSb.buffered, audioSb.buffered, 1)
  ) {
    // Still no usable A/V — only fail if wall clock isn't coverable either
    const wallOk = coversTime(videoSb, startAt) && coversTime(audioSb, startAt);
    if (!wallOk) {
      stopped = true;
      abort.abort();
      const message = "mid start: A/V ranges still do not overlap";
      log("FAIL", message);
      onState?.("failed");
      try {
        elVideo.removeAttribute("src");
        elVideo.load();
      } catch {
        // ignore
      }
      URL.revokeObjectURL(objectUrl);
      throw new Error(message);
    }
  }

  // Background pumps only after we have real buffer
  void pumpTrack("video", video.url, videoSb, videoPump, true);
  void pumpTrack("audio", audio.url, audioSb, audioPump, false);

  if (isMid || startAt > 0.25) {
    // Prefer wall-clock startAt when both tracks already cover it (sidx)
    let seekTarget = startAt;
    if (!coversTime(videoSb, startAt) || !coversTime(audioSb, startAt)) {
      seekTarget = overlapStart(videoSb, audioSb)
        ?? firstBufferedStart(videoSb)
        ?? startAt;
    }
    try {
      throwIfStopped();
      elVideo.currentTime = seekTarget;
      log("seek to playable time", {
        wallClockHint: startAt,
        seekTarget,
        covered: coversTime(videoSb, startAt) && coversTime(audioSb, startAt),
        videoBuf: formatSbBuffered(videoSb),
        audioBuf: formatSbBuffered(audioSb),
        media: formatBuffered(elVideo)
      });
      await waitSeeked(elVideo, 4000);
    } catch (error) {
      if (stopped || abort.signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      log("seek failed", String(error));
    }
  }

  // Wait briefly for media.buffered (intersection) to update after seek
  for (let waitIndex = 0; waitIndex < 20 && !stopped; waitIndex += 1) {
    if (bufferAhead(elVideo) > 0.2 || elVideo.readyState >= 2) {
      break;
    }
    await new Promise(resolve => window.setTimeout(resolve, 50));
  }

  // Re-assert playhead if browser snapped back to 0 while only mid-file data exists
  if (isMid || startAt > 0.25) {
    const live = elVideo.currentTime;
    const aheadLive = bufferAhead(elVideo);
    if (aheadLive < 0.15 || live < startAt - 2) {
      let snap = startAt;
      if (!coversTime(videoSb, snap)) {
        snap = overlapStart(videoSb, audioSb)
          ?? firstBufferedStart(videoSb)
          ?? startAt;
      }
      if (Math.abs(live - snap) > 0.25) {
        log("re-assert playhead after mid land", { from: live, to: snap });
        try {
          elVideo.currentTime = snap;
          await waitSeeked(elVideo, 2000);
        } catch {
          // best-effort
        }
      }
    }
  }

  throwIfStopped();
  onState?.("playing");
  if (autoplay) {
    try {
      await elVideo.play();
      log("play() ok", {
        t: elVideo.currentTime.toFixed(2),
        vBuf: formatSbBuffered(videoSb),
        aBuf: formatSbBuffered(audioSb),
        media: formatBuffered(elVideo)
      });
    } catch (error) {
      if (!stopped && !abort.signal.aborted) {
        log("play() failed (autoplay?)", String(error));
      }
    }
  } else {
    log("ready (engine owns play)", {
      t: elVideo.currentTime.toFixed(2),
      vBuf: formatSbBuffered(videoSb),
      aBuf: formatSbBuffered(audioSb),
      media: formatBuffered(elVideo)
    });
  }

  // Enable timeline scrub handling (spike only; engine sets handleUserSeek: false)
  suppressUserSeek = false;
  if (handleUserSeek) {
    elVideo.addEventListener("seeked", onUserSeeked);
  }

  function onVideoError() {
    if (!stopped) {
      log("video element error", elVideo.error);
    }
  }
  elVideo.addEventListener("error", onVideoError);

  return {
    async seek(time: number) {
      await rebufferAt(Math.max(0, time), "engine-seek");
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      pumpsPaused = true;
      abort.abort();
      if (handleUserSeek) {
        elVideo.removeEventListener("seeked", onUserSeeked);
      }
      elVideo.removeEventListener("error", onVideoError);
      try {
        if (mediaSource.readyState === "open") {
          try {
            mediaSource.removeSourceBuffer(videoSb);
          } catch {
            // ignore
          }
          try {
            mediaSource.removeSourceBuffer(audioSb);
          } catch {
            // ignore
          }
          try {
            mediaSource.endOfStream();
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      try {
        elVideo.pause();
      } catch {
        // ignore
      }
      try {
        elVideo.removeAttribute("src");
        elVideo.load();
      } catch {
        // ignore
      }
      URL.revokeObjectURL(objectUrl);
      onState?.("stopped");
      log("stopped", {
        videoFetched: formatBytes(videoPump.fetched),
        audioFetched: formatBytes(audioPump.fetched)
      });
    },
    getStats() {
      if (stopped) {
        return {
          videoBuffered: "stopped",
          audioBuffered: "stopped",
          videoFetched: videoPump.fetched,
          audioFetched: audioPump.fetched
        };
      }
      return {
        videoBuffered: formatSbBuffered(videoSb),
        audioBuffered: formatSbBuffered(audioSb),
        videoFetched: videoPump.fetched,
        audioFetched: audioPump.fetched
      };
    }
  };
}

/** Spike / legacy name. */
export async function startSpikePlayer(options: SpikePlayerOptions): Promise<MseSessionHandle> {
  return startMseSession(options);
}

export type MseController = {
  load: (opts: {
    videoUrl: string;
    audioUrl: string;
    videoMime: string;
    audioMime?: string;
    startAt: number;
    durationHint?: number;
    label?: string;
  }) => Promise<void>;
  seek: (time: number) => Promise<void>;
  stop: () => void;
  isActive: () => boolean;
  getStats: () => {
    videoBuffered: string;
    audioBuffered: string;
    videoFetched: number;
    audioFetched: number;
  } | null;
};

type MseLoadOpts = {
  videoUrl: string;
  audioUrl: string;
  videoMime: string;
  audioMime?: string;
  startAt: number;
  durationHint?: number;
  label?: string;
};

export function createMseController(options: {
  elVideo: HTMLVideoElement;
  log?: (message: string, data?: unknown) => void;
  onState?: (state: string) => void;
  /** Default false — PlaybackEngine owns seek. Spike can pass true. */
  handleUserSeek?: boolean;
}): MseController {
  let session: MseSessionHandle | null = null;
  let lastLoad: MseLoadOpts | null = null;
  const log = options.log ?? (() => {});

  async function hardDetachVideo() {
    session?.stop();
    session = null;
    const elVideo = options.elVideo;
    try {
      elVideo.pause();
    } catch {
      // ignore
    }
    try {
      elVideo.removeAttribute("src");
      elVideo.load();
    } catch {
      // ignore
    }
    // Brief yield so Chrome can clear CHUNK_DEMUXER / media.error before a new MediaSource
    await new Promise(resolve => window.setTimeout(resolve, 16));
  }

  async function loadInternal(opts: MseLoadOpts) {
    lastLoad = opts;
    await hardDetachVideo();
    const audioMime = opts.audioMime ?? "audio/mp4; codecs=\"mp4a.40.2\"";
    session = await startMseSession({
      elVideo: options.elVideo,
      video: {
        label: opts.label ?? "video",
        url: opts.videoUrl,
        mimeType: opts.videoMime
      },
      audio: {
        label: "audio",
        url: opts.audioUrl,
        mimeType: audioMime
      },
      startAt: opts.startAt,
      durationHint: opts.durationHint,
      log,
      onState: options.onState,
      handleUserSeek: options.handleUserSeek ?? false,
      // Engine owns play — avoids suppress-play-during-busy flap
      autoplay: options.handleUserSeek === true
    });
  }

  return {
    async load(opts) {
      await loadInternal(opts);
    },
    /**
     * Scrub: always rebuild MediaSource.
     * Chrome dual-track fMP4 often fatals demuxer on clear+random-access append
     * (`SourceBuffer error` / CHUNK_DEMUXER). Full reload + sidx is reliable.
     */
    async seek(time) {
      if (!lastLoad) {
        throw new Error("MSE not loaded");
      }
      const startAt = Math.max(0, time);
      log("seek full MediaSource reload", {
        startAt,
        previous: lastLoad.startAt
      });
      await loadInternal({
        ...lastLoad,
        startAt
      });
    },
    stop() {
      session?.stop();
      session = null;
      // keep lastLoad so a later load can still happen; seek needs lastLoad
    },
    isActive() {
      return session != null;
    },
    getStats() {
      return session?.getStats() ?? null;
    }
  };
}

/** Adaptive mp4 (avc1 / av01) + m4a that MSE can drive (no companion <audio>). */
export function qualitySupportsMse(quality: {
  isProgressive: boolean;
  audioUrl: string | null;
  mimeType: string;
}): boolean {
  if (quality.isProgressive || !quality.audioUrl) {
    return false;
  }
  if (typeof MediaSource === "undefined") {
    return false;
  }
  const videoMime = quality.mimeType.split(" ").join("");
  if (!videoMime.includes("mp4")) {
    return false;
  }
  const hasVideoCodec = videoMime.includes("avc1") || videoMime.includes("av01");
  if (!hasVideoCodec) {
    return false;
  }
  const audioMime = "audio/mp4;codecs=\"mp4a.40.2\"";
  return MediaSource.isTypeSupported(videoMime)
    && MediaSource.isTypeSupported(audioMime);
}

export function pickMseTracks(qualities: Array<{
  id: string;
  label: string;
  height: number;
  videoUrl: string;
  audioUrl: string | null;
  isProgressive: boolean;
  mimeType: string;
  bitrate?: number;
}>): { video: SpikeTrack; audio: SpikeTrack } | null {
  const adaptive = qualities
    .filter(item => !item.isProgressive && item.audioUrl && item.mimeType.includes("mp4"))
    .filter(item => item.mimeType.includes("avc1") || item.mimeType.includes("mp4"))
    .sort((left, right) => (right.height ?? 0) - (left.height ?? 0));

  const preferred = adaptive.find(item => item.height <= 1080 && item.height >= 720)
    ?? adaptive.find(item => item.height <= 1080)
    ?? adaptive[0];

  if (!preferred?.audioUrl) {
    return null;
  }

  const audioMime = "audio/mp4; codecs=\"mp4a.40.2\"";
  if (!MediaSource.isTypeSupported(audioMime)) {
    if (!MediaSource.isTypeSupported("audio/mp4")) {
      return null;
    }
  }

  return {
    video: {
      label: preferred.label,
      url: preferred.videoUrl,
      mimeType: preferred.mimeType,
      height: preferred.height,
      bitrate: preferred.bitrate
    },
    audio: {
      label: "audio",
      url: preferred.audioUrl,
      mimeType: MediaSource.isTypeSupported(audioMime) ? audioMime : "audio/mp4"
    }
  };
}
