import {
  type ChannelVideoItem,
  channelListTabFromPath,
  collectVisibleVideoIdsFromDocument,
  extractChannelIdFromDocument,
  isChannelListPath
} from "@/lib/ad-free/channel-region-list";
import { MessageType, sendMessage } from "@/lib/messaging/messaging";

const PANEL_ID = "ytdl-region-hidden-panel";
const STYLE_ID = "ytdl-region-hidden-style";
const TOGGLE_ID = "ytdl-region-hidden-toggle";
/** Must match channel-region-list DEFAULT_GL (Jordan). */
const DEFAULT_GL = "JO";

const PANEL_CSS = `
#${TOGGLE_ID} {
  position: fixed;
  right: 16px;
  bottom: 88px;
  z-index: 2147483001;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: none;
  border-radius: 20px;
  background: #272727;
  color: #f1f1f1;
  font: 500 13px/1.2 "YouTube Sans", Roboto, Arial, sans-serif;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
#${TOGGLE_ID}:hover {
  background: #3f3f3f;
}
#${TOGGLE_ID}:disabled {
  opacity: 0.7;
  cursor: wait;
}
#${TOGGLE_ID} .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3ea6ff;
}
#${PANEL_ID} {
  position: fixed;
  right: 16px;
  bottom: 140px;
  z-index: 2147483001;
  width: min(380px, calc(100vw - 32px));
  max-height: min(60vh, 520px);
  display: flex;
  flex-direction: column;
  background: #212121;
  color: #f1f1f1;
  border: 1px solid #3f3f3f;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  font-family: "YouTube Sans", Roboto, Arial, sans-serif;
}
#${PANEL_ID}[hidden] {
  display: none !important;
}
#${PANEL_ID} .hdr {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid #3f3f3f;
}
#${PANEL_ID} .hdr h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
#${PANEL_ID} .hdr p {
  margin: 4px 0 0;
  color: #aaa;
  font-size: 12px;
}
#${PANEL_ID} .close {
  border: none;
  background: transparent;
  color: #aaa;
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
  padding: 0 4px;
}
#${PANEL_ID} .close:hover {
  color: #fff;
}
#${PANEL_ID} .body {
  overflow: auto;
  padding: 8px;
}
#${PANEL_ID} .empty,
#${PANEL_ID} .error,
#${PANEL_ID} .loading {
  padding: 16px 12px;
  color: #aaa;
  font-size: 13px;
  text-align: center;
}
#${PANEL_ID} .error {
  color: #ff6b6b;
}
#${PANEL_ID} .row {
  display: flex;
  gap: 10px;
  padding: 8px;
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
}
#${PANEL_ID} .row:hover {
  background: #3f3f3f;
}
#${PANEL_ID} .thumb {
  position: relative;
  width: 120px;
  min-width: 120px;
  height: 68px;
  border-radius: 6px;
  overflow: hidden;
  background: #000;
}
#${PANEL_ID} .thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
#${PANEL_ID} .badge {
  position: absolute;
  left: 4px;
  top: 4px;
  background: rgba(62, 166, 255, 0.95);
  color: #0f0f0f;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 5px;
  border-radius: 3px;
  letter-spacing: 0.02em;
}
#${PANEL_ID} .dur {
  position: absolute;
  right: 4px;
  bottom: 4px;
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
}
#${PANEL_ID} .meta {
  min-width: 0;
  flex: 1;
}
#${PANEL_ID} .title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
#${PANEL_ID} .sub {
  margin-top: 4px;
  color: #aaa;
  font-size: 12px;
}
`;

let lastPath = "";
let isPanelOpen = false;
let lastHidden: ChannelVideoItem[] = [];
let lastGl = DEFAULT_GL;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const elStyle = document.createElement("style");
  elStyle.id = STYLE_ID;
  elStyle.textContent = PANEL_CSS;
  (document.head ?? document.documentElement).append(elStyle);
}

function resolveChannelId(): string | null {
  return extractChannelIdFromDocument(document);
}

function removeUi() {
  document.getElementById(PANEL_ID)?.remove();
  document.getElementById(TOGGLE_ID)?.remove();
  isPanelOpen = false;
  lastHidden = [];
}

function ensureToggle(): HTMLButtonElement {
  ensureStyles();
  let elButton = document.getElementById(TOGGLE_ID) as HTMLButtonElement | null;
  if (elButton) {
    return elButton;
  }
  elButton = document.createElement("button");
  elButton.id = TOGGLE_ID;
  elButton.type = "button";
  elButton.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="label">Region-hidden</span>`;
  elButton.addEventListener("click", () => {
    void onToggleClick(elButton!);
  });
  document.documentElement.append(elButton);
  return elButton;
}

function setToggleLabel(elButton: HTMLButtonElement, text: string, disabled = false) {
  const elLabel = elButton.querySelector(".label");
  if (elLabel) {
    elLabel.textContent = text;
  } else {
    elButton.textContent = text;
  }
  elButton.disabled = disabled;
}

function ensurePanel(): HTMLElement {
  let elPanel = document.getElementById(PANEL_ID);
  if (elPanel) {
    return elPanel;
  }
  elPanel = document.createElement("div");
  elPanel.id = PANEL_ID;
  elPanel.hidden = true;
  elPanel.innerHTML = `
    <div class="hdr">
      <div>
        <h2>Hidden in your region</h2>
        <p class="subline">Listed via gl=${DEFAULT_GL} (videos / streams)</p>
      </div>
      <button type="button" class="close" aria-label="Close">×</button>
    </div>
    <div class="body"></div>
  `;
  elPanel.querySelector(".close")?.addEventListener("click", () => {
    isPanelOpen = false;
    elPanel!.hidden = true;
  });
  document.documentElement.append(elPanel);
  return elPanel;
}

function renderPanelBody(elPanel: HTMLElement, state: {
  loading?: boolean;
  error?: string;
  hidden?: ChannelVideoItem[];
  gl?: string;
  totalRemote?: number;
  visibleCount?: number;
}) {
  const elBody = elPanel.querySelector(".body");
  const elSub = elPanel.querySelector(".subline");
  if (!elBody) {
    return;
  }
  if (elSub && state.gl) {
    elSub.textContent = `Compared local grid vs gl=${state.gl} list`
      + (state.totalRemote != null ? ` · remote ${state.totalRemote}` : "")
      + (state.visibleCount != null ? ` · on page ${state.visibleCount}` : "");
  }

  if (state.loading) {
    elBody.innerHTML = `<div class="loading">Loading channel list…</div>`;
    return;
  }
  if (state.error) {
    elBody.innerHTML = "";
    const elError = document.createElement("div");
    elError.className = "error";
    elError.textContent = state.error;
    elBody.append(elError);
    return;
  }

  const hidden = state.hidden ?? [];
  if (hidden.length === 0) {
    elBody.innerHTML = `<div class="empty">No extra videos found for gl=${state.gl ?? DEFAULT_GL}. They may share the same geo filter as your IP, or the page has not loaded enough local items yet.</div>`;
    return;
  }

  elBody.replaceChildren();
  for (const video of hidden) {
    const elRow = document.createElement("a");
    elRow.className = "row";
    elRow.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
    elRow.target = "_blank";
    elRow.rel = "noopener noreferrer";

    const elThumb = document.createElement("div");
    elThumb.className = "thumb";
    const elBadge = document.createElement("span");
    elBadge.className = "badge";
    elBadge.textContent = "REGION";
    elThumb.append(elBadge);
    if (video.thumbnailUrl) {
      const elImg = document.createElement("img");
      elImg.src = video.thumbnailUrl;
      elImg.alt = "";
      elImg.loading = "lazy";
      elThumb.append(elImg);
    }
    if (video.lengthText) {
      const elDur = document.createElement("span");
      elDur.className = "dur";
      elDur.textContent = video.lengthText;
      elThumb.append(elDur);
    }

    const elMeta = document.createElement("div");
    elMeta.className = "meta";
    const elTitle = document.createElement("div");
    elTitle.className = "title";
    elTitle.textContent = video.title;
    const elSubMeta = document.createElement("div");
    elSubMeta.className = "sub";
    elSubMeta.textContent = video.publishedTimeText || video.videoId;
    elMeta.append(elTitle, elSubMeta);

    elRow.append(elThumb, elMeta);
    elBody.append(elRow);
  }
}

async function scanHiddenVideos(): Promise<{
  hidden: ChannelVideoItem[];
  gl: string;
  totalRemote: number;
  visibleCount: number;
  channelId: string;
  tab: string;
}> {
  const channelId = resolveChannelId();
  if (!channelId) {
    throw new Error(
      "Could not detect channel id on this page. Open the channel Videos or Streams tab and try again."
    );
  }

  const tab = channelListTabFromPath(location.pathname);

  // Wait so lazy grid can paint; scroll slightly to encourage hydration
  window.scrollBy(0, 1);
  await new Promise(resolve => setTimeout(resolve, 400));
  const visibleIds = collectVisibleVideoIdsFromDocument();

  const remote = await sendMessage(MessageType.ResolveChannelRegionList, {
    channelId,
    gl: DEFAULT_GL,
    tab
  });

  const hidden = remote.videos.filter(video => !visibleIds.has(video.videoId));
  return {
    hidden,
    gl: remote.gl,
    totalRemote: remote.videos.length,
    visibleCount: visibleIds.size,
    channelId,
    tab
  };
}

async function onToggleClick(elButton: HTMLButtonElement) {
  const elPanel = ensurePanel();

  if (isPanelOpen && !elPanel.hidden) {
    // Refresh if already open
  } else {
    isPanelOpen = true;
    elPanel.hidden = false;
  }

  setToggleLabel(elButton, "Scanning…", true);
  renderPanelBody(elPanel, { loading: true, gl: DEFAULT_GL });

  try {
    const result = await scanHiddenVideos();
    lastHidden = result.hidden;
    lastGl = result.gl;
    const elSub = elPanel.querySelector(".subline");
    if (elSub) {
      elSub.textContent = `Tab: ${result.tab} · gl=${result.gl} · remote ${result.totalRemote} · on page ${result.visibleCount}`;
    }
    renderPanelBody(elPanel, {
      hidden: result.hidden,
      gl: result.gl,
      totalRemote: result.totalRemote,
      visibleCount: result.visibleCount
    });
    setToggleLabel(
      elButton,
      result.hidden.length > 0 ? `Region-hidden (${result.hidden.length})` : "Region-hidden (0)",
      false
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderPanelBody(elPanel, { error: message, gl: lastGl });
    setToggleLabel(elButton, "Region-hidden · retry", false);
  }
}

function onLocationMaybeChanged() {
  const path = `${location.pathname}${location.search}`;
  if (path === lastPath) {
    return;
  }
  lastPath = path;

  if (!isChannelListPath(location.pathname)) {
    removeUi();
    return;
  }

  ensureToggle();
  // Keep panel closed on navigation; user opens it explicitly
  const elPanel = document.getElementById(PANEL_ID);
  if (elPanel) {
    elPanel.hidden = true;
  }
  isPanelOpen = false;
  lastHidden = [];
  const elButton = document.getElementById(TOGGLE_ID) as HTMLButtonElement | null;
  if (elButton) {
    setToggleLabel(elButton, "Region-hidden", false);
  }
}

export default defineContentScript({
  matches: ["https://www.youtube.com/*"],
  runAt: "document_idle",
  main(ctx) {
    onLocationMaybeChanged();

    ctx.addEventListener(window, "wxt:locationchange", () => {
      onLocationMaybeChanged();
    });

    document.addEventListener("yt-navigate-finish", () => {
      onLocationMaybeChanged();
    });
  }
});
