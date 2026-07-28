/**
 * Inject "Always Ad-Free" into the Vidstack Settings (⚙) menu.
 *
 * Vidstack portals settings panel to menuContainer / body (`portal: true`),
 * so we must search document-wide and re-inject when the open panel re-renders.
 */

import {
  getAdFreeDefaultEnabled,
  setAdFreeDefaultEnabled
} from "@/lib/ad-free/default-pref";
import { createAdFreeLogger } from "@/lib/ad-free/debug-log";

const log = createAdFreeLogger("default-menu");
const ROW_CLASS = "ytdl-always-adfree";
const SECTION_CLASS = "ytdl-always-adfree-section";
const STYLE_ID = "ytdl-always-adfree-style";

export type DefaultMenuItemController = {
  dispose: () => void;
};

const TOGGLE_CSS = `
/* Lives in portaled settings panel (often outside #player-wrap) */
.${SECTION_CLASS} {
  margin: 0 0 4px;
  padding: 0 0 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.${ROW_CLASS} {
  display: flex !important;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 10px 12px !important;
  border-radius: 8px;
  cursor: pointer;
  box-sizing: border-box;
  transition: background 0.12s ease;
}
.${ROW_CLASS}:hover {
  background: rgba(255, 255, 255, 0.08) !important;
}
.${ROW_CLASS} .ytdl-always-adfree-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(255, 0, 51, 0.18);
  color: #ff4d6a;
}
.${ROW_CLASS} .ytdl-always-adfree-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.${ROW_CLASS} .vds-menu-item-label,
.${ROW_CLASS} .ytdl-always-adfree-label {
  font: 600 13px/1.25 "YouTube Sans", Roboto, Arial, sans-serif !important;
  color: #fff !important;
  margin: 0 !important;
}
.${ROW_CLASS} .ytdl-always-adfree-desc {
  font: 400 11px/1.3 "YouTube Sans", Roboto, Arial, sans-serif;
  color: rgba(255, 255, 255, 0.52);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.${ROW_CLASS} .ytdl-always-adfree-hint {
  flex-shrink: 0;
  font: 600 11px/1 "YouTube Sans", Roboto, Arial, sans-serif !important;
  color: rgba(255, 255, 255, 0.48) !important;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.${ROW_CLASS} .ytdl-always-adfree-checkbox {
  flex-shrink: 0;
  pointer-events: none; /* clicks go to the row once — avoid double toggle */
  --checkbox-active-bg: #ff0033;
}
.${ROW_CLASS} .ytdl-always-adfree-checkbox[aria-checked="true"],
.${ROW_CLASS} .ytdl-always-adfree-checkbox.is-on {
  background-color: #ff0033 !important;
}
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const elStyle = document.createElement("style");
  elStyle.id = STYLE_ID;
  elStyle.textContent = TOGGLE_CSS;
  (document.head ?? document.documentElement).append(elStyle);
}

function syncCheckbox(elCheckbox: HTMLElement, enabled: boolean) {
  elCheckbox.setAttribute("aria-checked", enabled ? "true" : "false");
  elCheckbox.classList.toggle("is-on", enabled);
  const elHint = elCheckbox
    .closest(`.${ROW_CLASS}`)
    ?.querySelector<HTMLElement>(".ytdl-always-adfree-hint");
  if (elHint) {
    elHint.textContent = enabled ? "On" : "Off";
  }
}

function buildSection(
  enabled: boolean,
  onEnabledChange: (enabled: boolean) => void
): HTMLElement {
  ensureStyles();

  const elSection = document.createElement("div");
  elSection.className = `vds-menu-section ${SECTION_CLASS}`;
  elSection.dataset.ytdlAlwaysAdfree = "1";

  const elBody = document.createElement("div");
  elBody.className = "vds-menu-section-body";

  const elRow = document.createElement("div");
  elRow.className = `vds-menu-item ${ROW_CLASS}`;
  elRow.setAttribute("role", "menuitemcheckbox");
  elRow.setAttribute("aria-checked", enabled ? "true" : "false");
  elRow.tabIndex = 0;

  const elIcon = document.createElement("span");
  elIcon.className = "ytdl-always-adfree-icon";
  elIcon.setAttribute("aria-hidden", "true");
  elIcon.innerHTML = (
    "<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"currentColor\">"
    + "<path d=\"M13 2 4 14h7l-1 8 9-12h-7l1-8z\"/>"
    + "</svg>"
  );

  const elText = document.createElement("div");
  elText.className = "ytdl-always-adfree-text";

  const elLabel = document.createElement("div");
  elLabel.className = "vds-menu-item-label ytdl-always-adfree-label";
  elLabel.textContent = "Always Ad-Free";

  const elDesc = document.createElement("div");
  elDesc.className = "ytdl-always-adfree-desc";
  elDesc.textContent = "Open watch pages in Ad-Free by default";

  elText.append(elLabel, elDesc);

  const elHint = document.createElement("span");
  elHint.className = "ytdl-always-adfree-hint vds-menu-item-hint";
  elHint.textContent = enabled ? "On" : "Off";

  const elCheckbox = document.createElement("div");
  elCheckbox.className = "vds-menu-checkbox ytdl-always-adfree-checkbox";
  elCheckbox.setAttribute("role", "presentation");
  elCheckbox.setAttribute("aria-hidden", "true");
  syncCheckbox(elCheckbox, enabled);

  // Guard against pointerup+click (or double-fire) flipping twice → ends up Off
  let isBusy = false;
  let lastToggleAt = 0;

  async function toggle(event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (typeof event?.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    const now = Date.now();
    if (isBusy || now - lastToggleAt < 350) {
      log.debug("toggle ignored (debounce/busy)");
      return;
    }
    lastToggleAt = now;
    isBusy = true;

    const next = elRow.getAttribute("aria-checked") !== "true";
    syncCheckbox(elCheckbox, next);
    elRow.setAttribute("aria-checked", next ? "true" : "false");
    onEnabledChange(next);

    try {
      await setAdFreeDefaultEnabled(next);
      log.info("default pref", { enabled: next });
    } catch (error) {
      log.warn("failed to save default pref", {
        message: error instanceof Error ? error.message : String(error)
      });
      syncCheckbox(elCheckbox, !next);
      elRow.setAttribute("aria-checked", !next ? "true" : "false");
      onEnabledChange(!next);
    } finally {
      isBusy = false;
    }
  }

  // Single input path only — checkbox has pointer-events: none
  elRow.addEventListener("click", event => {
    void toggle(event);
  });
  elRow.addEventListener("keydown", event => {
    if (event.key === " " || event.key === "Enter") {
      void toggle(event);
    }
  });

  elRow.append(elIcon, elText, elHint, elCheckbox);
  elBody.append(elRow);
  elSection.append(elBody);
  return elSection;
}

function findSettingsMenuItems(elMenu?: Element | null): HTMLElement | null {
  // Prefer items belonging to the open settings menu
  if (elMenu instanceof HTMLElement) {
    const host = elMenu as HTMLElement & { contentElement?: HTMLElement | null };
    if (host.contentElement instanceof HTMLElement) {
      return host.contentElement;
    }
    const nested = elMenu.querySelector<HTMLElement>(
      ".vds-settings-menu-items, media-menu-items.vds-settings-menu-items"
    );
    if (nested) {
      return nested;
    }
  }

  // Portaled: search document for open settings panel
  const candidates = document.querySelectorAll<HTMLElement>(
    "media-menu-items.vds-settings-menu-items, .vds-settings-menu-items.vds-menu-items"
  );
  for (const el of candidates) {
    // Prefer visible / open panel
    const hidden = el.getAttribute("aria-hidden");
    if (hidden === "true") {
      continue;
    }
    if (el.hasAttribute("data-open") || el.getAttribute("data-open") === "") {
      return el;
    }
    // data-open may be boolean attribute equivalent
    if (el.matches("[data-open]")) {
      return el;
    }
  }
  // Fallback: any settings items that currently have children (open)
  for (const el of candidates) {
    if (el.childElementCount > 0) {
      return el;
    }
  }
  return candidates[0] ?? null;
}

function isSettingsMenu(el: Element | null): el is Element {
  if (!el) {
    return false;
  }
  return el.matches("media-menu.vds-settings-menu, .vds-settings-menu")
    || Boolean(el.closest?.("media-menu.vds-settings-menu, .vds-settings-menu"));
}

/**
 * Wire Settings ⚙ open → inject Always Ad-Free at the top of the panel.
 */
export function installDefaultMenuItem(elPlayer: HTMLElement): DefaultMenuItemController {
  let disposed = false;
  let lastEnabled = false;
  let observer: MutationObserver | null = null;
  let injectTimer = 0;
  let activeItems: HTMLElement | null = null;

  void getAdFreeDefaultEnabled().then(enabled => {
    lastEnabled = enabled;
  });

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    activeItems = null;
    if (injectTimer) {
      window.clearTimeout(injectTimer);
      injectTimer = 0;
    }
  }

  function injectInto(elItems: HTMLElement) {
    if (disposed) {
      return;
    }
    ensureStyles();

    const existing = elItems.querySelector<HTMLElement>(`.${SECTION_CLASS}`);
    if (existing) {
      const elCheckbox = existing.querySelector<HTMLElement>(".vds-menu-checkbox");
      if (elCheckbox) {
        syncCheckbox(elCheckbox, lastEnabled);
      }
      existing.querySelector(`.${ROW_CLASS}`)
        ?.setAttribute("aria-checked", lastEnabled ? "true" : "false");
      // Keep as first child
      if (elItems.firstElementChild !== existing) {
        elItems.prepend(existing);
      }
      return;
    }

    // Only inject when the root settings list is populated (Speed/Captions/…)
    // or empty-but-open — avoid nested submenu bodies
    const isRootPanel = elItems.classList.contains("vds-settings-menu-items")
      || elItems.matches("media-menu-items.vds-settings-menu-items");
    if (!isRootPanel) {
      return;
    }

    const elSection = buildSection(lastEnabled, enabled => {
      lastEnabled = enabled;
    });
    elItems.prepend(elSection);
    log.debug("injected Always Ad-Free into settings menu", { enabled: lastEnabled });
  }

  function scheduleInject(elMenu?: Element | null) {
    if (disposed) {
      return;
    }
    let attempts = 0;
    const maxAttempts = 24;

    function tick() {
      if (disposed) {
        return;
      }
      const elItems = findSettingsMenuItems(elMenu);
      if (elItems) {
        injectInto(elItems);
        // Re-inject if Vidstack re-renders the open panel and drops our row
        if (activeItems !== elItems) {
          observer?.disconnect();
          activeItems = elItems;
          observer = new MutationObserver(() => {
            if (disposed || !activeItems) {
              return;
            }
            if (!activeItems.querySelector(`.${SECTION_CLASS}`)) {
              injectInto(activeItems);
            }
          });
          observer.observe(elItems, { childList: true });
        }
        return;
      }
      attempts += 1;
      if (attempts < maxAttempts) {
        injectTimer = window.setTimeout(tick, 40);
      } else {
        log.warn("settings menu items not found for Always Ad-Free inject");
      }
    }

    if (injectTimer) {
      window.clearTimeout(injectTimer);
    }
    // Items render after open signal — wait a couple frames then poll
    requestAnimationFrame(() => {
      requestAnimationFrame(tick);
    });
  }

  function onOpen(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (!isSettingsMenu(target)) {
      return;
    }
    const elMenu = target.matches("media-menu.vds-settings-menu, .vds-settings-menu")
      ? target
      : target.closest("media-menu.vds-settings-menu, .vds-settings-menu");

    void getAdFreeDefaultEnabled().then(enabled => {
      lastEnabled = enabled;
      scheduleInject(elMenu);
    });
  }

  function onClose(event: Event) {
    const target = event.target;
    if (!(target instanceof Element) || !isSettingsMenu(target)) {
      return;
    }
    stopObserver();
  }

  // Capture: open/close fire on media-menu inside player (items may be portaled)
  elPlayer.addEventListener("open", onOpen, true);
  elPlayer.addEventListener("close", onClose, true);

  // Also catch clicks on the gear (in case open event order is flaky)
  elPlayer.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (!target.closest(".vds-settings-menu .vds-menu-button, media-menu.vds-settings-menu media-menu-button")) {
      return;
    }
    // Menu opens on same click — schedule inject shortly after
    void getAdFreeDefaultEnabled().then(enabled => {
      lastEnabled = enabled;
      scheduleInject(target.closest("media-menu.vds-settings-menu, .vds-settings-menu"));
    });
  }, true);

  const unwatchStorage = (() => {
    try {
      const onStorage = (
        changes: Record<string, browser.Storage.StorageChange>,
        area: string
      ) => {
        if (area !== "local") {
          return;
        }
        const optionsChange = changes.options ?? changes["local:options"];
        if (!optionsChange?.newValue || typeof optionsChange.newValue !== "object") {
          return;
        }
        const next = (optionsChange.newValue as { isAdFreeDefault?: boolean })
          .isAdFreeDefault === true;
        lastEnabled = next;
        document.querySelectorAll<HTMLElement>(`.${ROW_CLASS} .vds-menu-checkbox`).forEach(el => {
          syncCheckbox(el, next);
        });
        document.querySelectorAll<HTMLElement>(`.${ROW_CLASS}`).forEach(el => {
          el.setAttribute("aria-checked", next ? "true" : "false");
        });
      };
      browser.storage.onChanged.addListener(onStorage);
      return () => browser.storage.onChanged.removeListener(onStorage);
    } catch {
      return () => {};
    }
  })();

  ensureStyles();
  log.info("Always Ad-Free settings injector ready");

  return {
    dispose() {
      disposed = true;
      elPlayer.removeEventListener("open", onOpen, true);
      elPlayer.removeEventListener("close", onClose, true);
      stopObserver();
      unwatchStorage();
      document.querySelectorAll(`.${SECTION_CLASS}`).forEach(el => el.remove());
    }
  };
}
