# MSE Phase 3 — Incremental rebuffer + tighter timeline (draft)

Phases 0–2 delivered stable dual-track MSE with **sidx-backed full MediaSource reload** on scrub. That is reliable but slow and wasteful.

Phase 3 is the next MSE slice: keep the Phase 2 safety net, reduce scrub/rebuffer cost, and tighten A/V time without regressing Chrome demuxer fatals.

**Status:** planned / not started. Draft only — no code commitment until goals and go/no-go below are agreed.

## Why

| Today (Phase 2 baseline) | Pain |
| --- | --- |
| Scrub → stop → new `MediaSource` → init + sidx + prefetch | Seconds of black/loader; network re-download of init |
| Forward rebuffer beyond buffered range | Works via append, but random-access **clear+append** often dies |
| PTS vs wall-clock | Can drift a few seconds even with sidx |
| Quality switch | Often reloads whole session like scrub |

User-visible wins: snappier scrub, less flash on quality change, fewer full pipeline restarts.

## Goals

1. **Incremental scrub when possible** — extend or re-seek SourceBuffers without full MS rebuild when Chrome accepts it.
2. **Keep full-reload fallback** — on `CHUNK_DEMUXER_ERROR_*` / `error` media → generation token + Phase 2 path (never leave a dead element).
3. **Tighter A/V sync** — reduce PTS/wall-clock skew; keep dual-track ranges overlapping after seek.
4. **Cheaper quality switch** — reuse audio track / init where codecs match; avoid double-fetch when only video itag changes.
5. **No regression** on cold Always Ad-Free boot, park/unload, page-proxy resolve, progressive path.

Non-goals (still later / other work):

- Multi-rendition adaptive ABR inside one session (still single-rendition engine + quality menu).
- Companion-audio dual-element improvements.
- WebM / non–MSE-capable adaptive (stay capped or progressive).
- Perfect frame-accurate scrub previews (storyboard is separate).

## Approach (proposed)

Order is deliberate: prove safety before optimizing.

### 3a — Instrumented baseline

- Session-log / `[ytdl-af]` counters: scrub latency, full-reload count, demuxer errors, append failure rate.
- Metrics only; no behaviour change.
- Exit: can A/B any later step with numbers.

### 3b — Forward / near-buffer seek without reload

- If target is **inside** or **just ahead of** buffered ranges → `currentTime` + light prefetch only.
- If target is **slightly behind** trailing edge and remove-window is safe → try `SourceBuffer.remove` + append **one** segment window, then abort to full reload on failure.
- Generation token already on controller: cancel in-flight Range fetches on every new seek.

### 3c — Random-access scrub without full MS (hard)

Chrome often fatals on mid-file append after `remove`. Options to spike:

| Option | Idea | Risk |
| --- | --- | --- |
| **A** | `abort()` + `timestampOffset` re-anchor + append from sidx keyframe | Demuxer state |
| **B** | Dual `MediaSource` swap (prepare next MS off-element, flip `src`) | Memory, flash |
| **C** | Keep full reload but **cache init+sidx** bytes and reuse on rebuild | Low risk, medium win |

Recommend start with **C** (easy win), then spike **A** behind a flag; **B** only if A fails.

### 3d — A/V timeline polish

- Prefer sidx always; never replace with calibrated map when sidx exists (invariant).
- After video lands, re-anchor audio so buffered ranges overlap (already Phase 2) — tighten thresholds / log residual gap.
- Optional: sample-accurate map only for **no-sidx** streams; document when ANDROID_VR omits sidx.

### 3e — Quality switch

- Same audio itag + codec → keep audio SourceBuffer, replace video only (or full reload video branch).
- Different audio → full dual reload (current behaviour OK).

## Touch points (expected)

| Path | Role |
| --- | --- |
| `src/lib/ad-free/mse/mse-controller.ts` | Seek strategy, init cache, fallback reload |
| `src/lib/ad-free/mse/fragment-index.ts` | sidx lookups; optional finer maps |
| `src/lib/ad-free/mse/range-fetch.ts` | Cancel / dedupe overlapping ranges |
| `src/lib/ad-free/playback-engine.ts` | Quality change entry; scrub intent |
| `src/lib/ad-free/debug-log.ts` | Session log metrics for 3a |
| `docs/mse-overview.md` | Status + behaviour notes when shipped |

## Invariants (do not break)

1. Single-rendition Vidstack + engine quality menu (no multi-src ABR).
2. Dual SourceBuffer MSE for adaptive avc1/av01; progressive muxed unchanged.
3. Full-reload path remains correct fallback forever.
4. `sidx` wins over calibrated linear map when present.
5. Intentional pause stays intentional (`engine.pause()` / keep-playing).
6. Page-proxy resolve + Always Ad-Free overlay contract untouched.
7. Agent rebuild: `nvm use 20 && pnpm build` after every change.

## Go / no-go (spike criteria)

Before replacing full-reload as the **default** scrub path:

| Check | Pass |
| --- | --- |
| 20 random scrubs on long 1080p video | No sticky `HTMLMediaElement.error`; auto-fallback if any demuxer fail |
| Scrub median latency | Noticeably below full-reload baseline (target: ≥30% faster or subjectively “instant” near-buffer) |
| Quality 720 ↔ 1080 ↔ 2160 | Plays; no dual audio; no freeze |
| Always Ad-Free cold open | Single player-init; no pagehide mid-load regression |
| Pause / Space / K | No auto-resume fight |

If random-access append fails >~5% under stress → ship only **3c-C** (init/sidx cache) + near-buffer path; leave random-access on full reload.

## Verify (when implementing)

```sh
cd ~/Documents/reps.nosync/yt-addfree
nvm use 20
pnpm build   # → .output/chrome-mv3/
```

1. Reload unpacked → **new** YT watch tab → hard-refresh.  
2. Ad-Free 1080p mid-video; scrub near playhead, then far jumps.  
3. Switch quality; pause/play; Always Ad-Free cold open once.  
4. Popup → Settings → Diagnostics → Download log (or filter `[ytdl-af]` in DevTools).

## Success definition

- Default scrub path uses incremental or cached-reload where safe.
- Full MediaSource rebuild is rare (far jump / demuxer recovery / first load only).
- No increase in “stuck black player” or always-ad-free flicker.
- Docs: this file → **Done**; overview phase table updated.

## Open questions

1. Prefer latency (aggressive remove+append) or reliability (cache+full reload only)?  
2. Feature flag `local:adFreeMseIncremental` for gradual rollout?  
3. AV1 path already MSE — same seek strategy for av01 as avc1?  
4. Is dual-MS swap (option B) worth memory cost on low-end machines?

## Related

- [mse-overview.md](./mse-overview.md) — architecture + known limits  
- [mse-phase2.md](./mse-phase2.md) — current full-reload seek  
- [mse-phase1.md](./mse-phase1.md) — engine integration  
- `docs/SESSION-NOTES.md` — product open items (v1.2 boot is separate)
