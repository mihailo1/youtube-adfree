# Compaction instructions (yt-addfree only)

Paste into `/compact` or use as the compact summary seed.

---

## Scope

**Only** `~/Documents/reps.nosync/yt-addfree` (YouTube Ad-Free extension). Ignore filler/other projects.

## Version / git

- **v1.2.1** (hotkeys, quality submenu, session logs, chapters late-merge, Always boot, alpha pack)
- Prior pushed baseline: **v1.1.1** (Always Ad-Free toggle fix); **v1.1.0** MSE/chapters

## Must preserve

1. **Architecture**
   - WXT MV3; Vidstack single-rendition + `PlaybackEngine` + MSE dual SourceBuffer
   - page-proxy ANDROID_VR resolve (extension-origin 403)
   - youtube-park park → unload after ready → reload on disable
   - Overlay root **fixed on `document.documentElement`**, not inside `#movie_player`
   - Never reparent ad-free iframe after create

2. **v1.2.x product**
   - Hotkeys, quality-pref, quality **Settings submenu** (no floating chip)
   - Always Ad-Free early-hide + preferPlay + resolve retry without unpark
   - Session log export: popup Settings → Diagnostics
   - Chapters: videoId + duration fit; late `set-chapters` bridge
   - Logs: default **info**, no STAGE

3. **Build**
   - `nvm use 20 && pnpm build` → `.output/chrome-mv3/`
   - Alpha: `pnpm run alpha:pack` → zip + `docs/ALPHA-TESTING.md`

4. **Docs**
   - `docs/SESSION-NOTES.md` (source of truth)
   - `docs/CONTINUE-PROMPT.md`, `docs/ALPHA-TESTING.md`
   - `docs/mse-phase3.md` draft **deferred**
   - Optional: `docs/mse-overview.md`, phase1/2

5. **Invariants** — see SESSION-NOTES “Invariants”

## Drop from compact

- Full STAGE timelines / console spam once summarized
- Intermediate flicker debug iterations (keep final overlay + boot rules)
- MSE Phase 3 implementation detail until started

## After compact — optional next

1. Alpha feedback  
2. MSE Phase 3 if scrub latency is the goal  
3. Chapters edge cases if still empty after late merge  

## Paste block

```
COMPACT yt-addfree only @ ~/Documents/reps.nosync/yt-addfree v1.2.1.

Keep: fixed overlay on documentElement; Always Ad-Free boot (early-hide, resolve retry no unpark, preferPlay); single-rendition engine+MSE; quality Settings submenu; session Diagnostics export; chapters videoId-scoped + late set-chapters; no STAGE; build nvm20+pnpm build; alpha-pack docs/ALPHA-TESTING.md; mse-phase3 deferred.

Read docs/SESSION-NOTES.md + CLAUDE.md. Ignore other projects.
```
