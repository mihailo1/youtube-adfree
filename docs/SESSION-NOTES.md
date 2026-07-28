# Session notes — Ad-Free player (2026-07-29)

Source of truth after context compact. **v1.2.2** on `main`.

## Projects

| Project | Path | Status |
|---------|------|--------|
| **yt-addfree** | `~/Documents/reps.nosync/yt-addfree` | **v1.2.2** |
| **filler** | out of scope this session | — |

---

## v1.2.2 — chrome layout fix

| Fix | Detail |
|-----|--------|
| **Top-right control flash** | YouTube embed ~670×378 hit Vidstack `smallWhen: height < 380` → small layout (caption/settings/fs at **y≈2**). Force `media-video-layout.smallWhen = "never"` + `menuGroup = "bottom"` so large bottom chrome always. |
| **Reveal gate** | Wait until settings/caption/fs buttons measure in lower half before `is-chrome-ready` |
| **Chrome session logs** | `player: chrome wait-*` / `pre-reveal` / `post-reveal-*` (layout.sm/size, btn y) |
| **Always Ad-Free row** | More gap; no horizontal padding on the row |

## v1.2.1 — alpha / polish (shipped)

Hotkeys, quality memory, quality **Settings submenu**, Always Ad-Free boot (fixed overlay, early-hide, resolve retry), session Diagnostics export, chapters videoId-scoped + late `set-chapters`, STAGE removed, alpha pack docs.

### Overlay architecture

- Root **`position: fixed` on `document.documentElement`**
- Never reparent iframe after create
- Session log: `session-log.ts` + BG handlers

### Key files

```
src/lib/ad-free/hotkeys.ts
src/lib/ad-free/quality-pref.ts
src/lib/ad-free/quality-menu.ts
src/lib/ad-free/session-log.ts
src/lib/ad-free/debug-log.ts
src/lib/ad-free/chapters.ts
src/lib/ad-free/default-menu-item.ts
src/lib/ad-free/content-overlay.ts
src/entrypoints/ad-free-player/main.ts    # smallWhen never, chrome measure
src/entrypoints/ad-free-player/player.css
src/entrypoints/ad-free-watch.content.ts
src/entrypoints/background/handlers/session-log-handlers.ts
src/entrypoints/popup/settings/sections/DiagnosticsSettings.svelte
docs/ALPHA-TESTING.md
docs/mse-phase3.md                        # draft deferred
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
10. **`media-video-layout.smallWhen = "never"`** — embed height often &lt; 380; small layout puts chrome on top  

---

## Open / optional later

- [ ] **MSE Phase 3** (draft, deferred): `docs/mse-phase3.md`  
- [ ] Chapters rare miss if YT never paints markers  
- [ ] Alpha feedback  

---

## Dev vs user

| Role | Steps |
|------|--------|
| Alpha | Unzip → Load unpacked → `docs/ALPHA-TESTING.md` |
| After code | `nvm use 20 && pnpm build` → reload → **new** YT tab |
| Session log | Popup → Settings → Diagnostics → Download log |
