import type { AdFreeQualityOption } from "@/lib/ad-free/resolve-stream";

export type QualityMenuController = {
  setSelected: (qualityId: string) => void;
  close: () => void;
  dispose: () => void;
  /** Nested <media-menu> injected into Settings root list. */
  root: HTMLElement;
};

export const QUALITY_SECTION_CLASS = "ytdl-quality-menu";
const STYLE_ID = "ytdl-quality-settings-style";

const QUALITY_CSS = `
/* Nested Quality submenu inside Settings (mirrors Vidstack Speed/Captions rows) */
media-menu.${QUALITY_SECTION_CLASS},
.${QUALITY_SECTION_CLASS} {
  display: block;
  width: 100%;
}
.${QUALITY_SECTION_CLASS} > media-menu-button.ytdl-quality-button,
.${QUALITY_SECTION_CLASS} > .ytdl-quality-button {
  display: flex !important;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 10px 12px !important;
  border: 0 !important;
  border-radius: 10px !important;
  background: transparent;
  color: #f5f5f5;
  font: 500 14px/1.2 "YouTube Sans", Roboto, Arial, sans-serif;
  cursor: pointer;
  box-sizing: border-box;
  text-align: left;
}
.${QUALITY_SECTION_CLASS} > media-menu-button.ytdl-quality-button:hover,
.${QUALITY_SECTION_CLASS} > .ytdl-quality-button:hover {
  background: rgba(255, 255, 255, 0.1) !important;
}
.${QUALITY_SECTION_CLASS} > media-menu-button.ytdl-quality-button[aria-expanded="true"],
.${QUALITY_SECTION_CLASS} > media-menu-button.ytdl-quality-button[data-open] {
  border-radius: 10px !important;
  border-bottom: none !important;
  margin-bottom: 6px !important;
  background: rgba(28, 28, 28, 0.72) !important;
  backdrop-filter: blur(14px) saturate(1.2) !important;
  -webkit-backdrop-filter: blur(14px) saturate(1.2) !important;
  font-weight: 600 !important;
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-button-icon {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  color: rgba(255, 255, 255, 0.85);
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-button-label {
  flex: 1 1 auto;
  min-width: 0;
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-button-hint {
  flex: 0 0 auto;
  min-width: 3.25rem;
  text-align: right;
  color: rgba(255, 255, 255, 0.55);
  font: 500 13px/1 "YouTube Sans", Roboto, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-button-chevron {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  opacity: 0.55;
}
.${QUALITY_SECTION_CLASS} media-menu-items.ytdl-quality-items,
.${QUALITY_SECTION_CLASS} .ytdl-quality-items {
  width: 100%;
  padding: 4px 0 2px !important;
  box-sizing: border-box;
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0 4px 4px;
  list-style: none;
  width: 100%;
  box-sizing: border-box;
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-row {
  display: flex !important;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 40px;
  margin: 0;
  padding: 8px 12px !important;
  border: 0 !important;
  border-radius: 10px;
  background: transparent;
  color: #f1f1f1;
  font: 500 13.5px/1.2 "YouTube Sans", Roboto, Arial, sans-serif;
  cursor: pointer;
  box-sizing: border-box;
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-row:hover {
  background: rgba(255, 255, 255, 0.1) !important;
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-row.is-selected {
  background: rgb(255 0 51 / 0.18) !important;
  color: #fff;
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-row-check {
  flex: 0 0 1rem;
  width: 1rem;
  text-align: center;
  opacity: 0;
  color: #ff4d6a;
  font-weight: 700;
}
.${QUALITY_SECTION_CLASS} .ytdl-quality-row.is-selected .ytdl-quality-row-check {
  opacity: 1;
}
`;

const ICON_QUALITY = (
  "<svg class=\"ytdl-quality-button-icon\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\">"
  + "<path d=\"M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 14H5V6h14v12Z\"/>"
  + "<path d=\"M7.5 15.5h2v-7h-2v7Zm3.75 0h2v-4.5h-2v4.5Zm3.75 0h2V8.5h-2v7Z\"/>"
  + "</svg>"
);

const ICON_CHEVRON = (
  "<svg class=\"ytdl-quality-button-chevron\" viewBox=\"0 0 24 24\" fill=\"none\" "
  + "stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" "
  + "stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m9 6 6 6-6 6\"/></svg>"
);

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const elStyle = document.createElement("style");
  elStyle.id = STYLE_ID;
  elStyle.textContent = QUALITY_CSS;
  (document.head ?? document.documentElement).append(elStyle);
}

/**
 * Quality as a **submenu** under Settings ⚙ (like Speed / Captions).
 * Uses real <media-menu> so Vidstack slide-in / back navigation works.
 */
export function createQualityMenu(
  qualities: AdFreeQualityOption[],
  selectedId: string,
  onSelect: (quality: AdFreeQualityOption) => void
): QualityMenuController {
  ensureStyles();

  const elMenu = document.createElement("media-menu");
  elMenu.className = `vds-menu vds-quality-menu ${QUALITY_SECTION_CLASS}`;
  elMenu.dataset.ytdlQuality = "1";

  const elButton = document.createElement("media-menu-button");
  elButton.className = "vds-menu-button vds-menu-item ytdl-quality-button";
  elButton.setAttribute("aria-label", "Quality");

  const elLabel = document.createElement("span");
  elLabel.className = "ytdl-quality-button-label vds-menu-item-label";
  elLabel.textContent = "Quality";

  const elHint = document.createElement("span");
  elHint.className = "ytdl-quality-button-hint vds-menu-item-hint";
  elHint.dataset.part = "hint";

  const elIconWrap = document.createElement("span");
  elIconWrap.innerHTML = ICON_QUALITY;
  const elChevronWrap = document.createElement("span");
  elChevronWrap.innerHTML = ICON_CHEVRON;

  elButton.append(elIconWrap.firstElementChild!, elLabel, elHint, elChevronWrap.firstElementChild!);

  const elItems = document.createElement("media-menu-items");
  elItems.className = "vds-menu-items ytdl-quality-items";

  const elList = document.createElement("ul");
  elList.className = "ytdl-quality-list";
  elList.setAttribute("role", "listbox");
  elList.setAttribute("aria-label", "Video quality");

  let selected = selectedId;

  function labelFor(quality: AdFreeQualityOption) {
    return quality.label;
  }

  function activeLabel() {
    const active = qualities.find(item => item.id === selected) ?? qualities[0];
    return active ? labelFor(active) : "—";
  }

  function renderItems() {
    elHint.textContent = activeLabel();
    elList.replaceChildren();
    for (const quality of qualities) {
      const elItem = document.createElement("li");
      elItem.className = "ytdl-quality-row vds-radio";
      elItem.setAttribute("role", "option");
      elItem.dataset.qualityId = quality.id;
      elItem.tabIndex = 0;

      const elText = document.createElement("span");
      elText.className = "vds-radio-label";
      elText.textContent = labelFor(quality);

      const elCheck = document.createElement("span");
      elCheck.className = "ytdl-quality-row-check";
      elCheck.setAttribute("aria-hidden", "true");
      elCheck.textContent = "✓";

      const isSelected = quality.id === selected;
      elItem.setAttribute("aria-selected", isSelected ? "true" : "false");
      elItem.classList.toggle("is-selected", isSelected);

      const pick = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        if (quality.id === selected) {
          return;
        }
        selected = quality.id;
        renderItems();
        onSelect(quality);
      };

      elItem.addEventListener("click", pick);
      elItem.addEventListener("keydown", event => {
        if (event.key === " " || event.key === "Enter") {
          pick(event);
        }
      });

      elItem.append(elText, elCheck);
      elList.append(elItem);
    }
  }

  renderItems();
  elItems.append(elList);
  elMenu.append(elButton, elItems);

  return {
    root: elMenu,
    setSelected(qualityId) {
      if (selected === qualityId) {
        elHint.textContent = activeLabel();
        return;
      }
      selected = qualityId;
      renderItems();
    },
    close() {},
    dispose() {
      elMenu.remove();
    }
  };
}
