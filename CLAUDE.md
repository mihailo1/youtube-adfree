# Stack

- pnpm
- WXT extension framework
- Svelte 5 (popup / download UI)
- Vidstack (ad-free in-page player shell)
- TypeScript
- @ffmpeg/ffmpeg for download muxing
- @webext-core/messaging
- Chromium MV3 + Firefox MV3

# Session docs

- `docs/SESSION-NOTES.md` — latest work log (**v1.1.0**)
- `docs/CONTINUE-PROMPT.md` — paste-ready agent prompt
- `docs/COMPACTION-INSTRUCTIONS.md` — Grok `/compact` keep/drop block
- Parent compact: `../SESSION-COMPACT.md`

# Ad-free player

- Content script: `src/entrypoints/ad-free-watch.content.ts` — toggle + auto **Always Ad-Free** + iframe root **absolute inside `#movie_player`** (never reparent iframe after create — Chromium reloads document on move)
- Player page: `src/entrypoints/ad-free-player/` — Vidstack shell + PlaybackEngine; `?embed=1` for in-page mode
- Shared lib: `src/lib/ad-free/` — stream resolve, captions, **chapters**, storyboard, bridge, keep-playing, youtube-time, content-dom, content-overlay, content-yt-snapshot, content-bridge-client, **youtube-park**, **playback-engine**, **quality-menu**, **default-pref**, **default-menu-item**, **mse/**
- Background: `src/entrypoints/background/handlers/ad-free-handlers.ts` — resolve via page-proxy
- Content script modules:
  - `content-dom.ts` — DOM IDs, YtPlayerEl type, DOM-lookup helpers
  - `content-overlay.ts` — Layout tracking, CSS, button, overlay lifecycle; chips hide with `ytp-autohide` / `is-controls-hidden`
  - `content-yt-snapshot.ts` — capture/apply/pause YouTube snapshot (one-shot)
  - `youtube-park.ts` — **park** + **unload** (detach media) + **reload** on switch back
  - `content-bridge-client.ts` — postMessage protocol with event.source checks
  - `default-pref.ts` / player `default-menu-item.ts` — `isAdFreeDefault` option
  - `youtube-time.ts` — parseYouTube time helpers
- Player:
  - `playback-engine.ts` — FSM + generation token; single rendition; MSE path; barrier seek
  - `quality-menu.ts` — custom quality picker (never multi-src Vidstack)
  - `keep-playing.ts` — blur keep-alive; gated by `isSafeToResume()`
- Prefer page-proxy for InnerTube; extension-origin fetch often gets HTTP 403
- **Chapters:** extract from `markersMap` / engagementPanels (`chapters.ts`); merge from watch-page `ytInitialData` when ANDROID_VR omits them; attach as `<track kind="chapters">` VTT; ~3px scrubber gaps; laconic list closes on select; never set `.vds-slider-track { background: transparent }` under chapters
- **Always Ad-Free:** `isAdFreeDefault` default **false**; auto-enable on watch; manual YouTube sticks for that videoId
- **MSE duration:** always set `mediaSource.duration` (hint + sidx) — missing duration causes mid-file `currentTime→0` hang on play
- **MSE mid A/V:** `ensureAvPlayable` extends the short track first; do not clearBuffered audio when it already covers wall-clock seek target
- **Playhead:** `restoreMsePlayhead` if playhead leaves buffered mid range (snap-to-0)

## Architecture invariants (Ad-Free)

### YouTube hard park + unload
- One-shot `pauseVideo` is **not** enough. While Ad-Free is active, `youtube-park` must:
  - mute + volume 0 + pause on API and `<video>`
  - capture-phase block of `play`/`playing` on YT video
  - no-op wrap `playVideo` / `loadVideoById` when present
  - poll ~500ms to re-enforce
  - after Ad-Free ready: **`unload()`** — `stopVideo` + detach `src`/`srcObject`/`load()` to free decoder memory
- On disable: **`reload(videoId, time, { play, volume, … })`** (loadVideoById / cueVideoById), not just unpark + seek
- Unpark/reload on disable and SPA navigation

### Single-rendition engine
- **Never** assign multi-src arrays to Vidstack (caused multi-GB buffers + mini-repeats).
- Exactly one video URL loaded at a time.
- Progressive (muxed) is default when available; adaptive optional via custom quality menu.
- Quality change: dispose companion audio, hard-reset provider `<video>` buffers, load one src, wait can-play, seek once, then play.
- Generation token: every seek/quality/set-state increments `gen`; stale async paths no-op.
- States: `idle | loading | ready | playing | seeking | switching | error`
- `lastKnownGoodTime` only updates in `ready`/`playing`.

### Adaptive companion audio barrier
```
seek/load:
  suspend audio (pause+mute)
  seek/load video → wait seeked + canplay
  seek audio → wait seeked
  if wantsPlay: play video; on playing → align + play/unmute audio
```
Never unlock audio before video is truly playing.

### Keep-playing
- Spoof visibility + poll re-`play()` while `wantsPlaying`.
- **Must not** resume when engine is in `loading`/`seeking`/`switching` (`isSafeToResume`).
- Clear `wantsPlaying` on intentional user pause (recent pointer/key before `pause`).
- `allowPause()` for bridge/system pauses.
- `dispose()` restores ALL spoofed properties + `HTMLMediaElement.prototype.pause`.

### Time sync with YouTube
- Seed Ad-Free from original player `currentTime`, else URL `t=` / `start=`.
- On toggle either way: preserve **wasPlaying**, volume, rate (no force-pause wipe).
- On toggle back: `reload` YT from Ad-Free snapshot (handles unloaded media).

## Bridge security

- Content script: `event.source === iframe.contentWindow`
- Player: `event.source === window.parent`

# Code style

- Use the `browser` namespace
- Early returns, async/await, functional style
- Prefer `for-of` over `.forEach`
- Avoid comments unless necessary — **except** document non-obvious media/geo workarounds here
- Element variables: `el` prefix; booleans: `is` prefix
- Module constants: `SCREAMING_SNAKE_CASE`

# Storage

- Stream payloads: `browser.storage.session` key `ad-free-stream:{videoId}` (via BG message)
- Visitor data cache: `browser.storage.local` key `ad-free-player-visitor-data`
- Always Ad-Free: `options.isAdFreeDefault` in `local:options` (default `false`)

## Stream payload field derivation

- `deriveSelectedFields(selected)` in resolve-stream.ts — used in build/normalize/persist paths
- `buildAdFreeStreamPayload` merges progressive + adaptive; default = best progressive else best adaptive

# MSE (Phase 0–2)

- Overview: `docs/mse-overview.md`
- Lib: `src/lib/ad-free/mse/` — `mse-controller`, `fragment-index` (sidx), `mp4-boxes`, `range-fetch`, `spike-player`
- Spike: `mse-spike.html` — `docs/mse-spike.md`
- Phase 1: engine MSE for adaptive avc1/av01 — `docs/mse-phase1.md`
- Phase 2: sidx + full-reload scrub — `docs/mse-phase2.md`
- Needs YouTube tab open for `ResolveAdFreeStream` page-proxy
- Spike: `chrome-extension://<id>/mse-spike.html?v=VIDEO_ID`

# Agent workflow (mandatory)

**After every code change that affects the extension, the agent MUST rebuild before telling the user to test.**

```sh
# Use Node ≥18 (nvm use 20 if shell defaults to old Node)
pnpm build
# output: .output/chrome-mv3
```

- Do **not** leave “rebuild yourself” as a user chore after edits to `src/`, player CSS, content scripts, or background.
- User still: Chrome → Extensions → reload unpacked (if not using `pnpm dev`) + hard-refresh YouTube watch tab.
- Prefer `pnpm build` for one-shot verify; `pnpm dev` only if a long edit session is already running.
- If `pnpm` missing after `nvm use`, use path that works (`corepack enable` / global pnpm / `npx pnpm`).

# Quality gates

```sh
pnpm compile
pnpm lint
pnpm build
```
