# MSE Spike (Phase 0)

Harness to prove **extension-origin byte-range fetch** + **MediaSource** dual-track playback from ANDROID_VR adaptive URLs (no companion `<audio>` element).

## Run

```sh
pnpm build
# Load unpacked .output/chrome-mv3
```

1. Load unpacked `.output/chrome-mv3`, then **reload** the extension if needed.
2. Open a **www.youtube.com** watch tab and **hard-refresh** it (`Cmd+Shift+R`).
   After extension reload, old tabs have no content script → resolve fails with
   `Receiving end does not exist` + background `HTTP 403`.
3. Open the spike page:
   - `chrome://extensions` → your extension → copy **ID**
   - Navigate to `chrome-extension://<ID>/mse-spike.html?v=VIDEO_ID`
4. Click **Resolve** → **Play MSE @ 0** or **@ custom t** (e.g. 6000).

Optional duration field improves linear time→byte mapping for mid-video seeks.

## What it tests

| Check | Pass signal in log |
| --- | --- |
| Resolve stream | `resolved` + quality list |
| `MediaSource.isTypeSupported` | `codec check` videoOk/audioOk true |
| Range GET from extension | `content-length=…`, `init segment 0..N` |
| Init append | `init appended` |
| Play from 0 | `play() ok`, video advances, `buf=` grows |
| Mid-video start | `media start bytes` + `seek video.currentTime=` |

## Known Phase-0 limits

- ANDROID_VR adaptive is **fMP4** (tiny moov ~700B + moof/mdat). Mid start: linear time→byte estimate → **moof align** → append in `segments` mode.
- Linear A/V estimates land at **different PTS** (media element buffer = intersection → `media:empty`). Spike **re-anchors audio** to the video PTS until ranges overlap, then seeks to overlap start.
- Fail fast if still no A/V overlap. Phase 1: sidx / shared timeline index.
- Pumps: fixed chunk size, per-track ahead cap, quota evict.

## Pass / fail for Phase 1 go

**Go** if:

1. Range fetches return 206 from `*.googlevideo.com`.
2. avc1 + mp4a init appends without `SourceBuffer error`.
3. Playback from **t=0** works for a 720p/1080p adaptive pick.
4. Mid-video attempt either plays or fails with a **clear** log (not CORS).

**No-go / redesign** if:

- CORS or 403 on Range from extension page (then move fetch to background/offscreen).
- `isTypeSupported` false for all adaptive mime strings.
