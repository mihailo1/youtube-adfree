# Continue prompt (copy-paste into new agent session)

```
Continue yt-addfree at ~/Documents/reps.nosync/yt-addfree (v1.2.2).
Read docs/SESSION-NOTES.md and CLAUDE.md first.

v1.2 highlights:
- Hotkeys, quality memory, quality submenu under Settings ⚙
- Always Ad-Free: early-hide, fixed overlay on documentElement, resolve retry, preferPlay
- media-video-layout.smallWhen="never" (embed h≈378 would force small top chrome)
- Session diagnostics: Settings → Diagnostics; STAGE removed
- Chapters: videoId-scoped + late set-chapters
- Alpha: docs/ALPHA-TESTING.md, pnpm run alpha:pack
- Build: nvm use 20 && pnpm build → .output/chrome-mv3/

Rules: no multi-src Vidstack; park+unload while active; page-proxy streams;
fixed overlay root; never reparent iframe; no end-user console; rebuild after src.

Task:
[PASTE YOUR TASK HERE]
```

---

## Short one-liner

```
Continue yt-addfree v1.2.2 @ ~/Documents/reps.nosync/yt-addfree. Read docs/SESSION-NOTES.md + CLAUDE.md. Build: nvm use 20 && pnpm build. Task: <YOUR TASK>
```

---

## Compaction instructions

See **`docs/COMPACTION-INSTRUCTIONS.md`**.
