import {
  bufferAheadSeconds,
  createAdFreeLogger,
  formatBuffered,
  mediaSnapshot
} from "@/lib/ad-free/debug-log";

const log = createAdFreeLogger("hud");

export type DebugHudController = {
  update: (info: {
    state: string;
    generation: number;
    qualityLabel: string;
    wantsPlaying: boolean;
    elVideo: HTMLVideoElement | null;
    elAudio: HTMLAudioElement | null;
  }) => void;
  dispose: () => void;
};

/**
 * On-screen buffer/state HUD so the gray scrubber can be compared to real buffered ranges.
 */
export function createDebugHud(elMount: HTMLElement): DebugHudController {
  const elHud = document.createElement("div");
  elHud.id = "ytdl-af-debug-hud";
  elHud.setAttribute("aria-hidden", "true");

  const elText = document.createElement("pre");
  elText.className = "ytdl-af-debug-text";

  const elBar = document.createElement("div");
  elBar.className = "ytdl-af-debug-bar";
  const elFill = document.createElement("div");
  elFill.className = "ytdl-af-debug-bar-fill";
  elBar.append(elFill);

  elHud.append(elText, elBar);
  elMount.append(elHud);

  log.debug("hud mounted");

  return {
    update(info) {
      const videoSnap = mediaSnapshot(info.elVideo);
      const audioSnap = mediaSnapshot(info.elAudio);
      const duration = info.elVideo?.duration && Number.isFinite(info.elVideo.duration)
        ? info.elVideo.duration
        : 0;
      const time = info.elVideo?.currentTime ?? 0;
      const ahead = bufferAheadSeconds(info.elVideo, time);
      const bufferedEnd = (() => {
        if (!info.elVideo) {
          return 0;
        }
        try {
          const ranges = info.elVideo.buffered;
          if (!ranges.length) {
            return 0;
          }
          return ranges.end(ranges.length - 1);
        } catch {
          return 0;
        }
      })();

      const pct = duration > 0 ? Math.min(100, (bufferedEnd / duration) * 100) : 0;
      elFill.style.width = `${pct.toFixed(1)}%`;

      const drift = info.elAudio && info.elVideo
        ? (info.elAudio.currentTime - info.elVideo.currentTime).toFixed(3)
        : "n/a";

      elText.textContent = [
        `st=${info.state} gen=${info.generation} q=${info.qualityLabel} want=${info.wantsPlaying ? 1 : 0}`,
        `t=${time.toFixed(2)}/${duration ? duration.toFixed(1) : "?"} ahead=${ahead.toFixed(1)}s bufEnd=${bufferedEnd.toFixed(1)}`,
        `V: p=${videoSnap?.paused ? 1 : 0} rs=${videoSnap?.readyState} ns=${videoSnap?.networkState} mut=${videoSnap?.muted ? 1 : 0} [${formatBuffered(info.elVideo)}]`,
        `A: p=${audioSnap?.paused ?? "-"} rs=${audioSnap?.readyState ?? "-"} mut=${audioSnap?.muted ?? "-"} drift=${drift} [${formatBuffered(info.elAudio)}]`
      ].join("\n");
    },
    dispose() {
      elHud.remove();
    }
  };
}
