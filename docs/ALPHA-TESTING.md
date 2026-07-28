# Alpha testing — YouTube Ad-Free

Private alpha for the **in-page Ad-Free player** (**v1.2.2**). Not published to the Chrome Web Store yet.

## Install (Chrome / Edge / Brave)

### Option A — zip (recommended for testers)

1. Get **`youtube-adfree-<version>-chrome.zip`** from the maintainer (or build it yourself — see below).
2. Unzip it somewhere permanent (e.g. `~/Applications/youtube-adfree/`).  
   Do **not** delete this folder while the extension is installed.
3. Open `chrome://extensions`
4. Enable **Developer mode** (top-right)
5. Click **Load unpacked**
6. Select the unzipped folder (it must contain `manifest.json`)
7. Pin the extension icon if you like

### Option B — build from source

```sh
git clone https://github.com/mihailo1/youtube-adfree.git
cd youtube-adfree
# Node 20+
nvm use 20   # if needed
pnpm install
pnpm build   # → .output/chrome-mv3/
```

Then **Load unpacked** → select `.output/chrome-mv3`.

To produce a zip for others:

```sh
pnpm run pack
# → .output/youtube-adfree-<version>-chrome.zip
```

### After updates

1. Replace the folder contents (or rebuild)
2. On `chrome://extensions` click **Reload** on YouTube Ad-Free
3. Open a **new** YouTube tab (or hard-refresh `Cmd/Ctrl+Shift+R`)

---

## What to try

| Check | How |
| --- | --- |
| Manual Ad-Free | Open a watch page → chip **Ad-Free** (top-left on the player) |
| Always Ad-Free | Popup → Settings → **Always use Ad-Free player**, or player ⚙ menu |
| Quality | Quality chip (top-right) — 720 / 1080 / higher when available |
| Scrub | Seek mid-video on a long 1080p video |
| Hotkeys | Space, j/l, arrows, m, f, c (like YouTube) |
| Switch back | Chip **YouTube** — position should stay close |
| Mid-ad entry | Open a video that shows a pre-roll with Always Ad-Free on |

---

## Send feedback

Please include:

1. **What you did** (steps)
2. **What you expected** vs **what happened**
3. **Browser** + OS (e.g. Chrome 131, macOS)
4. **Session log** (see below)

### Export the session log

Logs collect automatically for the current browser session (watch page + Ad-Free player).

1. Open the extension **popup**
2. Go to **Settings**
3. Scroll to **Diagnostics (alpha)**
4. Click **Download log** (or **Copy**)
5. Attach the `.txt` file to your report

Tips:

- Reproduce the bug **first**, then download — the log is in-memory for this Chrome session.
- **Clear** resets the buffer if you want a clean capture for one scenario.
- Closing Chrome clears the session log.

### What the log contains

Short lines: time, level, scope (`watch` / `player` / `engine` / …), message.  
No passwords. Stream URLs may appear truncated in rare debug cases; alpha logs default to **info** (not verbose debug).

---

## Known limits (alpha)

- Needs a normal `www.youtube.com` watch tab (page-proxy for InnerTube).
- MSE scrub can take a moment (full MediaSource reload) — expected for now.
- Unpacked extensions show “Developer mode” warnings — normal for alpha.
- Not signed / not auto-updating via the Store.

---

## Firefox

```sh
pnpm build:firefox
# Load .output/firefox-mv3 via about:debugging → This Firefox → Load Temporary Add-on
```

Temporary add-ons unload when Firefox restarts.

---

## Maintainer: cut an alpha zip

```sh
cd ~/Documents/reps.nosync/yt-addfree
nvm use 20
pnpm build && pnpm run pack
# Share: .output/youtube-adfree-*-chrome.zip
# Plus this doc: docs/ALPHA-TESTING.md
```
