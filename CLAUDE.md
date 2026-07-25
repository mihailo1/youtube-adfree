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

- Content script: `src/entrypoints/ad-free-watch.content.ts` — toggle + **fixed** iframe root on `documentElement` (never reparent iframe — Chromium reloads document on move)
- Player page: `src/entrypoints/ad-free-player/` — Vidstack; `?embed=1` for in-page mode
- Shared lib: `src/lib/ad-free/` — stream resolve, captions, bridge, keep-playing, channel region list
- Background: `src/entrypoints/background/handlers/ad-free-handlers.ts` — resolve via page-proxy
- Prefer page-proxy for InnerTube; extension-origin fetch often gets HTTP 403

## Playback / quality / memory (important)

### Quality menu + buffers
- **UI:** pass **multi-src** quality list (with `width`/`height`) so Vidstack Settings → Quality works.
- **Load:** only the **selected** rendition should buffer. On quality change, soft-replace sources (preferred first), **dispose companion audio element**, reset provider `<video>` buffers, then wait for `can-play` before play.
- **Never** keep every quality fully buffered at once (caused 10–30GB RAM).
- Prefer progressive/muxed qualities when choosing a default (single demuxer path).

### Seek / quality switch UX
- Save `lastKnownGoodTime` on `time-update` only when **not** reloading.
- On quality change / source reload: do **not** set `src=""` then leave currentTime at 0 (timeline flash). Set new `src`, then restore time on `loaded-metadata` / `can-play` **once**.
- Do **not** start playback until `can-play` (or `playing` after seek) for the **new** stream — avoids mini audio/video repeat from partial old buffer.
- Companion audio (adaptive): stay **paused+muted** through `seeking`/`waiting`/`loadstart`; start only on real **`playing`**. Recreate `<audio>` on quality change so buffers GC.
- After seek: align audio clock on `seeked` but keep suspended until `playing`.

### Keep-playing (window blur)
- Spoof visibility + poll re-`play()` while `wantsPlaying`.
- Clear `wantsPlaying` on intentional user pause (recent pointer/key before `pause`).
- Use `allowPause()` for bridge/system pauses.

### Time sync with YouTube
- Always seed Ad-Free from original player `currentTime`, else URL `t=` / `start=` (`90`, `1m30s`, …).
- On toggle back to Ad-Free, always `set-state` with that time (warm iframe, no `src` reload).

## Region-hidden channel list

- Content: `src/entrypoints/channel-region-list.content.ts` on channel **Videos** and **Streams** tabs
- Lib: `src/lib/ad-free/channel-region-list.ts` — uploads `UU…` + tab browse with `gl=JO` (Jordan; multi-`gl` later)
- Channel id: meta/canonical/links/`channelMetadataRenderer` (not only first `channelId` in HTML)

# Code style

- Use the `browser` namespace
- Early returns, async/await, functional style
- Prefer `for-of` over `.forEach`
- Avoid comments unless necessary — **except** document non-obvious media/geo workarounds here
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
