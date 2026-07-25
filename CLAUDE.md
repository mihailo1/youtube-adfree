# Stack

- pnpm
- WXT extension framework
- Svelte 5 (popup / download UI)
- Vidstack (ad-free in-page player)
- TypeScript
- @ffmpeg/ffmpeg for download muxing
- @webext-core/messaging
- Chromium MV3 + Firefox MV3

# Ad-free player

- Content script: `src/entrypoints/ad-free-watch.content.ts` — toggle + iframe overlay on `#movie_player`
- Player page: `src/entrypoints/ad-free-player/` — Vidstack; `?embed=1` for in-page mode
- Shared lib: `src/lib/ad-free/` — stream resolve, captions, bridge, keep-playing
- Background: `src/entrypoints/background/handlers/ad-free-handlers.ts` — resolve via page-proxy
- Prefer page-proxy for InnerTube; extension-origin fetch often gets HTTP 403

# Code style

- Use the `browser` namespace
- Early returns, async/await, functional style
- Prefer `for-of` over `.forEach`
- Avoid comments unless necessary
- Element variables: `el` prefix; booleans: `is` prefix
- Module constants: `SCREAMING_SNAKE_CASE`

# Storage

- Stream payloads: `browser.storage.session` key `ad-free-stream:{videoId}`
- Visitor data cache: `browser.storage.local` key `ad-free-player-visitor-data`

# Quality gates

```sh
pnpm compile
pnpm lint
pnpm build
```
