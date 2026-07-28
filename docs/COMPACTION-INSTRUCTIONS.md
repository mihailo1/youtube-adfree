# Compaction instructions (yt-addfree only)

Paste into `/compact` or use as the compact summary seed.

---

## Scope

**Only** `~/Documents/reps.nosync/yt-addfree` (YouTube Ad-Free extension). Ignore filler/other projects.

## Version / git

- **v1.2.2** — force large video layout (`smallWhen=never`); chrome bottom controls
- **v1.2.1** — alpha polish, session logs, quality submenu, chapters late-merge
- Prior: **v1.1.1** Always toggle; **v1.1.0** MSE/chapters

## Must preserve

1. **Architecture**
   - WXT MV3; Vidstack single-rendition + `PlaybackEngine` + MSE dual SourceBuffer
   - page-proxy ANDROID_VR resolve
   - youtube-park park → unload after ready → reload on disable
   - Overlay root **fixed on `document.documentElement`**, not `#movie_player`
   - Never reparent ad-free iframe after create
   - **`media-video-layout.smallWhen = "never"`** + `menuGroup = "bottom"`  
     (default smallWhen is `width < 576 \|\| height < 380`; YT embed ~378h put caption/settings/fs at top y≈2)

2. **v1.2.x product**
   - Hotkeys, quality-pref, quality Settings submenu
   - Always Ad-Free early-hide + preferPlay + resolve retry without unpark
   - Session log export: popup Settings → Diagnostics
   - Chapters: videoId + duration fit; late `set-chapters`
   - Logs: default **info**, no STAGE

3. **Build**
   - `nvm use 20 && pnpm build` → `.output/chrome-mv3/`
   - Alpha: `pnpm run alpha:pack` → zip + `docs/ALPHA-TESTING.md`

4. **Docs**
   - `docs/SESSION-NOTES.md` (source of truth)
   - `docs/CONTINUE-PROMPT.md`, `docs/ALPHA-TESTING.md`
   - `docs/mse-phase3.md` draft **deferred**

5. **Invariants** — see SESSION-NOTES

## Drop from compact

- Full chrome wait frame dumps once summarized (root cause: smallWhen height &lt; 380)
- Intermediate flicker debug iterations

## After compact — optional next

1. Alpha feedback  
2. MSE Phase 3 if scrub latency is the goal  

## Paste block

```
COMPACT yt-addfree only @ ~/Documents/reps.nosync/yt-addfree v1.2.2.

Keep: fixed overlay on documentElement; Always Ad-Free boot; single-rendition engine+MSE; quality Settings submenu; session Diagnostics; chapters videoId-scoped + late set-chapters; media-video-layout.smallWhen="never" (embed h≈378 → small top chrome otherwise); no STAGE; build nvm20+pnpm build; alpha-pack docs/ALPHA-TESTING.md; mse-phase3 deferred.

Read docs/SESSION-NOTES.md + CLAUDE.md. Ignore other projects.
```
