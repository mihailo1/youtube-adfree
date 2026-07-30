<script lang="ts">
  import downloadIcon from "../../icons/download.svg?raw";
  import folderIcon from "../../icons/folder.svg?raw";
  import closeIcon from "../../icons/close.svg?raw";
  import SettingsGroup from "../ui/SettingsGroup.svelte";
  import { MessageType, sendMessage } from "@/lib/messaging/messaging";
  import { setOption } from "@/lib/storage/storage";
  import type { Options } from "@/types";

  let {
    options
  }: {
    options: Options;
  } = $props();

  let entryCount = $state<number | null>(null);
  let sessionStarted = $state<number | null>(null);
  let status = $state("");
  let isBusy = $state(false);

  async function refreshMeta() {
    try {
      const snapshot = await sendMessage(MessageType.AdFreeLogGet);
      if (snapshot) {
        entryCount = snapshot.count;
        sessionStarted = snapshot.sessionStarted;
      }
    } catch {
      entryCount = null;
    }
  }

  void refreshMeta();

  function sessionLabel(): string {
    if (sessionStarted == null) {
      return "—";
    }
    try {
      return new Date(sessionStarted).toLocaleString();
    } catch {
      return "—";
    }
  }

  async function fetchLogText(): Promise<string> {
    const snapshot = await sendMessage(MessageType.AdFreeLogGet);
    if (!snapshot?.text) {
      throw new Error("No session log available");
    }
    entryCount = snapshot.count;
    sessionStarted = snapshot.sessionStarted;
    return snapshot.text;
  }

  async function onDownload() {
    if (isBusy) {
      return;
    }
    isBusy = true;
    status = "";
    try {
      const text = await fetchLogText();
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const a = document.createElement("a");
      a.href = url;
      a.download = `youtube-adfree-log-${stamp}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      status = `Downloaded (${entryCount ?? 0} lines)`;
    } catch (error) {
      status = error instanceof Error ? error.message : "Download failed";
    } finally {
      isBusy = false;
    }
  }

  async function onCopy() {
    if (isBusy) {
      return;
    }
    isBusy = true;
    status = "";
    try {
      const text = await fetchLogText();
      await navigator.clipboard.writeText(text);
      status = `Copied (${entryCount ?? 0} lines)`;
    } catch (error) {
      status = error instanceof Error ? error.message : "Copy failed";
    } finally {
      isBusy = false;
    }
  }

  async function onClear() {
    if (isBusy) {
      return;
    }
    isBusy = true;
    status = "";
    try {
      await sendMessage(MessageType.AdFreeLogClear);
      entryCount = 0;
      sessionStarted = Date.now();
      status = "Log cleared";
    } catch (error) {
      status = error instanceof Error ? error.message : "Clear failed";
    } finally {
      isBusy = false;
    }
  }
</script>

<SettingsGroup title="Diagnostics (alpha)">
  <div class="set-item diag-meta">
    <div class="set-lead accent">
      {@html folderIcon}
    </div>
    <div class="set-txt">
      <span class="set-label">Session log</span>
      <span class="set-sub">
        {entryCount == null ? "Loading…" : `${entryCount} lines`}
        · since {sessionLabel()}
      </span>
      {#if status}
        <span class="set-status">{status}</span>
      {/if}
    </div>
  </div>

  <div class="set-item diag-actions">
    <button class="diag-btn primary" disabled={isBusy} onclick={() => void onDownload()} type="button">
      <span class="diag-btn-icon">{@html downloadIcon}</span>
      Download log
    </button>
    <button class="diag-btn" disabled={isBusy} onclick={() => void onCopy()} type="button">
      Copy
    </button>
    <button class="diag-btn danger" disabled={isBusy} onclick={() => void onClear()} type="button">
      <span class="diag-btn-icon">{@html closeIcon}</span>
      Clear
    </button>
  </div>

  <label class="set-item set-item-label">
    <div class="set-txt">
      <span class="set-label">Dev extended logs</span>
      <span class="set-sub">
        Extra session lines: navigation, early cover, auto-enable skip reasons, shell/park.
        Turn on, reproduce, then download the log.
      </span>
    </div>
    <div class="set-trail">
      <span class="set-switch">
        <input
          class="set-switch-input"
          checked={options.isAdFreeDevExtendedLogs ?? false}
          onchange={e => {
            if (!(e.target instanceof HTMLInputElement)) {
              return;
            }
            void setOption({
              key: "isAdFreeDevExtendedLogs",
              value: e.target.checked
            });
          }}
          role="switch"
          type="checkbox"
        />
        <span class="set-switch-track"></span>
      </span>
    </div>
  </label>

  <div class="set-item diag-hint">
    <div class="set-txt">
      <span class="set-sub">
        Captures Ad-Free events for this Chrome session (watch page + player).
        Reproduce a bug, then download the log and send it with a short description.
      </span>
    </div>
  </div>
</SettingsGroup>

<style>
  .set-item {
    display: flex;
    gap: 13px;
    align-items: center;
    min-height: 52px;
    padding: 13px 14px;

    &.set-item-label {
      cursor: pointer;
    }
  }

  .set-lead {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--surface-high);
    color: var(--fg-muted);

    &.accent {
      background: var(--accent-container);
      color: var(--fg);
    }

    :global(svg) {
      width: 20px;
      height: 20px;
    }
  }

  .set-txt {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .set-label {
    color: var(--fg);
    font-weight: 500;
    font-size: 0.84375rem;
  }

  .set-sub {
    color: var(--fg-muted);
    font-size: 0.75rem;
    line-height: 1.3;
  }

  .set-status {
    margin-top: 2px;
    color: var(--accent);
    font-size: 0.75rem;
  }

  .set-trail {
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    color: var(--fg-muted);
  }

  .set-switch {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }

  .set-switch-track {
    position: relative;
    display: block;
    width: 52px;
    height: 32px;
    border-radius: 16px;
    background-color: var(--surface-high);
    transition: background-color 0.2s;

    &::after {
      content: "";
      position: absolute;
      top: 4px;
      left: 4px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--fg);
      box-shadow: 0 1px 2px rgb(0 0 0 / 20%);
      transition: transform 0.2s;
    }
  }

  .set-switch-input {
    position: absolute;
    z-index: 1;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;

    &:checked + .set-switch-track {
      background-color: var(--accent);
    }

    &:checked + .set-switch-track::after {
      transform: translateX(20px);
      background: #fff;
    }

    &:focus-visible + .set-switch-track {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
  }

  .diag-actions {
    flex-wrap: wrap;
    gap: 8px;
  }

  .diag-btn {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-high);
    color: var(--fg);
    font-weight: 500;
    font-size: 0.8125rem;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: var(--surface);
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    &.primary {
      border-color: var(--accent);
      background: var(--accent-container);
    }

    &.danger {
      color: var(--fg-muted);
    }
  }

  .diag-btn-icon {
    display: grid;
    place-items: center;

    :global(svg) {
      width: 16px;
      height: 16px;
    }
  }

  .diag-hint {
    min-height: auto;
    padding-block: 10px 14px;
  }
</style>
