<script lang="ts">
  import downloadIcon from "../../icons/download.svg?raw";
  import folderIcon from "../../icons/folder.svg?raw";
  import closeIcon from "../../icons/close.svg?raw";
  import SettingsGroup from "../ui/SettingsGroup.svelte";
  import { MessageType, sendMessage } from "@/lib/messaging/messaging";

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
