/**
 * Phase-0 MSE spike harness.
 *
 * Open: chrome-extension://<id>/mse-spike.html
 * Or:   mse-spike.html?v=VIDEO_ID
 *
 * Requires a YouTube tab open for page-proxy resolve (same as Ad-Free).
 */

import "./spike.css";

import { formatBytes } from "@/lib/ad-free/mse/mp4-boxes";
import {
  pickMseTracks,
  startSpikePlayer,
  type SpikePlayerHandle
} from "@/lib/ad-free/mse/spike-player";
import {
  type AdFreeQualityOption,
  type AdFreeStreamPayload
} from "@/lib/ad-free/resolve-stream";
import { MessageType, sendMessage } from "@/lib/messaging/messaging";

const logLines: string[] = [];
let payload: AdFreeStreamPayload | null = null;
let player: SpikePlayerHandle | null = null;
let statsTimer = 0;
/** Bumps on every Play click so stale async sessions cannot clobber the UI. */
let playGeneration = 0;

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`#${id} missing`);
  }
  return element;
}

function inputById(id: string): HTMLInputElement {
  const element = byId(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`);
  }
  return element;
}

function buttonById(id: string): HTMLButtonElement {
  const element = byId(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`#${id} is not a button`);
  }
  return element;
}

function videoById(id: string): HTMLVideoElement {
  const element = byId(id);
  if (!(element instanceof HTMLVideoElement)) {
    throw new Error(`#${id} is not a video`);
  }
  return element;
}

function getLogText(): string {
  return logLines.join("\n");
}

function log(message: string, data?: unknown) {
  const stamp = new Date().toISOString().slice(11, 23);
  const line = data === undefined
    ? `${stamp} ${message}`
    : `${stamp} ${message} ${typeof data === "string" ? data : JSON.stringify(data)}`;
  logLines.push(line);
  if (logLines.length > 400) {
    logLines.splice(0, logLines.length - 400);
  }
  const elLog = document.getElementById("log");
  if (elLog) {
    elLog.textContent = getLogText();
    elLog.scrollTop = elLog.scrollHeight;
  }
  console.info("[mse-spike]", message, data ?? "");
}

async function copyFullLog() {
  const text = getLogText();
  if (!text) {
    setStatus("log empty", "warn");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus("log copied", "ok");
    log("log copied to clipboard", { chars: text.length, lines: logLines.length });
  } catch (error) {
    // Fallback for restricted contexts
    try {
      const elArea = document.createElement("textarea");
      elArea.value = text;
      elArea.setAttribute("readonly", "");
      elArea.style.position = "fixed";
      elArea.style.left = "-9999px";
      document.body.append(elArea);
      elArea.select();
      const ok = document.execCommand("copy");
      elArea.remove();
      if (!ok) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      setStatus("log copied", "ok");
      log("log copied (fallback)", { chars: text.length, lines: logLines.length });
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      setStatus("copy failed", "fail");
      log("copy log failed", message);
    }
  }
}

function setStatus(text: string, kind: "ok" | "fail" | "warn" | "" = "") {
  const elStatus = byId("status");
  elStatus.textContent = text;
  elStatus.className = kind ? `badge ${kind}` : "badge";
}

function stopPlayer() {
  if (statsTimer) {
    window.clearInterval(statsTimer);
    statsTimer = 0;
  }
  const current = player;
  player = null;
  current?.stop();
}

function qualityBadgeClass(quality: AdFreeQualityOption, mseVideo: boolean): string {
  if (quality.isProgressive) {
    return "";
  }
  return mseVideo ? "ok" : "fail";
}

function qualityBadgeLabel(quality: AdFreeQualityOption, mseVideo: boolean): string {
  if (quality.isProgressive) {
    return "prog";
  }
  return mseVideo ? "mse?" : "no";
}

function renderQualities(qualities: AdFreeQualityOption[]) {
  const elList = byId("qualities");
  elList.replaceChildren();
  for (const quality of qualities) {
    const elRow = document.createElement("div");
    const normalizedMime = quality.mimeType.replace(/\s/g, "");
    const mseVideo = quality.mimeType.includes("mp4")
      && MediaSource.isTypeSupported(normalizedMime);
    const elBadge = document.createElement("span");
    elBadge.className = `badge ${qualityBadgeClass(quality, mseVideo)}`;
    elBadge.textContent = qualityBadgeLabel(quality, mseVideo);
    const elText = document.createElement("span");
    elText.textContent = ` ${quality.label} · ${quality.id} · ${quality.mimeType}`;
    elRow.append(elBadge, elText);
    elList.append(elRow);
  }

  const picked = pickMseTracks(qualities);
  const elPick = byId("picked");
  if (picked) {
    elPick.textContent = `MSE pick: ${picked.video.label} (${picked.video.mimeType}) + ${picked.audio.mimeType}`;
  } else {
    elPick.textContent = "MSE pick: none (need adaptive mp4 video + audioUrl)";
  }
}

async function resolveStream(videoId: string) {
  setStatus("resolving…", "warn");
  log("ResolveAdFreeStream", { videoId });
  try {
    const result = await sendMessage(MessageType.ResolveAdFreeStream, { videoId });
    payload = result;
    log("resolved", {
      title: result.title,
      qualities: result.qualities.map(item => ({
        id: item.id,
        label: item.label,
        progressive: item.isProgressive,
        mime: item.mimeType,
        hasAudio: Boolean(item.audioUrl)
      }))
    });
    renderQualities(result.qualities);
    setStatus("resolved", "ok");
    buttonById("btn-play0").disabled = false;
    buttonById("btn-play-mid").disabled = false;
    buttonById("btn-play-custom").disabled = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("resolve failed", message);
    setStatus("resolve failed", "fail");
  }
}

function setPlayButtonsDisabled(disabled: boolean) {
  for (const id of ["btn-play0", "btn-play-mid", "btn-play-custom"] as const) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement && payload) {
      button.disabled = disabled;
    }
  }
}

async function runPlay(startAt: number) {
  if (!payload) {
    log("no payload — resolve first");
    return;
  }

  const generation = playGeneration + 1;
  playGeneration = generation;

  // Always tear down previous session before a new one (avoids SB removed races)
  stopPlayer();
  setPlayButtonsDisabled(true);
  // Let pending append/fetch abort settle (mid A/V sync can take seconds)
  await new Promise(resolve => window.setTimeout(resolve, 120));
  if (generation !== playGeneration) {
    return;
  }

  const tracks = pickMseTracks(payload.qualities);
  if (!tracks) {
    setStatus("no MSE tracks", "fail");
    log("no suitable adaptive avc1/mp4 + audio");
    setPlayButtonsDisabled(false);
    return;
  }

  const elVideo = videoById("video");
  setStatus(`MSE starting @ ${startAt}s…`, "warn");
  log("startSpikePlayer", {
    startAt,
    generation,
    video: tracks.video.label,
    videoMime: tracks.video.mimeType,
    audioMime: tracks.audio.mimeType
  });

  try {
    const durationInput = Number(inputById("duration").value);
    const handle = await startSpikePlayer({
      elVideo,
      video: tracks.video,
      audio: tracks.audio,
      startAt,
      durationHint: Number.isFinite(durationInput) && durationInput > 0 ? durationInput : undefined,
      log: (message, data) => {
        // Drop logs from aborted superseded sessions
        if (generation !== playGeneration) {
          return;
        }
        log(message, data);
      },
      onState: state => {
        if (generation !== playGeneration) {
          return;
        }
        if (state === "playing") {
          setStatus(state, "ok");
        } else if (state === "failed" || state === "stopped") {
          setStatus(state, state === "failed" ? "fail" : "warn");
        } else {
          setStatus(state, "warn");
        }
      }
    });

    if (generation !== playGeneration) {
      handle.stop();
      return;
    }

    player = handle;

    statsTimer = window.setInterval(() => {
      if (!player || generation !== playGeneration) {
        return;
      }
      const stats = player.getStats();
      byId("meta").textContent = [
        `vBuf=${stats.videoBuffered}`,
        `aBuf=${stats.audioBuffered}`,
        `t=${elVideo.currentTime.toFixed(2)}`,
        `vFetch=${formatBytes(stats.videoFetched)}`,
        `aFetch=${formatBytes(stats.audioFetched)}`,
        `paused=${elVideo.paused}`,
        `rs=${elVideo.readyState}`
      ].join(" · ");
    }, 500);

    setStatus("playing", "ok");
  } catch (error) {
    if (generation !== playGeneration) {
      return;
    }
    player = null;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("aborted") || message.includes("AbortError")) {
      log("spike aborted (superseded or stop)");
      setStatus("stopped", "warn");
    } else {
      log("spike failed", message);
      setStatus("failed", "fail");
    }
  } finally {
    if (generation === playGeneration) {
      setPlayButtonsDisabled(false);
    }
  }
}

function buildUi() {
  const params = new URLSearchParams(location.search);
  const defaultId = params.get("v") ?? "XiqLsDDfmiQ";

  byId("app").innerHTML = `
    <h1>MSE Spike · Phase 0</h1>
    <p class="sub">
      Proves extension-origin <strong>byte-range</strong> fetch + <strong>MediaSource</strong> dual-track
      (avc1 + mp4a) from ANDROID_VR URLs.
      Before Resolve: open <code>https://www.youtube.com/watch?v=…</code> and hard-refresh
      (<kbd>Cmd+Shift+R</kbd>) after reloading the extension — otherwise page-proxy fails
      with “Receiving end does not exist” and background gets HTTP 403.
    </p>

    <div class="panel">
      <div class="row">
        <label for="videoId">video id</label>
        <input id="videoId" value="${defaultId}" spellcheck="false" />
        <button type="button" id="btn-resolve">Resolve</button>
        <span id="status" class="badge">idle</span>
      </div>
      <div class="row">
        <label for="duration">duration (s)</label>
        <input id="duration" type="number" value="9000" min="0" step="1" title="Used for mid-video linear byte map" />
        <label for="customT">start at (s)</label>
        <input id="customT" type="number" value="6000" min="0" step="1" />
      </div>
      <div class="row">
        <button type="button" id="btn-play0" class="secondary" disabled>Play MSE @ 0</button>
        <button type="button" id="btn-play-mid" class="secondary" disabled>Play MSE @ mid field</button>
        <button type="button" id="btn-play-custom" class="secondary" disabled>Play MSE @ custom t</button>
        <button type="button" id="btn-stop" class="danger">Stop</button>
      </div>
      <div id="picked" class="sub" style="margin:0"></div>
    </div>

    <div class="panel">
      <video id="video" controls playsinline></video>
      <div id="meta">—</div>
    </div>

    <div class="panel">
      <div class="sub" style="margin-bottom:8px">Qualities from resolve</div>
      <div id="qualities"></div>
    </div>

    <div class="panel">
      <div class="row" style="margin-bottom:8px">
        <div class="sub" style="margin:0;flex:1">Log</div>
        <button type="button" id="btn-copy-log" class="secondary">Copy full log</button>
        <button type="button" id="btn-clear-log" class="secondary">Clear</button>
      </div>
      <div id="log"></div>
    </div>
  `;

  buttonById("btn-resolve").addEventListener("click", () => {
    const videoId = inputById("videoId").value.trim();
    if (videoId) {
      void resolveStream(videoId);
    }
  });
  buttonById("btn-play0").addEventListener("click", () => void runPlay(0));
  buttonById("btn-play-mid").addEventListener("click", () => {
    const duration = Number(inputById("duration").value) || 0;
    void runPlay(duration > 0 ? Math.floor(duration / 2) : 6000);
  });
  buttonById("btn-play-custom").addEventListener("click", () => {
    const startAt = Number(inputById("customT").value) || 0;
    void runPlay(startAt);
  });
  buttonById("btn-stop").addEventListener("click", () => stopPlayer());
  buttonById("btn-copy-log").addEventListener("click", () => void copyFullLog());
  buttonById("btn-clear-log").addEventListener("click", () => {
    logLines.length = 0;
    const elLog = document.getElementById("log");
    if (elLog) {
      elLog.textContent = "";
    }
    setStatus("log cleared", "warn");
  });

  log("MSE spike ready", {
    mediaSource: typeof MediaSource !== "undefined",
    isTypeSupported: typeof MediaSource !== "undefined"
      && MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"')
  });
}

buildUi();

const autoId = new URLSearchParams(location.search).get("v");
if (autoId) {
  void resolveStream(autoId);
}
