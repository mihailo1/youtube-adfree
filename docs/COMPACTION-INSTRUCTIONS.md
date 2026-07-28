# Compaction instructions (Grok `/compact`)

Paste the block below when compacting this project’s agent session.

---

## Ready-to-paste block

```
Compaction instructions for this session:

PROJECTS
- Primary: yt-addfree v1.1.1 at ~/Documents/reps.nosync/yt-addfree (WXT + Vidstack + TS). Shipped on main/GitHub.
- Secondary: filler Smart Autofill ~/Documents/reps.nosync/filler — v1.4.1 pushed. Do not re-implement unless asked.

MUST READ ON RESUME
- yt-addfree/docs/SESSION-NOTES.md
- yt-addfree/CLAUDE.md
- Optional: docs/CONTINUE-PROMPT.md, docs/mse-phase2.md, ARCHITECTURE.md

KEEP (do not drop)
1) Architecture: CS = overlay/toggle only; player = iframe; single-rendition PlaybackEngine + quality-menu (NEVER multi-src Vidstack); youtube-park (park + unload media + reload on disable); page-proxy InnerTube; bridge event.source checks.
2) Chapters: chapters.ts + VTT; mergePageChapters; scrubber segments ~3px; laconic menu close-on-select; chapter title in controls.
3) Storage: BG setAccessLevel TRUSTED_AND_UNTRUSTED + StoreAdFreeStreamPayload; option isAdFreeDefault (Always Ad-Free, default false) via default-pref + ⚙ settings inject (default-menu-item: single click path, no double-fire) + popup.
4) UI: never transparent .vds-slider-track under chapters; time-group margin 20px both sides; top chips hide with controls idle (controls-visible + ytp-autohide); preserve wasPlaying on switch.
5) MSE: mediaSource.duration always; full MediaSource reload scrub; init cache; ensureAvPlayable extend-first; no 2% sidx audio bias; restoreMsePlayhead on t→0 mid-buffer.
6) User rules: no DevTools for end users; agent pnpm build (nvm use 20) after extension code changes.
7) Version 1.1.1 — Always Ad-Free toggle fix shipped; optional live verify remaining.

DROP / compress
- Full MSE log dumps once root causes are summarized above.
- Filler detail beyond v1.4.1 pushed.
- Intermediate dead-end CSS/MSE attempts fully replaced by fixes above.

AFTER COMPACT assume SESSION-NOTES.md is current; ask only if task is unclear.
```

---

## How to use in Grok

1. `/compact` or `/compact [extra focus]` when context is large  
2. Optionally paste the block above as compaction instructions  
3. Resume: *Read `docs/SESSION-NOTES.md` then &lt;task&gt;*
