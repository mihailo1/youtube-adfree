# Session notes — Ad-Free player (2026-07-28)

Source of truth after context compact. **v1.1.1** on `main` / GitHub.

## Projects

| Project | Path | Status |
|---------|------|--------|
| **yt-addfree** | `~/Documents/reps.nosync/yt-addfree` | **v1.1.1** on `main` / GitHub |
| **filler** | `~/Documents/reps.nosync/filler` | Pushed (`v1.4.1`) |

---

## v1.1.1 — Always Ad-Free toggle fix

| Issue | Fix |
|-------|-----|
| ⚙ Settings → Always Ad-Free appeared but **always flipped back to Off** | Double-fire: `pointerup` on switch + `click` on row → `true` then immediate `false` |
| Settings panel portaled outside player (earlier) | Document-wide inject + `menuContainer = #player-wrap`; styles not tied to `#player-wrap` only |
| | Single click path, `pointer-events: none` on decorative checkbox, 350 ms debounce + busy guard |

**Files:** `src/lib/ad-free/default-menu-item.ts`, `main.ts` (`menuContainer`), `player.css`

---

## v1.1.0 — what shipped

### A. YouTube chapters
- `src/lib/ad-free/chapters.ts` — `markersMap` / engagementPanels / `chapterRenderer` → WebVTT
- Payload + `mergePageChapters()` when ANDROID_VR omits markers
- `<track kind="chapters">` + scrubber segments (~3px gaps) + controls show **current chapter title**
- Laconic chapters menu (title + time chip; close on select)

### B. UI / chrome
- Minimal red-ring spinner; Ad-Free chip + quality chip
- Debug HUD removed
- Volume ↔ time ↔ chapter title: **20px** equal gaps; `/` divider balanced
- Top chips hide with controls idle (`controls-visible` bridge + `ytp-autohide`)

### C. Storage (no DevTools required)
1. BG `storage.session.setAccessLevel(TRUSTED_AND_UNTRUSTED_CONTEXTS)`
2. CS → `StoreAdFreeStreamPayload` message → BG writes session

### D. MSE (adaptive avc1/av01)
- Dual SourceBuffer; sidx time→byte; **full MediaSource reload** scrub outside buffer
- Always set `mediaSource.duration` (else mid-file `currentTime→0` hang)
- Init/sidx cache; parallel A/V init; skip moof-align on sidx
- Mid: stop-on-first-buffer; dual-sidx parallel prefetch; **no 2% sidx audio bias**
- `ensureAvPlayable` extends short track first (don’t clear good audio)
- `restoreMsePlayhead` if playhead snaps to 0 while mid buffer exists

### E. Always Ad-Free (default off)
- Option `isAdFreeDefault` — player Settings checkbox + popup Integration
- Auto-enable on `/watch` when on; manual switch to YouTube sticks for that videoId
- Helpers: `default-pref.ts`, `default-menu-item.ts`

### F. State + memory on switch
- Keep-alive iframe; preserve **wasPlaying** / volume / time both ways
- After Ad-Free ready: **`youtubePark.unload()`** — stopVideo + detach `<video>` src
- Switch back: **`reload(videoId, t, { play, volume, … })`** via loadVideoById / cueVideoById

### G. Build
```bash
cd ~/Documents/reps.nosync/yt-addfree
nvm use 20
pnpm build   # → .output/chrome-mv3/
```

---

## Key files

```
src/lib/ad-free/chapters.ts
src/lib/ad-free/storyboard.ts
src/lib/ad-free/content-overlay.ts
src/lib/ad-free/quality-menu.ts
src/lib/ad-free/default-pref.ts
src/lib/ad-free/default-menu-item.ts
src/lib/ad-free/playback-engine.ts
src/lib/ad-free/youtube-park.ts          # park + unload + reload
src/lib/ad-free/mse/*                    # dual-track MSE
src/entrypoints/ad-free-player/main.ts
src/entrypoints/ad-free-player/player.css
src/entrypoints/ad-free-watch.content.ts
src/entrypoints/background/index.ts
src/entrypoints/background/handlers/ad-free-handlers.ts
docs/SESSION-NOTES.md | CONTINUE-PROMPT.md | COMPACTION-INSTRUCTIONS.md
docs/mse-*.md
```

---

## Invariants (do not break)

1. **No multi-src Vidstack** — single-rendition engine + quality-menu only  
2. **youtube-park** while Ad-Free active; **unload** after ready; **reload** on disable  
3. **page-proxy** for InnerTube streams (extension-origin → 403)  
4. **No end-user console / DevTools** steps  
5. CS session storage only via background message  
6. Agent rebuilds after src changes: `nvm use 20 && pnpm build`

---

## Open / optional later

- [ ] Live verify: mid-open play, far scrub, chapter jump, default-on, unload/reload
- [ ] True incremental MSE without full MediaSource reload
- [ ] Autoplay polish when default-on lands mid-ad

---

## Dev vs user

| Role | Steps |
|------|--------|
| End user | Load extension → YouTube → Ad-Free (or enable Always Ad-Free) |
| After code change | `nvm use 20 && pnpm build` → reload unpacked → hard refresh YT |
| Hot loop | `pnpm dev` |
