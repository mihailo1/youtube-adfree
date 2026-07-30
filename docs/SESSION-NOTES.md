# Session notes — Ad-Free player (2026-07-30)

Source of truth after context compact. **v1.2.5** on `main`.

## Projects

| Project | Path | Status |
|---------|------|--------|
| **yt-addfree** | `~/Documents/reps.nosync/yt-addfree` | **v1.2.5** |
| **filler** | out of scope this session | — |

---

## v1.2.5 — overlay stacking + scroll polish

| Fix | Detail |
|-----|--------|
| **Share / YT modals under player** | Fixed shell was `z-index: max`; now default **1990** (below masthead ~2020). Open iron-overlay/share → `.is-under-modal` drops under dialog stack. |
| **Download panel under player** | Watch `tp-yt-iron-dropdown` + `.ytdl-panel` → **`z-index: 20000 !important`** (above shell). |
| **Scroll slip** | CSS **anchor positioning** ties shell to `#movie_player` on compositor; JS `translate3d` fallback. |
| **Black stripe flicker under toolbar** | Removed JS **`clip-path`** under masthead (lagged vs anchors). Masthead covers video via z-index like native YT. |
| **Miniplayer** | `.is-miniplayer` raises shell to 10000 so corner player stays above page chrome. |

### Key files (1.2.5)

```
src/lib/ad-free/content-overlay.ts
src/entrypoints/youtube-main.content/watch-button/watch-button.css
src/components/download-options-panel/DownloadOptionsPanel.svelte
```

## v1.2.4 — Always Ad-Free row padding

| Fix | Detail |
|-----|--------|
| **Always Ad-Free menu row** | `.ytdl-always-adfree` padding `0 1rem` for horizontal inset in Settings ⚙ |

## v1.2.3 — stream resilience, theater, live URLs, grid cleanup

| Fix / feature | Detail |
|---------------|--------|
| **MSE range 403 / network** | Mid-playback sticky 403 or `Failed to fetch` → re-resolve ANDROID_VR URLs + exponential pump backoff; cold load/seek retry once. Toast «Refreshing stream…». |
| **Start prefetch cushion** | After first buffer, fill to `PLAY_AHEAD_S` (≥3s) so high-bitrate 1080p does not underrun after one 512KB chunk. |
| **Theater (wide) button** | YT `ytp-size-button` icons (wide / default); hotkey **t**; toggles `ytd-watch-flexy.theater` on parent page; survives Ad-Free ↔ YouTube. |
| **`/live/VIDEO_ID` + shorts/embed** | `getVideoId()` no longer watch-only — live/premiere URLs work; button mounts. |
| **Stuck black cover** | Early cover watchdog + `releaseCover` when Always Ad-Free never enables or pref turns off. |
| **Dev extended logs** | Settings → Diagnostics → toggle; extra session lines (`log.ext`) for nav/cover/auto-enable skips. |
| **Grid download chips off** | No per-video `data-ytdl-grid-item` buttons on home/search/related (ad-free fork). Playlist page UI kept. |

### Key files (1.2.3)

```
src/lib/ad-free/mse/range-fetch.ts       # 403/network classification
src/lib/ad-free/mse/mse-controller.ts    # refreshUrls, backoff, start fill
src/lib/ad-free/playback-engine.ts       # refreshQuality, load/seek retry
src/lib/ad-free/theater-button.ts        # YT size icons
src/lib/ad-free/youtube-theater.ts       # flexy.theater toggle
src/lib/ad-free/content-dom.ts           # /live /shorts /embed videoId
src/lib/ad-free/debug-log.ts             # extended logs + log.ext
src/entrypoints/ad-free-watch.content.ts # cover watchdog, releaseCover
src/entrypoints/ad-free-player/main.ts   # refreshQuality + theater
src/entrypoints/youtube.content/ui/page-router.ts  # no grid inject
src/entrypoints/popup/settings/sections/DiagnosticsSettings.svelte
```

### Build

```bash
cd ~/Documents/reps.nosync/yt-addfree
nvm use 20
pnpm build          # → .output/chrome-mv3/
pnpm run alpha:pack # zip for testers
```

---

## v1.2.2 — chrome layout fix

| Fix | Detail |
|-----|--------|
| **Top-right control flash** | Force `media-video-layout.smallWhen = "never"` + `menuGroup = "bottom"` |
| **Reveal gate** | Wait until bottom chrome measured before `is-chrome-ready` |
| **Always Ad-Free row** | Spacing polish |

## v1.2.1 — alpha / polish

Hotkeys, quality memory, quality Settings submenu, Always Ad-Free boot, session Diagnostics, chapters late merge, STAGE removed.

### Overlay architecture

- Root **`position: fixed` on `document.documentElement`**
- Prefer CSS **`position-anchor` → `#movie_player`**; never reparent iframe after create
- z-index: shell **1990** (under masthead) / miniplayer **10000** / under-modal / fullscreen max
- Download dropdown **20000**; no masthead `clip-path`
- Session log: `session-log.ts` + BG handlers

---

## Invariants (do not break)

1. **No multi-src Vidstack** — single-rendition engine + quality menu  
2. **youtube-park** while active; unload after ready; reload on disable  
3. **page-proxy** for InnerTube  
4. **Overlay root on documentElement (fixed)** — not inside `#movie_player`  
5. **Never reparent iframe** after create  
6. **No end-user DevTools** for storage  
7. CS stream via **StoreAdFreeStreamPayload**  
8. Rebuild: `nvm use 20 && pnpm build`  
9. Chapters: videoId + duration fit; late merge OK  
10. **`media-video-layout.smallWhen = "never"`** — embed height often &lt; 380  
11. **Video id from URL** — `/watch?v=`, `/live/`, `/shorts/`, `/embed/`  
12. **Range 403** → re-resolve, not hard fail forever  
13. **Shell z-index below masthead** (no JS masthead clip-path); download panel above shell  
14. **CSS anchor** (or JS translate fallback) for scroll glue  

---

## Open / optional later

- MSE Phase 3 (incremental rebuffer) — draft deferred  
- Live streams may still fail if ANDROID_VR lacks rangeable fMP4  
- Quieter chrome measurement logs  
- Alpha feedback loop  
