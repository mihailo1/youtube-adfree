/**
 * Inject a Vidstack-styled "Always Ad-Free" checkbox into the player settings menu.
 */

import {
  getAdFreeDefaultEnabled,
  setAdFreeDefaultEnabled
} from "@/lib/ad-free/default-pref";
import { createAdFreeLogger } from "@/lib/ad-free/debug-log";

const log = createAdFreeLogger("default-menu");
const ROW_CLASS = "ytdl-always-adfree";
const SECTION_CLASS = "ytdl-always-adfree-section";

export type DefaultMenuItemController = {
  dispose: () => void;
};

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

function buildSection(enabled: boolean): HTMLElement {
  const elSection = document.createElement("div");
  elSection.className = `vds-menu-section ${SECTION_CLASS}`;

  const elBody = document.createElement("div");
  elBody.className = "vds-menu-section-body";

  const elRow = document.createElement("div");
  elRow.className = `vds-menu-item ${ROW_CLASS}`;

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
  elLabel.className = "vds-menu-item-label";
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
  elCheckbox.setAttribute("role", "menuitemcheckbox");
  elCheckbox.setAttribute("tabindex", "0");
  elCheckbox.setAttribute("aria-label", "Always use Ad-Free player");
  syncCheckbox(elCheckbox, enabled);

  async function toggle() {
    const next = elCheckbox.getAttribute("aria-checked") !== "true";
    syncCheckbox(elCheckbox, next);
    try {
      await setAdFreeDefaultEnabled(next);
      log.info("default pref", { enabled: next });
    } catch (error) {
      log.warn("failed to save default pref", {
        message: error instanceof Error ? error.message : String(error)
      });
      syncCheckbox(elCheckbox, !next);
    }
  }

  elCheckbox.addEventListener("pointerup", event => {
    if (event.button === 1) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void toggle();
  });
  elCheckbox.addEventListener("keydown", event => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void toggle();
    }
  });
  // Whole row is clickable
  elRow.addEventListener("click", event => {
    if (event.target === elCheckbox || elCheckbox.contains(event.target as Node)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void toggle();
  });

  elRow.append(elIcon, elText, elHint, elCheckbox);
  elBody.append(elRow);
  elSection.append(elBody);
  return elSection;
}

/**
 * Watch settings menu opens and inject our toggle at the top of the root items list.
 */
export function installDefaultMenuItem(elPlayer: HTMLElement): DefaultMenuItemController {
  let disposed = false;
  let lastEnabled = false;

  void getAdFreeDefaultEnabled().then(enabled => {
    lastEnabled = enabled;
  });

  function inject() {
    if (disposed) {
      return;
    }
    const elItems = elPlayer.querySelector<HTMLElement>(
      ".vds-settings-menu-items.vds-menu-items, media-menu-items.vds-settings-menu-items"
    );
    if (!elItems) {
      return;
    }
    // Only inject into the root panel (not nested submenu bodies)
    if (elItems.getAttribute("data-root") === "false") {
      return;
    }
    if (elItems.querySelector(`.${SECTION_CLASS}`)) {
      const elCheckbox = elItems.querySelector<HTMLElement>(
        `.${ROW_CLASS} .vds-menu-checkbox`
      );
      if (elCheckbox) {
        syncCheckbox(elCheckbox, lastEnabled);
      }
      return;
    }
    const elSection = buildSection(lastEnabled);
    elItems.prepend(elSection);
  }

  function onOpen(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const elMenu = target.matches(".vds-settings-menu, media-menu.vds-settings-menu")
      ? target
      : target.closest(".vds-settings-menu, media-menu.vds-settings-menu");
    if (!elMenu) {
      return;
    }
    void getAdFreeDefaultEnabled().then(enabled => {
      lastEnabled = enabled;
      // Settings items render on open — wait a frame for the list to exist
      requestAnimationFrame(() => {
        requestAnimationFrame(inject);
      });
    });
  }

  elPlayer.addEventListener("open", onOpen, true);

  // Storage may change from popup while menu is open
  const unwatch = (() => {
    try {
      // Dynamic import avoided — use browser storage events
      const onStorage = (
        changes: Record<string, browser.Storage.StorageChange>,
        area: string
      ) => {
        if (area !== "local") {
          return;
        }
        // WXT stores as `local:options` key content
        const optionsChange = changes.options ?? changes["local:options"];
        if (!optionsChange?.newValue || typeof optionsChange.newValue !== "object") {
          return;
        }
        const next = (optionsChange.newValue as { isAdFreeDefault?: boolean })
          .isAdFreeDefault === true;
        lastEnabled = next;
        const elCheckbox = elPlayer.querySelector<HTMLElement>(
          `.${ROW_CLASS} .vds-menu-checkbox`
        );
        if (elCheckbox) {
          syncCheckbox(elCheckbox, next);
        }
      };
      browser.storage.onChanged.addListener(onStorage);
      return () => browser.storage.onChanged.removeListener(onStorage);
    } catch {
      return () => {};
    }
  })();

  return {
    dispose() {
      disposed = true;
      elPlayer.removeEventListener("open", onOpen, true);
      unwatch();
      elPlayer.querySelectorAll(`.${SECTION_CLASS}`).forEach(el => el.remove());
    }
  };
}
