# Continue prompt (copy-paste into new agent session)

```
Continue yt-addfree at ~/Documents/reps.nosync/yt-addfree (v1.1.0 on main).
Read docs/SESSION-NOTES.md and CLAUDE.md first.

Shipped in v1.1.0:
- Chapters (VTT track, scrubber gaps, laconic menu close-on-select)
- MSE dual-track adaptive (duration, sidx, ensureAvPlayable, restoreMsePlayhead)
- Always Ad-Free setting (default off) + auto-enable on watch
- youtube-park unload original from memory + reload on switch back
- State preserve wasPlaying both ways; top chrome hides with idle controls
- storage.session via BG setAccessLevel + StoreAdFreeStreamPayload
- Build: nvm use 20 && pnpm build → .output/chrome-mv3/

Rules: no multi-src Vidstack; park+unload while active; page-proxy streams;
no end-user console; CS storage via BG; rebuild after src changes.

Task:
[PASTE YOUR TASK HERE]
```

---

## Short one-liner

```
Continue yt-addfree v1.1.0 at ~/Documents/reps.nosync/yt-addfree. Read docs/SESSION-NOTES.md + CLAUDE.md. Build: nvm use 20 && pnpm build → .output/chrome-mv3. Task: <YOUR TASK>
```

---

## Compaction instructions

See **`docs/COMPACTION-INSTRUCTIONS.md`**.
