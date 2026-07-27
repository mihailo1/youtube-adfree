# MSE Ad-Free Player — Overview

Documentation for the MediaSource dual-track path that replaced fragile progressive dual-element (video + companion `<audio>`) playback for high adaptive qualities.

## Why MSE

| Problem (dual-element) | MSE solution |
| --- | --- |
| Audio steals network pipe at 1080p+ mid-video | One pipeline: dual `SourceBuffer` on one `<video>` |
| Seek/quality freezes and A/V thrash | Controlled byte-range append + generation tokens |
| Menu capped at 720p adaptive | avc1/av01 adaptive uncapped when MSE-capable |

## Phases

| Phase | Status | Docs |
| --- | --- | --- |
| **0 — Spike** | Done | [mse-spike.md](./mse-spike.md) |
| **1 — Player integration** | Done | [mse-phase1.md](./mse-phase1.md) |
| **2 — Index + seek** | Done | [mse-phase2.md](./mse-phase2.md) |
| **Polish** | Partial (stable baseline restored) | this file + phase2 |

## Architecture

```
YouTube tab (cookies / page-proxy)
        │
        ▼
ResolveAdFreeStream (ANDROID_VR player API)
        │
        ▼
Ad-Free player iframe
  ├── Progressive (muxed itag 18/22) → Vidstack single src
  └── Adaptive avc1/av01 + m4a → MseController
           │
           ├─ fetchInitSegment (ftyp+moov)
           ├─ sidx index (if present after moov)
           ├─ moof align + dual SourceBuffer append
           ├─ A/V timestamp sync (audio re-anchor to video PTS)
           └─ scrub → full MediaSource reload @ target (sidx-backed)
```

### Key modules

| Path | Role |
| --- | --- |
| `src/lib/ad-free/mse/mse-controller.ts` | Production MSE session: load / seek / stop |
| `src/lib/ad-free/mse/fragment-index.ts` | sidx parse, linear/calibrated time↔byte |
| `src/lib/ad-free/mse/range-fetch.ts` | HTTP Range from extension origin |
| `src/lib/ad-free/mse/mp4-boxes.ts` | Minimal ISO-BMFF helpers |
| `src/lib/ad-free/mse/spike-player.ts` | Re-export for Phase 0 harness |
| `src/lib/ad-free/playback-engine.ts` | FSM: progressive vs MSE paths, seek/quality |
| `src/entrypoints/mse-spike/` | Isolated go/no-go page |
| `src/entrypoints/ad-free-player/` | In-page / embed UI |

### Playback paths

1. **Progressive muxed** — `elPlayer.src = { url }`, no companion audio  
2. **MSE adaptive** — `qualitySupportsMse()` → dual-track MSE, no companion `<audio>`  
3. **Legacy adaptive** (e.g. webm / unsupported mime) — dual-element, still capped ≤720p  

### Resolve / network

- Prefer **page-proxy** via open `www.youtube.com` tab (hard-refresh after extension reload)  
- Background ANDROID_VR alone often **HTTP 403**  
- Stream URLs: googlevideo Range **206** from extension page  

## Behaviour notes (stable baseline)

- **Scrub (MSE):** full MediaSource rebuild at target time (sidx lookup + moof + A/V sync). Seconds of load is expected; more reliable than clear+append (Chrome demuxer fatals).  
- **Play after MSE:** call `HTMLVideoElement.play()` (blob URL), not only Vidstack `media-player.play()`.  
- **sidx:** never replace with calibrated map when sidx exists.  
- **Default quality:** prefer best MSE ≤1080p when available (ignore stored progressive `p-18` if MSE exists).  
- **Pause:** intentional only via play button / Space / K → `engine.pause()`. No auto-resume fight.  
- **Loaders:** custom dual-ring `.ytdl-loader` (Vidstack spinner hidden).  
- **Chrome:** player corners `12px` (0 in fullscreen); overlay absolute in `#movie_player` so scroll matches native YT (not fixed over masthead).  
- **Storyboard scrub previews:** parse `playerStoryboardSpecRenderer.spec` → sprite cells → Vidstack `thumbnails` on `media-video-layout` (`lib/ad-free/storyboard.ts`). Page HTML fallback if ANDROID_VR omits boards. Google Cast button hidden.  

## Known limits

- Scrub latency = full reload (not progressive download extend).  
- PTS can drift a few seconds vs wall-clock even with sidx (segment boundaries).  
- Mid-start without open YouTube tab fails resolve (403 / no content script).  
- Incremental SourceBuffer rebuffer after random-access clear often fails in Chrome → not used for scrub.  

## Verify / agent duty after edits

**Agent must run `pnpm build` after every change** (player, engine, MSE, CSS, content overlay). Do not ask the user to rebuild — only to reload unpacked + hard-refresh YT if needed.

```sh
# Node ≥18 (nvm use 20 when shell is stuck on Node 14)
pnpm build
# → .output/chrome-mv3

# User (if not on pnpm dev auto-reload):
# Chrome → Extensions → reload unpacked
# Open www.youtube.com watch tab → hard-refresh
# Start Ad-Free → expect 1080p MSE default
# Scrub, change quality, click video to pause, play button
```

Logs (ad-free-player DevTools context): filter `[ytdl-af]`, or `__ytdlAfLog.copy()`.

Intentional pause (click on video / button / Space): look for `media-pause-request` or `intentional pause → engine.pause()` and `keep-playing wantsPlaying=false` — no immediate `resume (poll-video-paused)`.

## History of fixes (session)

1. Dual YouTube/ad-free play → park YouTube  
2. Dual-element 1080 freezes → rebuffer, cap 720, then MSE plan  
3. Phase 0 spike: Range + MSE dual-track proven  
4. Phase 1: wire MSE into PlaybackEngine, lift avc1 cap  
5. Phase 2: sidx index, full-reload scrub, A/V sync  
6. Polish iterations: play-on-`<video>`, keep sidx, pause/scrub intent (last two polish layers simplified after regressions)  
7. Click-to-pause: `media-pause-request` + surface pointer; scrub mute via `transitionMuteDepth`; agent always `pnpm build` after edits  

## Related

- [mse-spike.md](./mse-spike.md) — Phase 0 harness  
- [mse-phase1.md](./mse-phase1.md) — engine integration  
- [mse-phase2.md](./mse-phase2.md) — index + seek  
- `CLAUDE.md` — short project pointers  
