# MSE Phase 1 — Ad-Free player integration

Phase 0 spike proved extension-origin Range + dual-track MediaSource for ANDROID_VR fMP4.

Phase 1 wires that path into the real player.

## What changed

| Piece | Role |
| --- | --- |
| `src/lib/ad-free/mse/mse-controller.ts` | Production controller (load / seek / stop, moof align, A/V sync) |
| `src/lib/ad-free/mse/spike-player.ts` | Thin re-export for the spike harness |
| `playback-engine.ts` | Adaptive **avc1** + audio → MSE (no companion `<audio>`) |
| `ad-free-player/main.ts` | Menu: MSE-capable adaptive uncapped (1080p+); other adaptive still ≤720p |
| `resolve-stream.ts` | `durationSeconds` from `videoDetails.lengthSeconds` for mid time→byte map |

## Playback paths

1. **Progressive (muxed)** — unchanged HTML progressive / Vidstack src.
2. **Adaptive avc1 + m4a** — **MSE** dual SourceBuffer (video+audio ranges).
3. **Adaptive non-MSE** (e.g. av01) — legacy dual-element, still capped at 720p.

## How to verify

1. `pnpm build`, reload unpacked extension.
2. Open a long YouTube watch tab, hard-refresh, start **Ad-Free**.
3. Quality menu should list **1080p** (avc1) when available.
4. Play from 0, scrub mid-video, switch 720p↔1080p.
5. DevTools (ad-free-player context): logs with `mse …`, `loadQuality MSE path`.

## Known limits (Phase 1)

- Mid seek still uses linear time→byte + moof scan + A/V re-anchor (not sidx).
- Scrub outside buffer triggers full rebuffer (may take a few seconds).
- AV1 adaptive not on MSE yet.
- Spike page remains for isolated go/no-go (`docs/mse-spike.md`).

## Next

See [mse-phase2.md](./mse-phase2.md) and [mse-overview.md](./mse-overview.md).
