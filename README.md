# YouTube Ad-Free

**v1.2.3** — MV3 browser extension that swaps the YouTube watch player for an **ad-free in-page player**, with MSE adaptive seek (auto re-resolve on CDN 403), theater/wide mode, chapters, YouTube-style hotkeys (incl. **t**), remembered quality (Settings ⚙ submenu), Always Ad-Free (`/watch` + `/live`), session diagnostic export, captions, background playback, and optional download tooling.

**Repo:** [mihailo1/youtube-adfree](https://github.com/mihailo1/youtube-adfree)

Built on top of [avi12/youtube-downloader](https://github.com/avi12/youtube-downloader) (WXT + Svelte 5 + InnerTube / ANDROID_VR streaming).

## Features

- **In-page toggle** — **Ad-Free** chip on the top-left of the YouTube player; no extra tab (`/watch`, `/live`, shorts)
- **Always Ad-Free** — optional default (off by default): Settings ⚙ in the player or popup → open watch pages in Ad-Free automatically; mid-ad entry autoplays content (not the ad clock)
- **Ad-free playback** — streams via ANDROID_VR InnerTube (direct CDN URLs), not the YouTube HTML5 ad pipeline
- **MSE adaptive** — dual-track Media Source; re-resolves stream URLs if googlevideo range fetch dies mid-play
- **Theater / wide** — YT size-button icons before fullscreen; hotkey `t`; keeps page layout when switching back
- **Chapters** — YouTube chapter markers on the scrubber + compact chapter list
- **Hotkeys** — YouTube-style: `j`/`l`, arrows, `m`, `f`, `c`, `t`, `0`–`9`, speed `<`/`>`, frame step, PiP `i`
- **Remember quality** — last chosen height/type restored on the next video
- **Quality menu** — Settings ⚙ → Quality submenu; engine single-rendition loads (no multi-src buffer bloat)
- **Diagnostics (alpha)** — popup Settings → download session log; optional **Dev extended logs**
- **Captions** — WebVTT tracks from the player response / page data (Settings → Captions)
- **State sync** — time, volume, rate, and play/pause intent preserved when switching YouTube ↔ Ad-Free
- **Unload original** — while Ad-Free is active the native player is parked and media is detached to free memory
- **Keep playing** — playback continues when you focus another OS window (best-effort against Chrome media pause)
- **Downloads** — full upstream download / playlist / FFmpeg mux pipeline remains available

## Install (development / alpha)

**Alpha testers:** see **[docs/ALPHA-TESTING.md](docs/ALPHA-TESTING.md)** (zip install + how to send session logs).

```sh
pnpm install
pnpm build          # → .output/chrome-mv3/
pnpm run alpha:pack # build + zip for sharing
```

1. Open `chrome://extensions` (or Edge / Brave equivalent)
2. Enable **Developer mode**
3. **Load unpacked** → select `.output/chrome-mv3` (or the unzipped alpha zip)

**Session diagnostics:** popup → Settings → **Diagnostics (alpha)** → Download log.

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
5. In the Ad-Free player: quality chip (top-right), chapters menu, **Settings** for captions and Always Ad-Free; keyboard shortcuts match YouTube. Downloads stay under the video (watch button).

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

This fork is versioned independently (current **1.1.1**). Upstream downloader history remains in git history.

## License

MIT — same as upstream. Credit to [Avi](https://avi12.com) / [youtube-downloader](https://github.com/avi12/youtube-downloader) for the download architecture and InnerTube integration.
