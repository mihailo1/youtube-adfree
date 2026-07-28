# Session notes — Ad-Free player (2026-07-28)

Source of truth after context compact. **v1.2.1** on `main`.

## Projects

| Project | Path | Status |
|---------|------|--------|
| **yt-addfree** | `~/Documents/reps.nosync/yt-addfree` | **v1.2.1** |
| **filler** | out of scope this session | — |

---

## v1.2.1 — Alpha / polish

### Features

| Area | Detail |
|------|--------|
| **Hotkeys** | `hotkeys.ts` — YT-style Space/k, j/l, arrows, m/f/c, 0–9, speed, frame, PiP `i` |
| **Quality memory** | `quality-pref.ts` → `local:adFreeQualityPref` |
| **Quality in ⚙** | Submenu under Settings (no top-right chip; works fullscreen) |
| **Always Ad-Free row** | Pill switch in Settings; re-inject survives Audio/Captions |
| **Session diagnostics** | BG ring + popup Settings → **Diagnostics** Download/Copy/Clear |
| **Simpler logs** | Default **info**; STAGE removed; forward to session log |
| **Alpha pack** | `pnpm run alpha:pack` → `.output/youtube-adfree-*-chrome.zip` |
| **Alpha docs** | `docs/ALPHA-TESTING.md` |

### Always Ad-Free boot

| Problem | Fix |
|---------|-----|
| YT flash before cover | `document_start` + early-hide CSS from `localStorage.ytdlAfDefault` |
| 403 page-proxy race | `resolveStreamWithRetry` + BG multi-round; keep cover, no unpark |
| Double player-init | Overlay root **fixed on `documentElement`**, not `#movie_player` |
| Black paused | `preferPlay` / `paused=0` / `wasPlaying:!startPaused` |
| Rebuffer flash | Skip push-snapshot on fresh iframe |

### Chapters (SPA-safe)

- Extract scoped by `videoId` + duration fit (no cross-video leak)
- **Late merge** after Always Ad-Free: retries 0.6–6s → bridge `set-chapters`
- Files: `chapters.ts`, `bridge.ts` (`set-chapters`), `ad-free-watch` schedule, player `applyChapters`

### Settings UI

- YouTube-ish panel: blur, 12px radius, translucent bg
- Quality **submenu** (`media-menu`) with blur on expanded header
- Menu extras re-inject while ⚙ open (Lit wipes children on submenu nav)

### Overlay architecture

- Root **`position: fixed` on `document.documentElement`**
- `syncRootLayout()` mirrors `#movie_player` rect
- Never reparent iframe after create
- Session log: `session-log.ts` + BG handlers

### Key files (v1.2.x)

```
src/lib/ad-free/hotkeys.ts
src/lib/ad-free/quality-pref.ts
src/lib/ad-free/quality-menu.ts      # Settings submenu
src/lib/ad-free/player-toast.ts
src/lib/ad-free/session-log.ts
src/lib/ad-free/debug-log.ts
src/lib/ad-free/chapters.ts
src/lib/ad-free/default-menu-item.ts
src/lib/ad-free/content-overlay.ts
src/entrypoints/ad-free-watch.content.ts
src/entrypoints/ad-free-player/main.ts
src/entrypoints/ad-free-player/player.css
src/entrypoints/background/handlers/session-log-handlers.ts
src/entrypoints/popup/settings/sections/DiagnosticsSettings.svelte
docs/ALPHA-TESTING.md
docs/mse-phase3.md                   # draft deferred
```

### Build

```bash
cd ~/Documents/reps.nosync/yt-addfree
nvm use 20
pnpm build          # → .output/chrome-mv3/
pnpm run alpha:pack # zip for testers
```

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

---

## Open / optional later

- [ ] **MSE Phase 3** (draft, deferred): incremental rebuffer — `docs/mse-phase3.md`  
- [ ] Chapters still rare miss if YT never paints markers (API empty + no DOM)  
- [ ] Alpha feedback loop  

---

## Dev vs user

| Role | Steps |
|------|--------|
| End user / alpha | Unzip → Load unpacked → see `docs/ALPHA-TESTING.md` |
| After code change | `nvm use 20 && pnpm build` → reload → **new** YT tab |
| Session log | Popup → Settings → Diagnostics → Download log |
