import type { AdFreeQualityOption } from "@/lib/ad-free/resolve-stream";

export type QualityMenuController = {
  setSelected: (qualityId: string) => void;
  /** Close the dropdown if open (e.g. when player chrome auto-hides). */
  close: () => void;
  dispose: () => void;
  root: HTMLElement;
};

const ICON_CHEVRON = (
  "<svg class=\"quality-menu-chevron\" width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" "
  + "fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" "
  + "stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m6 9 6 6 6-6\"/></svg>"
);

/**
 * Custom quality picker — single-rendition engine owns loads; Vidstack multi-src is never used.
 * Chip styling matches the Ad-Free toggle on the watch page.
 */
export function createQualityMenu(
  qualities: AdFreeQualityOption[],
  selectedId: string,
  onSelect: (quality: AdFreeQualityOption) => void
): QualityMenuController {
  const elRoot = document.createElement("div");
  elRoot.className = "quality-menu";

  const elButton = document.createElement("button");
  elButton.type = "button";
  elButton.className = "quality-menu-button";
  elButton.setAttribute("aria-haspopup", "listbox");
  elButton.setAttribute("aria-expanded", "false");

  const elList = document.createElement("ul");
  elList.className = "quality-menu-list";
  elList.hidden = true;
  elList.setAttribute("role", "listbox");

  let selected = selectedId;
  let isOpen = false;

  function labelFor(quality: AdFreeQualityOption) {
    return quality.label;
  }

  function syncButton() {
    const active = qualities.find(item => item.id === selected) ?? qualities[0];
    const label = active ? active.label : "Quality";
    elButton.replaceChildren();

    const elLabel = document.createElement("span");
    elLabel.className = "quality-menu-label";
    elLabel.textContent = label;

    const elMeta = document.createElement("span");
    elMeta.className = "quality-menu-meta";
    elMeta.textContent = "HD";

    const elChevron = document.createElement("span");
    elChevron.className = "quality-menu-chevron-wrap";
    elChevron.innerHTML = ICON_CHEVRON;

    elButton.append(elLabel, elMeta, elChevron);
    elButton.title = `Quality: ${label}`;
    elButton.setAttribute("aria-label", `Video quality ${label}`);
  }

  function setOpen(open: boolean) {
    isOpen = open;
    elList.hidden = !open;
    elButton.setAttribute("aria-expanded", open ? "true" : "false");
    elRoot.classList.toggle("is-open", open);
  }

  function renderItems() {
    elList.replaceChildren();
    for (const quality of qualities) {
      const elItem = document.createElement("li");
      elItem.className = "quality-menu-item";
      elItem.setAttribute("role", "option");
      elItem.dataset.qualityId = quality.id;

      const elText = document.createElement("span");
      elText.className = "quality-menu-item-label";
      elText.textContent = labelFor(quality);

      const elCheck = document.createElement("span");
      elCheck.className = "quality-menu-item-check";
      elCheck.setAttribute("aria-hidden", "true");
      elCheck.textContent = "✓";

      elItem.append(elText, elCheck);
      elItem.setAttribute("aria-selected", quality.id === selected ? "true" : "false");
      elItem.classList.toggle("is-selected", quality.id === selected);
      elItem.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (quality.id === selected) {
          setOpen(false);
          return;
        }
        selected = quality.id;
        syncButton();
        renderItems();
        setOpen(false);
        onSelect(quality);
      });
      elList.append(elItem);
    }
  }

  function onDocumentPointer(event: Event) {
    if (!isOpen) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && elRoot.contains(target)) {
      return;
    }
    setOpen(false);
  }

  elButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(!isOpen);
  });

  document.addEventListener("pointerdown", onDocumentPointer, true);

  syncButton();
  renderItems();
  elRoot.append(elButton, elList);

  return {
    root: elRoot,
    setSelected(qualityId) {
      selected = qualityId;
      syncButton();
      renderItems();
    },
    close() {
      setOpen(false);
    },
    dispose() {
      document.removeEventListener("pointerdown", onDocumentPointer, true);
      elRoot.remove();
    }
  };
}
