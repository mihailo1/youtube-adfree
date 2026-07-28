/**
 * Inject Always Ad-Free + Quality submenu into the Vidstack Settings (⚙) menu.
 *
 * Settings children are re-created by Lit when the panel opens / submenus refresh,
 * so we re-inject aggressively while the root Settings menu is open.
 */

import {
  getAdFreeDefaultEnabled,
  setAdFreeDefaultEnabled
} from "@/lib/ad-free/default-pref";
import { createAdFreeLogger } from "@/lib/ad-free/debug-log";
import {
  createQualityMenu,
  QUALITY_SECTION_CLASS,
  type QualityMenuController
} from "@/lib/ad-free/quality-menu";
import type { AdFreeQualityOption } from "@/lib/ad-free/resolve-stream";

const log = createAdFreeLogger("default-menu");
const ROW_CLASS = "ytdl-always-adfree";
const SECTION_CLASS = "ytdl-always-adfree-section";
const STYLE_ID = "ytdl-always-adfree-style";

export type DefaultMenuItemController = {
  setSelectedQuality: (qualityId: string) => void;
  dispose: () => void;
};

const TOGGLE_CSS = `
/* YouTube-style Always Ad-Free row (portaled settings panel) */
.${SECTION_CLASS} {
  width: 100%;
  margin: 0 0 2px;
  padding: 0 0 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  box-sizing: border-box;
}
.${ROW_CLASS} {
  display: flex !important;
  align-items: center;
  /* Generous space: icon ··· text ··· switch */
  gap: 18px;
  height: 56px;
  min-height: 56px;
  max-height: 56px;
  padding: 0 !important;
  border-radius: 12px;
  cursor: pointer;
  box-sizing: border-box;
  transition: background 0.12s ease;
}
.${ROW_CLASS}:hover {
  background: rgba(255, 255, 255, 0.1) !important;
}
.${ROW_CLASS} .ytdl-always-adfree-icon {
  display: grid;
  place-items: center;
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  margin-right: 4px;
  border-radius: 50%;
  background: linear-gradient(145deg, rgba(255, 0, 51, 0.28), rgba(255, 0, 51, 0.1));
  color: #ff5a73;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.${ROW_CLASS} .ytdl-always-adfree-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-right: 14px;
  margin-right: 4px;
}
.${ROW_CLASS} .ytdl-always-adfree-label {
  font: 500 14px/1.2 "YouTube Sans", Roboto, Arial, sans-serif !important;
  color: #f5f5f5 !important;
  margin: 0 !important;
}
.${ROW_CLASS} .ytdl-always-adfree-desc {
  font: 400 11.5px/1.3 "YouTube Sans", Roboto, Arial, sans-serif;
  color: rgba(255, 255, 255, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.${ROW_CLASS} .ytdl-always-adfree-hint {
  display: none; /* checkbox is enough; keeps row stable */
}
/* YouTube-like pill switch — pinned to trailing edge */
.${ROW_CLASS} .ytdl-always-adfree-checkbox {
  position: relative;
  flex: 0 0 44px;
  width: 44px;
  min-width: 44px;
  height: 24px;
  margin-left: auto;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.18) !important;
  box-shadow: none !important;
  pointer-events: none;
  box-sizing: border-box;
  transition: background 0.18s ease;
}
.${ROW_CLASS} .ytdl-always-adfree-checkbox::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.${ROW_CLASS} .ytdl-always-adfree-checkbox[aria-checked="true"],
.${ROW_CLASS} .ytdl-always-adfree-checkbox.is-on {
  background: #ff0033 !important;
}
.${ROW_CLASS} .ytdl-always-adfree-checkbox[aria-checked="true"]::after,
.${ROW_CLASS} .ytdl-always-adfree-checkbox.is-on::after {
  transform: translateX(20px);
}

/* Fallback surface tokens if player.css not yet applied to portaled nodes */
.vds-settings-menu-items.vds-menu-items[data-root],
media-menu-items.vds-settings-menu-items[data-root] {
  --media-menu-item-border-radius: 10px;
  --media-menu-top-bar-bg: rgba(255, 255, 255, 0.1);
  --media-menu-section-bg: rgba(255, 255, 255, 0.04);
  --media-menu-section-border-radius: 10px;
  --media-menu-bg: rgba(15, 15, 15, 0.88) !important;
  --media-menu-border-radius: 12px !important;
  --media-menu-padding: 8px !important;
  background: rgba(15, 15, 15, 0.88) !important;
  border: 1px solid rgba(255, 255, 255, 0.12) !important;
  border-radius: 12px !important;
  backdrop-filter: blur(16px) saturate(1.2) !important;
  -webkit-backdrop-filter: blur(16px) saturate(1.2) !important;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.5) !important;
  overflow-x: hidden !important;
}

/* Expanded ← header inside settings (Speed / Quality / Captions / …) */
.vds-settings-menu-items .vds-menu-item[aria-expanded="true"],
.vds-settings-menu-items media-menu-button.vds-menu-item[aria-expanded="true"],
.vds-settings-menu-items media-menu-button.vds-menu-item[data-open] {
  border-radius: 10px !important;
  border-bottom: none !important;
  margin-bottom: 6px !important;
  background: rgba(28, 28, 28, 0.72) !important;
  font-weight: 600 !important;
  top: 0 !important;
  backdrop-filter: blur(14px) saturate(1.2) !important;
  -webkit-backdrop-filter: blur(14px) saturate(1.2) !important;
}

.vds-settings-menu-items .vds-menu-item,
.vds-settings-menu-items media-menu-button.vds-menu-item,
.vds-settings-menu-items .vds-radio {
  border-radius: 10px !important;
}

.vds-settings-menu-items .vds-menu-section-body {
  border-radius: 10px !important;
  background: rgba(255, 255, 255, 0.04) !important;
  border: 1px solid rgba(255, 255, 255, 0.06);
  padding: 2px !important;
}

.vds-settings-menu-items .vds-menu-section-title {
  padding: 4px 12px 6px;
  color: rgba(255, 255, 255, 0.45);
  font: 600 11px/1.2 "YouTube Sans", Roboto, Arial, sans-serif;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.vds-settings-menu-items .vds-radio[aria-checked="true"],
.vds-settings-menu-items .vds-radio[data-checked] {
  background: rgb(255 0 51 / 0.16) !important;
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
}

function buildAlwaysSection(
  enabled: boolean,
  onEnabledChange: (enabled: boolean) => void
): HTMLElement {
  ensureStyles();

  const elSection = document.createElement("div");
  elSection.className = `vds-menu-section ${SECTION_CLASS}`;
  elSection.dataset.ytdlAlwaysAdfree = "1";

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
  elLabel.className = "ytdl-always-adfree-label";
  elLabel.textContent = "Always Ad-Free";

  const elDesc = document.createElement("div");
  elDesc.className = "ytdl-always-adfree-desc";
  elDesc.textContent = "Skip ads by default on watch pages";

  elText.append(elLabel, elDesc);

  const elCheckbox = document.createElement("div");
  elCheckbox.className = "ytdl-always-adfree-checkbox";
  elCheckbox.setAttribute("role", "presentation");
  elCheckbox.setAttribute("aria-hidden", "true");
  syncCheckbox(elCheckbox, enabled);

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

  elRow.addEventListener("click", event => {
    void toggle(event);
  });
  elRow.addEventListener("keydown", event => {
    if (event.key === " " || event.key === "Enter") {
      void toggle(event);
    }
  });

  elRow.append(elIcon, elText, elCheckbox);
  elSection.append(elRow);
  return elSection;
}

function findRootSettingsItems(elMenu?: Element | null): HTMLElement | null {
  if (elMenu instanceof HTMLElement) {
    const host = elMenu as HTMLElement & { contentElement?: HTMLElement | null };
    if (host.contentElement instanceof HTMLElement
      && host.contentElement.classList.contains("vds-settings-menu-items")) {
      return host.contentElement;
    }
    const nested = elMenu.querySelector<HTMLElement>(
      ":scope > media-menu-portal media-menu-items.vds-settings-menu-items, "
      + ":scope > media-menu-items.vds-settings-menu-items, "
      + "media-menu-items.vds-settings-menu-items"
    );
    if (nested?.classList.contains("vds-settings-menu-items")) {
      return nested;
    }
  }

  const candidates = document.querySelectorAll<HTMLElement>(
    "media-menu-items.vds-settings-menu-items, .vds-settings-menu-items.vds-menu-items"
  );
  for (const el of candidates) {
    // Root settings list only (not nested submenu panels)
    if (!el.classList.contains("vds-settings-menu-items")) {
      continue;
    }
    if (el.getAttribute("aria-hidden") === "true") {
      continue;
    }
    if (el.hasAttribute("data-open") || el.childElementCount > 0) {
      return el;
    }
  }
  return candidates[0] ?? null;
}

function isRootSettingsMenu(el: Element | null): el is Element {
  if (!el) {
    return false;
  }
  // Only the top-level settings gear menu — NOT nested Audio/Captions menus
  return el.matches("media-menu.vds-settings-menu, .vds-settings-menu");
}

/**
 * Wire Settings ⚙ open → inject Always Ad-Free + Quality submenu.
 */
export function installDefaultMenuItem(
  elPlayer: HTMLElement,
  options?: {
    qualities?: AdFreeQualityOption[];
    selectedQualityId?: string;
    onQualitySelect?: (quality: AdFreeQualityOption) => void;
  }
): DefaultMenuItemController {
  let disposed = false;
  let lastEnabled = false;
  let observer: MutationObserver | null = null;
  let injectTimer = 0;
  let keepAliveTimer = 0;
  let activeItems: HTMLElement | null = null;
  let elAlwaysSection: HTMLElement | null = null;
  let settingsOpen = false;

  const qualities = options?.qualities ?? [];
  const onQualitySelect = options?.onQualitySelect;

  let qualityMenu: QualityMenuController | null = null;
  if (qualities.length > 0 && onQualitySelect) {
    qualityMenu = createQualityMenu(
      qualities,
      options?.selectedQualityId ?? qualities[0]?.id ?? "",
      onQualitySelect
    );
  }

  void getAdFreeDefaultEnabled().then(enabled => {
    lastEnabled = enabled;
  });

  function stopWatchers() {
    observer?.disconnect();
    observer = null;
    activeItems = null;
    if (injectTimer) {
      window.clearTimeout(injectTimer);
      injectTimer = 0;
    }
    if (keepAliveTimer) {
      window.clearInterval(keepAliveTimer);
      keepAliveTimer = 0;
    }
  }

  function ensureAlwaysSection(): HTMLElement {
    if (elAlwaysSection?.isConnected
      || (elAlwaysSection && elAlwaysSection.isConnected === false && elAlwaysSection.dataset.ytdlAlwaysAdfree)) {
      // Refresh checkbox state
      const elCheckbox = elAlwaysSection.querySelector<HTMLElement>(".ytdl-always-adfree-checkbox");
      if (elCheckbox) {
        syncCheckbox(elCheckbox, lastEnabled);
      }
      elAlwaysSection.querySelector(`.${ROW_CLASS}`)
        ?.setAttribute("aria-checked", lastEnabled ? "true" : "false");
      if (!elAlwaysSection.isConnected) {
        // still reusable detached node
      }
      return elAlwaysSection;
    }
    elAlwaysSection = buildAlwaysSection(lastEnabled, enabled => {
      lastEnabled = enabled;
    });
    return elAlwaysSection;
  }

  function needsInject(elItems: HTMLElement): boolean {
    const hasAlways = Boolean(elItems.querySelector(`:scope > .${SECTION_CLASS}, :scope .${SECTION_CLASS}`));
    const hasQuality = !qualityMenu
      || Boolean(elItems.querySelector(`:scope > .${QUALITY_SECTION_CLASS}, :scope .${QUALITY_SECTION_CLASS}`));
    return !hasAlways || !hasQuality;
  }

  function injectInto(elItems: HTMLElement) {
    if (disposed) {
      return;
    }
    ensureStyles();

    if (!elItems.classList.contains("vds-settings-menu-items")) {
      return;
    }

    elItems.style.transition = "none";

    const elAlways = ensureAlwaysSection();
    const elQuality = qualityMenu?.root ?? null;

    // Only touch DOM when order is wrong or nodes missing (reduces flicker)
    if (elItems.firstElementChild !== elAlways) {
      elItems.prepend(elAlways);
    }
    if (elQuality) {
      if (elAlways.nextElementSibling !== elQuality) {
        elAlways.after(elQuality);
      }
    }
  }

  function watchItems(elItems: HTMLElement) {
    if (activeItems === elItems && observer) {
      if (needsInject(elItems)) {
        injectInto(elItems);
      }
      return;
    }
    observer?.disconnect();
    activeItems = elItems;
    injectInto(elItems);
    observer = new MutationObserver(() => {
      if (disposed || !activeItems || !settingsOpen) {
        return;
      }
      // Lit re-renders wipe our nodes when submenu state changes
      if (needsInject(activeItems) || activeItems.firstElementChild !== elAlwaysSection) {
        injectInto(activeItems);
      }
    });
    observer.observe(elItems, { childList: true, subtree: false });
  }

  function scheduleInject(elMenu?: Element | null) {
    if (disposed) {
      return;
    }
    let attempts = 0;
    const maxAttempts = 30;

    function tick() {
      if (disposed || !settingsOpen) {
        return;
      }
      const elItems = findRootSettingsItems(elMenu);
      if (elItems && elItems.childElementCount >= 0) {
        // Wait until native Speed/Captions rows exist OR empty open panel
        watchItems(elItems);
        return;
      }
      attempts += 1;
      if (attempts < maxAttempts) {
        injectTimer = window.setTimeout(tick, 40);
      }
    }

    if (injectTimer) {
      window.clearTimeout(injectTimer);
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(tick);
    });
  }

  function startKeepAlive(elMenu?: Element | null) {
    if (keepAliveTimer) {
      window.clearInterval(keepAliveTimer);
    }
    // Lit can wipe children after submenu open/close without a childList we catch
    keepAliveTimer = window.setInterval(() => {
      if (disposed || !settingsOpen) {
        return;
      }
      const elItems = findRootSettingsItems(elMenu) ?? activeItems;
      if (elItems && needsInject(elItems)) {
        watchItems(elItems);
      }
    }, 250);
  }

  function onOpen(event: Event) {
    const target = event.target;
    if (!(target instanceof Element) || !isRootSettingsMenu(target)) {
      return;
    }
    settingsOpen = true;
    void getAdFreeDefaultEnabled().then(enabled => {
      lastEnabled = enabled;
      scheduleInject(target);
      startKeepAlive(target);
    });
  }

  function onClose(event: Event) {
    const target = event.target;
    if (!(target instanceof Element) || !isRootSettingsMenu(target)) {
      return;
    }
    settingsOpen = false;
    stopWatchers();
  }

  elPlayer.addEventListener("open", onOpen, true);
  elPlayer.addEventListener("close", onClose, true);

  elPlayer.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (!target.closest(
      "media-menu.vds-settings-menu > media-tooltip media-menu-button, "
      + "media-menu.vds-settings-menu media-menu-button.vds-button"
    )) {
      return;
    }
    const elMenu = target.closest("media-menu.vds-settings-menu, .vds-settings-menu");
    settingsOpen = true;
    void getAdFreeDefaultEnabled().then(enabled => {
      lastEnabled = enabled;
      scheduleInject(elMenu);
      startKeepAlive(elMenu);
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
        document.querySelectorAll<HTMLElement>(`.${ROW_CLASS} .ytdl-always-adfree-checkbox`).forEach(el => {
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
  log.info("Settings extras ready (Always Ad-Free + Quality submenu)");

  return {
    setSelectedQuality(qualityId: string) {
      qualityMenu?.setSelected(qualityId);
    },
    dispose() {
      disposed = true;
      settingsOpen = false;
      elPlayer.removeEventListener("open", onOpen, true);
      elPlayer.removeEventListener("close", onClose, true);
      stopWatchers();
      unwatchStorage();
      qualityMenu?.dispose();
      qualityMenu = null;
      elAlwaysSection?.remove();
      elAlwaysSection = null;
      document.querySelectorAll(`.${SECTION_CLASS}`).forEach(el => el.remove());
      document.querySelectorAll(`.${QUALITY_SECTION_CLASS}`).forEach(el => el.remove());
    }
  };
}
