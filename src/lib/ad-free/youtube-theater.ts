/**
 * YouTube watch "Theater" / wide mode — same layout as .ytp-size-button (t).
 * State lives on ytd-watch-flexy[theater]; survives Ad-Free ↔ YouTube switches.
 */

type WatchFlexy = HTMLElement & {
  theater?: boolean;
};

function getWatchFlexy(): WatchFlexy | null {
  const el = document.querySelector("ytd-watch-flexy");
  return el instanceof HTMLElement ? el as WatchFlexy : null;
}

export function isYouTubeTheaterMode(): boolean {
  const flexy = getWatchFlexy();
  if (!flexy) {
    return false;
  }
  if (typeof flexy.theater === "boolean") {
    return flexy.theater;
  }
  return flexy.hasAttribute("theater");
}

/**
 * Set theater mode without resetting when already correct.
 * Prefer Polymer property; fall back to clicking the native size button.
 */
export function setYouTubeTheaterMode(theater: boolean): boolean {
  const flexy = getWatchFlexy();
  if (flexy && typeof flexy.theater === "boolean") {
    if (flexy.theater !== theater) {
      flexy.theater = theater;
    }
    return isYouTubeTheaterMode() === theater;
  }

  if (isYouTubeTheaterMode() === theater) {
    return true;
  }

  const elSize = document.querySelector<HTMLElement>(
    "button.ytp-size-button, .ytp-size-button"
  );
  if (elSize) {
    elSize.click();
    return isYouTubeTheaterMode() === theater;
  }

  // Last resort: attribute (Polymer may not react, but often enough for layout CSS)
  if (flexy) {
    if (theater) {
      flexy.setAttribute("theater", "");
    } else {
      flexy.removeAttribute("theater");
    }
  }
  return isYouTubeTheaterMode() === theater;
}

export function toggleYouTubeTheaterMode(): boolean {
  const next = !isYouTubeTheaterMode();
  setYouTubeTheaterMode(next);
  return isYouTubeTheaterMode();
}

/**
 * Observe flexy theater attribute / property changes.
 * Returns dispose().
 */
export function watchYouTubeTheaterMode(
  onChange: (theater: boolean) => void
): () => void {
  let last = isYouTubeTheaterMode();
  onChange(last);

  const flexy = getWatchFlexy();
  let observer: MutationObserver | null = null;
  if (flexy) {
    observer = new MutationObserver(() => {
      const next = isYouTubeTheaterMode();
      if (next !== last) {
        last = next;
        onChange(next);
      }
    });
    observer.observe(flexy, { attributes: true, attributeFilter: ["theater"] });
  }

  // SPA may replace flexy — poll lightly
  const pollId = window.setInterval(() => {
    const next = isYouTubeTheaterMode();
    if (next !== last) {
      last = next;
      onChange(next);
    }
  }, 1_500);

  return () => {
    observer?.disconnect();
    window.clearInterval(pollId);
  };
}
