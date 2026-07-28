import { registerButtonDataHandler } from "./button-data-handler";
import "./cta-button.css";
import { cancelActiveDownload, startDownload } from "./video/download";
import { videoDataCache } from "./video/video-data";
import { buildInitialDownloadState } from "./watch-button/initial-download-state";
import { CrossWorldMessage, crossWorldMessenger, dispatchButtonClick } from "@/lib/messaging/cross-world-messenger";
import {
  DATA_BUTTON_ID_ATTR,
  DATA_SETTINGS_OPTIONS_ID_ATTR,
  isYtdSettingsOptionsRenderer
} from "@/lib/ui/polymer-utils";
import { isYtButtonViewModelElement } from "@/lib/youtube/schemas";
import { ButtonSize, ButtonState, ButtonStyle, ButtonType, DownloadType } from "@/types";
import type { AdaptiveFormatItem } from "@/types";

const SNACKBAR_VIEW_BUTTON_ID = "ytdl-snackbar-view";
const SETTINGS_OPTIONS_RENDERER_TAG = "ytd-settings-options-renderer";
const SETTINGS_OPTIONS_ID_SELECTOR = "#options";

function pickVideoItagForHeight(
  formats: AdaptiveFormatItem[],
  preferredHeight?: number,
  videoItag?: number
) {
  if (videoItag && formats.some(format => format.itag === videoItag)) {
    return videoItag;
  }
  if (!formats.length) {
    return 0;
  }
  if (preferredHeight && preferredHeight > 0) {
    const sorted = [...formats].sort((left, right) => {
      const distLeft = Math.abs((left.height ?? 0) - preferredHeight);
      const distRight = Math.abs((right.height ?? 0) - preferredHeight);
      if (distLeft !== distRight) {
        return distLeft - distRight;
      }
      return (right.bitrate ?? 0) - (left.bitrate ?? 0);
    });
    return sorted[0]?.itag ?? formats[0]?.itag ?? 0;
  }
  return formats[0]?.itag ?? 0;
}

export function registerCrossWorldHandlers() {
  crossWorldMessenger.onMessage(CrossWorldMessage.DownloadRequest, ({ data }) => {
    startDownload(data).catch(() => {});
  });

  /**
   * Ad-Free one-click download: match preferred height/itag from the Ad-Free
   * quality menu to page videoFormats and start the existing pipeline.
   */
  crossWorldMessenger.onMessage(CrossWorldMessage.QuickDownload, ({ data }) => {
    const { videoId, preferredHeight, videoItag } = data;
    const videoData = videoDataCache.get(videoId);
    if (!videoData) {
      return {
        ok: false,
        reason: "Video data not ready — open the download menu once, or wait for the page to finish loading."
      };
    }
    if (!videoData.isDownloadable) {
      return {
        ok: false,
        reason: "This video is not downloadable."
      };
    }

    const initial = buildInitialDownloadState(videoData);
    const resolvedVideoItag = videoData.isMusic
      ? initial.videoItag
      : pickVideoItagForHeight(videoData.videoFormats, preferredHeight, videoItag);

    void startDownload({
      type: initial.downloadType === DownloadType.Audio
        ? DownloadType.Audio
        : DownloadType.VideoAndAudio,
      videoId,
      videoItag: resolvedVideoItag || initial.videoItag,
      audioItag: initial.audioItag,
      audioTrackId: initial.audioTrackId,
      filenameOutput: initial.filename
    }).catch(() => {});

    return { ok: true };
  });

  crossWorldMessenger.onMessage(CrossWorldMessage.OpenSnackbar, () => {
    requestAnimationFrame(() => {
      const elViewButton = document.querySelector(`[${DATA_BUTTON_ID_ATTR}="${SNACKBAR_VIEW_BUTTON_ID}"]`);
      if (!isYtButtonViewModelElement(elViewButton)) {
        return;
      }

      elViewButton.data = {
        title: "View",
        accessibilityText: "View in folder",
        style: ButtonStyle.Mono,
        type: ButtonType.Text,
        buttonSize: ButtonSize.XSmall,
        state: ButtonState.Active,
        isFullWidth: false,
        isDisabled: false,
        tooltip: ""
      };

      elViewButton.addEventListener("click", () => dispatchButtonClick(SNACKBAR_VIEW_BUTTON_ID));
    });
  });

  crossWorldMessenger.onMessage(CrossWorldMessage.CancelDownload, ({ data }) => {
    for (const videoId of data.videoIds) {
      cancelActiveDownload(videoId);
    }
  });

  registerButtonDataHandler();

  crossWorldMessenger.onMessage(CrossWorldMessage.SetSettingsOptionsData, ({ data: { selector, title } }) => {
    const elPlaceholder = document.querySelector(selector);
    if (!elPlaceholder) {
      return;
    }

    const elRenderer = document.createElement(SETTINGS_OPTIONS_RENDERER_TAG);
    const settingsId = elPlaceholder.getAttribute(DATA_SETTINGS_OPTIONS_ID_ATTR);
    if (settingsId) {
      elRenderer.setAttribute(DATA_SETTINGS_OPTIONS_ID_ATTR, settingsId);
    }

    for (const className of elPlaceholder.classList) {
      elRenderer.classList.add(className);
    }

    const isValidSettingsRenderer = isYtdSettingsOptionsRenderer(elRenderer);
    if (!isValidSettingsRenderer) {
      return;
    }

    elRenderer.set("data", {
      title: {
        runs: [{ text: title }]
      },
      options: []
    });
    elPlaceholder.parentNode?.insertBefore(elRenderer, elPlaceholder);

    const elOptions = elRenderer.querySelector(SETTINGS_OPTIONS_ID_SELECTOR) ?? elRenderer;
    while (elPlaceholder.firstChild) {
      elOptions.append(elPlaceholder.firstChild);
    }

    elPlaceholder.remove();
  });
}
