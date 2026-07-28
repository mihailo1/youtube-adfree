# MSE Phase 2 — Seek index + reliable scrub

## Goals

1. Accurate time→byte via **sidx** (ANDROID_VR often has it after moov)  
2. Reliable scrub without demuxer death  
3. Keep dual-track A/V in sync  

## Implemented

| Piece | Behaviour |
| --- | --- |
| `fragment-index.ts` | Parse `sidx`; linear fallback; calibrated map only if **no** sidx |
| `range-fetch.ts` | After-moov window for sidx probe |
| `mse-controller` seek | **Full MediaSource reload** at target (sidx-backed) |
| A/V sync | After video lands, re-anchor audio so ranges overlap |
| Seek target | Prefer wall-clock `startAt` when both tracks already cover it |

## Why full reload on scrub

In-place `SourceBuffer.remove` + mid-file append often fatals Chrome:

`CHUNK_DEMUXER_ERROR_APPEND_FAILED` → `HTMLMediaElement.error` set → no further appends.

Full reload (stop → new MediaSource → init → sidx seek → prefetch) is slower but stable.

## Logs to expect

```
video sidx index { entries: ~1700, ... }
keep sidx video index   // never "calibrated" when sidx present
seek full MediaSource reload { startAt }
ready (engine owns play)
```

## Verify

1. Ad-Free 1080p mid-video  
2. Scrub several times — should land near target and play  
3. Quality 720 ↔ 1080 / 2160 if supported  

## Out of scope (later)

Moved to **[mse-phase3.md](./mse-phase3.md)** (draft):

- True incremental append without reload  
- Perfect sample-accurate PTS without trusting sidx  
- Init/sidx cache on full reload, cheaper quality switch  
