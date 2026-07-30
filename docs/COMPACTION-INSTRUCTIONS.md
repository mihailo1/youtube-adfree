# Compaction instructions (yt-addfree only)

Paste into `/compact` or use as the compact summary seed.

---

## Scope

**Only** `~/Documents/reps.nosync/yt-addfree` (YouTube Ad-Free extension). Ignore filler/other projects.

## Version / git

- **v1.2.5** — overlay stacking (modals/download/masthead) + CSS anchor scroll; no masthead clip-path
- **v1.2.4** — Always Ad-Free settings row `padding: 0 1rem`
- **v1.2.3** — MSE URL refresh on 403; theater button; `/live/` ids; cover watchdog; extended logs; no grid download chips
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
   - Shell **z-index 1990** (below masthead ~2020); **no JS clip-path** under toolbar
   - CSS **`position-anchor` / `anchor()`** to `#movie_player` when supported; else `translate3d`
   - Download panel iron-dropdown **z-index 20000**; share → `.is-under-modal`
   - Miniplayer → `.is-miniplayer` (10000); fullscreen max
   - **`media-video-layout.smallWhen = "never"`** + `menuGroup = "bottom"`  
     (default smallWhen is `width < 576 \|\| height < 380`; YT embed ~378h put caption/settings/fs at top y≈2)
   - **MSE range death**: re-resolve stream URLs + backoff (do not only retry same range)
   - **Video id**: `/watch?v=`, `/live/ID`, `/shorts/`, `/embed/`

2. **v1.2.x product**
   - Hotkeys, quality-pref, quality Settings submenu
   - Always Ad-Free early-hide + preferPlay + resolve retry; cover watchdog / releaseCover
   - Theater wide button (YT icons, **t**) via parent flexy.theater
   - Session log export: popup Settings → Diagnostics (+ **Dev extended logs**)
   - Chapters: videoId + duration fit; late `set-chapters`
   - Logs: default **info**, no STAGE; extended via `log.ext`
   - No home/search grid download chips

3. **Build**
   - `nvm use 20 && pnpm build` → `.output/chrome-mv3/`
   - Alpha: `pnpm run alpha:pack` → zip + `docs/ALPHA-TESTING.md`

4. **Docs**
   - `docs/SESSION-NOTES.md` (source of truth)
   - `docs/CONTINUE-PROMPT.md`, `docs/ALPHA-TESTING.md`
   - `docs/mse-phase3.md` draft **deferred**

5. **Invariants** — see SESSION-NOTES

## Drop from compact

- Full chrome wait frame dumps (root cause: smallWhen height &lt; 380)
- Intermediate 403 log dumps once summarized (re-resolve + backoff shipped)
- Grid download injection history (disabled)
- Intermediate max-z-index / clip-path experiments (replaced by masthead stacking + anchors)

## After compact — optional next

1. Alpha feedback  
2. Live stream format edge cases  
3. MSE Phase 3 if scrub latency is the goal  

## Paste block

```
COMPACT yt-addfree only @ ~/Documents/reps.nosync/yt-addfree v1.2.5.

Keep: fixed overlay on documentElement; CSS anchor to #movie_player (JS translate fallback);
z-index 1990 under masthead (no clip-path); under-modal for share; download dropdown 20000;
miniplayer 10000; Always Ad-Free boot + cover watchdog/releaseCover (+ row padding 0 1rem);
single-rendition engine+MSE; range 403 → re-resolve+backoff; theater (YT icons, t);
videoId /watch|/live|/shorts|/embed; quality Settings submenu; session Diagnostics +
Dev extended logs; chapters videoId-scoped + late set-chapters; smallWhen="never";
no grid download chips; no STAGE; build nvm20+pnpm build; alpha-pack; mse-phase3 deferred.

Read docs/SESSION-NOTES.md + CLAUDE.md. Ignore other projects.
```
