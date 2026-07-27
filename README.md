# YouTube Ad-Free

**v1.1.0** — MV3 browser extension that swaps the YouTube watch player for an **ad-free in-page player**, with MSE adaptive seek, chapters, quality selection, captions, background playback, and the original download tooling from the upstream project.

**Repo:** [mihailo1/youtube-adfree](https://github.com/mihailo1/youtube-adfree)

Built on top of [avi12/youtube-downloader](https://github.com/avi12/youtube-downloader) (WXT + Svelte 5 + InnerTube / ANDROID_VR streaming).

## Features

- **In-page toggle** — **Ad-Free** chip on the top-left of the YouTube player; no extra tab
- **Always Ad-Free** — optional default (off by default): Settings ⚙ in the player or popup → open watch pages in Ad-Free automatically
- **Ad-free playback** — streams via ANDROID_VR InnerTube (direct CDN URLs), not the YouTube HTML5 ad pipeline
- **MSE adaptive** — dual-track Media Source for high-quality adaptive streams; reliable mid-file scrub
- **Chapters** — YouTube chapter markers on the scrubber + compact chapter list
- **Quality menu** — custom chip + engine single-rendition loads (no multi-src buffer bloat)
- **Captions** — WebVTT tracks from the player response / page data (Settings → Captions)
- **State sync** — time, volume, rate, and play/pause intent preserved when switching YouTube ↔ Ad-Free
- **Unload original** — while Ad-Free is active the native player is parked and media is detached to free memory
- **Keep playing** — playback continues when you focus another OS window (best-effort against Chrome media pause)
- **Downloads** — full upstream download / playlist / FFmpeg mux pipeline remains available

## Install (development build)

```sh
pnpm install
pnpm build
```

1. Open `chrome://extensions` (or Edge / Brave equivalent)
2. Enable **Developer mode**
3. **Load unpacked** → select `.output/chrome-mv3`

Firefox:

```sh
pnpm build:firefox
```

Then load `.output/firefox-mv3` via `about:debugging` → This Firefox → Load Temporary Add-on.

## Usage

1. Open a YouTube **watch** page
2. Click **Ad-Free** (top-left on the video) — or enable **Always Ad-Free** in player Settings / popup
3. Wait for the overlay player to load (auto-resumes if the original was playing)
4. Click **YouTube** on the same control to switch back (position and play intent preserved)
5. In the Ad-Free player: quality chip (top-right), chapters menu, **Settings** for captions and Always Ad-Free

## Develop

```sh
pnpm install
pnpm dev            # Chrome, rebuild + reload
pnpm dev:firefox    # Firefox
pnpm compile        # Typecheck
pnpm lint
```

## Architecture (ad-free path)

| Piece | Role |
| --- | --- |
| `src/entrypoints/ad-free-watch.content.ts` | Toggle, overlay, auto-enable default, park/unload YouTube |
| `src/lib/ad-free/youtube-park.ts` | Park + **unload** media from memory; **reload** on switch back |
| `src/entrypoints/ad-free-player/` | Vidstack shell + single-rendition PlaybackEngine |
| `src/lib/ad-free/playback-engine.ts` | FSM seek/quality/MSE (generation token; no multi-src buffers) |
| `src/lib/ad-free/mse/` | Dual SourceBuffer controller, sidx index, range fetch |
| `src/lib/ad-free/quality-menu.ts` | Custom quality picker (progressive default, adaptive optional) |
| `src/lib/ad-free/chapters.ts` | Chapter extract → VTT track |
| `src/lib/ad-free/default-pref.ts` | Always Ad-Free option (`isAdFreeDefault`) |
| `src/lib/ad-free/resolve-stream.ts` | ANDROID_VR player API → quality list + captions + chapters |
| `src/lib/ad-free/bridge.ts` | `postMessage` protocol between watch page and player iframe |
| `src/lib/ad-free/keep-playing.ts` | Blur keep-alive (gated by engine `isSafeToResume`) |
| `src/entrypoints/background/handlers/ad-free-handlers.ts` | Resolves streams via YouTube-tab page-proxy (avoids InnerTube 403) |

Adaptive avc1/av01 qualities use MSE when supported; progressive remains a stable fallback.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full download pipeline and Ad-Free FSM details.  
Session / agent notes: [docs/SESSION-NOTES.md](docs/SESSION-NOTES.md).

## Tech stack

| Package | Purpose |
| --- | --- |
| [WXT](https://wxt.dev) | Extension framework (MV3) |
| [Svelte 5](https://svelte.dev) | Popup / download UI |
| [Vidstack](https://github.com/vidstack/player) | Ad-free player UI |
| [googlevideo](https://npm.im/googlevideo) | SABR / download path |
| [@ffmpeg/core](https://ffmpegwasm.netlify.app) | In-browser mux for downloads |

## Versioning

This fork is versioned independently (current **1.1.0**). Upstream downloader history remains in git history.

## License

MIT — same as upstream. Credit to [Avi](https://avi12.com) / [youtube-downloader](https://github.com/avi12/youtube-downloader) for the download architecture and InnerTube integration.
