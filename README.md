# YouTube Ad-Free

**v1.0.0** — MV3 browser extension that swaps the YouTube watch player for an **ad-free in-page player**, with quality selection, captions, background playback, and the original download tooling from the upstream project.

**Repo:** [mihailo1/youtube-adfree](https://github.com/mihailo1/youtube-adfree)

Built on top of [avi12/youtube-downloader](https://github.com/avi12/youtube-downloader) (WXT + Svelte 5 + InnerTube / ANDROID_VR streaming).

## Features

- **In-page toggle** — red **Ad-Free** control on the top-left of the YouTube player; no extra tab
- **Ad-free playback** — streams via ANDROID_VR InnerTube (direct CDN URLs), not the YouTube HTML5 ad pipeline
- **Quality menu** — Vidstack Settings → Quality (multi-rendition sources)
- **Captions** — WebVTT tracks from the player response / page data (Settings → Captions)
- **State sync** — switching between YouTube and Ad-Free keeps current time (and pauses on switch)
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
2. Click **Ad-Free** (top-left on the video)
3. Wait for the overlay player to load, then press play
4. Click **YouTube** on the same control to switch back (position is preserved; both sides pause on switch)
5. In the Ad-Free player: **Settings** for quality and captions

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
| `src/entrypoints/ad-free-watch.content.ts` | Injects toggle, mounts keep-alive iframe overlay, syncs state with YouTube |
| `src/entrypoints/ad-free-player/` | Vidstack player page (`embed=1` for in-page iframe) |
| `src/lib/ad-free/resolve-stream.ts` | ANDROID_VR player API → quality list + captions |
| `src/lib/ad-free/bridge.ts` | `postMessage` protocol between watch page and player iframe |
| `src/lib/ad-free/keep-playing.ts` | Background playback keep-alive for the embed player |
| `src/entrypoints/background/handlers/ad-free-handlers.ts` | Resolves streams via YouTube-tab page-proxy (avoids InnerTube 403) |

Stream resolution prefers the existing page-proxy path (`page-sabr-fetch` + `visitorData` substitution) used by the downloader on Firefox/anti-bot gates.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the upstream download pipeline, SABR fallbacks, and messaging map.

## Tech stack

| Package | Purpose |
| --- | --- |
| [WXT](https://wxt.dev) | Extension framework (MV3) |
| [Svelte 5](https://svelte.dev) | Popup / download UI |
| [Vidstack](https://github.com/vidstack/player) | Ad-free player UI |
| [googlevideo](https://npm.im/googlevideo) | SABR / download path |
| [@ffmpeg/core](https://ffmpegwasm.netlify.app) | In-browser mux for downloads |

## Versioning

This fork is versioned independently starting at **1.0.0**. Upstream downloader history remains in git history.

## License

MIT — same as upstream. Credit to [Avi](https://avi12.com) / [youtube-downloader](https://github.com/avi12/youtube-downloader) for the download architecture and InnerTube integration.
