<script lang="ts">
  import type { EndToEndTransaction, TraceSpan } from "$lib/types";

  let {
    tenantId,
    onClose,
  }: {
    tenantId: string;
    onClose: () => void;
  } = $props();

  let transactions = $state<EndToEndTransaction[]>([]);
  let loading = $state(true);

  let selectedTxn = $state<EndToEndTransaction | null>(null);
  let selectedSpan = $state<TraceSpan | null>(null);

  // Resizable panel widths
  let leftWidth = $state(260);
  let rightWidth = $state(340);
  let dragging = $state<"left" | "right" | null>(null);
  let explorerBody: HTMLDivElement | undefined = $state();

  function onPointerDown(side: "left" | "right", e: PointerEvent) {
    dragging = side;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || !explorerBody) return;
    const rect = explorerBody.getBoundingClientRect();
    if (dragging === "left") {
      leftWidth = Math.min(Math.max(e.clientX - rect.left, 160), rect.width - rightWidth - 200);
    } else {
      rightWidth = Math.min(Math.max(rect.right - e.clientX, 200), rect.width - leftWidth - 200);
    }
  }

  function onPointerUp() {
    dragging = null;
  }

  $effect(() => {
    loadTransactions();
  });

  async function loadTransactions() {
    loading = true;
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(tenantId)}/traces`);
      if (res.ok) transactions = await res.json();
    } finally {
      loading = false;
    }
  }

  function selectTransaction(txn: EndToEndTransaction) {
    selectedTxn = txn;
    selectedSpan = txn.rootSpan;
  }

  function selectSpan(span: TraceSpan) {
    selectedSpan = span;
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" }) +
      ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  }

  function formatFullTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }) +
      ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: true }) + " (Local time)";
  }

  function formatDur(ms: number): string {
    if (ms >= 60000) return (ms / 60000).toFixed(1) + "m";
    if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
    return ms.toFixed(3) + "ms";
  }

  function formatDurLong(ms: number): string {
    if (ms >= 60000) return (ms / 60000).toFixed(1) + " m";
    if (ms >= 1000) return (ms / 1000).toFixed(1) + " s";
    return ms + " ms";
  }

  function opLabel(op: string): string {
    switch (op) {
      case "invoke_agent": return "Invoke Agent";
      case "chat": return "LLM";
      case "execute_tool": return "Execute Tool";
      default: return op;
    }
  }

  function opColor(op: string): string {
    switch (op) {
      case "invoke_agent": return "#0078d4";
      case "chat": return "#e3a000";
      case "execute_tool": return "#107c10";
      default: return "#666";
    }
  }

  function totalTokens(span: TraceSpan): string | null {
    if (span.inputTokens == null) return null;
    return ((span.inputTokens ?? 0) + (span.outputTokens ?? 0)).toLocaleString() + "t";
  }
</script>

<div class="trace-explorer">
  <!-- Top bar -->
  <div class="explorer-header">
    <div class="explorer-title">
      <h2>End-to-end transaction details</h2>
      <span class="explorer-subtitle">{tenantId}</span>
    </div>
    <div class="explorer-actions">
      <button class="close-btn" onclick={onClose}>✕</button>
    </div>
  </div>

  <div class="explorer-toolbar">
    <button class="toolbar-btn" onclick={onClose}>← Search results</button>
    <span class="toolbar-sep">|</span>
    <button class="toolbar-btn" onclick={loadTransactions} disabled={loading}>⟳ Refresh</button>
    <span class="toolbar-sep">|</span>
    <span class="toolbar-label">Leave simple view</span>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="explorer-body"
    class:resizing={dragging !== null}
    style="grid-template-columns: {leftWidth}px auto 1fr auto {rightWidth}px"
    bind:this={explorerBody}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
  >
    <!-- ═══ LEFT PANEL: Search results ═══ -->
    <div class="left-panel">
      <h3 class="panel-title">Search results</h3>
      <div class="search-filters">
        <span class="filter-tag">GenAI Operation = invoke_agent</span>
      </div>

      {#if loading}
        <p class="panel-loading">Loading…</p>
      {:else if transactions.length === 0}
        <p class="panel-empty">No transactions found</p>
      {:else}
        <div class="search-list">
          {#each transactions as txn (txn.traceId)}
            <button
              class="search-item"
              class:selected={selectedTxn?.traceId === txn.traceId}
              onclick={() => selectTransaction(txn)}
            >
              <div class="search-item-time">{formatTime(txn.rootSpan.startTime)} - DEPENDENCY</div>
              <div class="search-item-agent">invoke_agent {txn.rootSpan.agentName}</div>
              <div class="search-item-meta">
                Call status: True
                <span class="search-item-arrow">→</span>
              </div>
              <div class="search-item-tag">
                gen_ai.operation.name: <span class="op-tag invoke">invoke_agent</span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Left resizer -->
    <div class="panel-resizer" onpointerdown={(e) => onPointerDown("left", e)} role="separator" aria-label="Resize left panel"></div>

    <!-- ═══ MIDDLE PANEL: Transaction detail ═══ -->
    <div class="middle-panel">
      {#if !selectedTxn}
        <div class="panel-placeholder">
          <p>Select a transaction from the left to view details</p>
        </div>
      {:else}
        <div class="txn-header">
          <h3 class="txn-title">End-to-end transaction</h3>
          <div class="txn-opid">Operation ID: {selectedTxn.traceId} 🔗</div>
        </div>

        <!-- Root span summary -->
        <div class="txn-root-summary">
          <span class="span-badge" style="background: {opColor('invoke_agent')}; color: white;">{opLabel("invoke_agent")}</span>
          <span class="root-agent">{selectedTxn.rootSpan.agentName}</span>
          <span class="root-timing">⏱ {formatDur(selectedTxn.rootSpan.durationMs)}</span>
        </div>

        <!-- Span waterfall -->
        <div class="span-list">
          {#each [selectedTxn.rootSpan, ...selectedTxn.childSpans] as span, i (span.spanId)}
            <button
              class="span-row"
              class:selected={selectedSpan?.spanId === span.spanId}
              class:root={i === 0}
              onclick={() => selectSpan(span)}
            >
              <div class="span-indent" style="padding-left: {i === 0 ? 0 : 20}px">
                {#if i === 0}
                  <span class="expand-icon">⌄</span>
                {/if}
                <span
                  class="span-op-badge"
                  style="background: {opColor(span.operationName)}; color: white;"
                >{opLabel(span.operationName)}</span>

                <span class="span-name">
                  {#if span.operationName === "chat"}
                    {span.model ?? "unknown"}
                  {:else if span.operationName === "execute_tool"}
                    {span.toolName ?? "unknown"}
                  {:else}
                    {span.agentName}
                  {/if}
                </span>
              </div>

              <div class="span-metrics">
                <span class="span-dur">⏱ {formatDur(span.durationMs)}</span>
                {#if totalTokens(span)}
                  <span class="span-tokens">⊕ {totalTokens(span)}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Right resizer -->
    <div class="panel-resizer" onpointerdown={(e) => onPointerDown("right", e)} role="separator" aria-label="Resize right panel"></div>

    <!-- ═══ RIGHT PANEL: Span properties ═══ -->
    <div class="right-panel">
      {#if !selectedSpan}
        <div class="panel-placeholder">
          <p>Select a span to view properties</p>
        </div>
      {:else}
        <!-- Span type badge + name -->
        <div class="prop-header">
          <span
            class="span-op-badge"
            style="background: {opColor(selectedSpan.operationName)}; color: white;"
          >{opLabel(selectedSpan.operationName)}</span>
          <span class="prop-header-name">
            {#if selectedSpan.operationName === "chat"}
              {selectedSpan.model ?? "unknown"}
            {:else if selectedSpan.operationName === "execute_tool"}
              {selectedSpan.toolName ?? "unknown"}
            {:else}
              {selectedSpan.agentName}
            {/if}
          </span>
        </div>

        <!-- Generative AI Properties -->
        <div class="prop-section">
          <h4 class="prop-section-title">Generative AI Properties</h4>
          <table class="prop-table">
            <tbody>
              <tr>
                <td class="prop-key">Event time</td>
                <td class="prop-val">{formatFullTime(selectedSpan.startTime)}</td>
              </tr>
              <tr>
                <td class="prop-key">Duration</td>
                <td class="prop-val">{formatDurLong(selectedSpan.durationMs)}</td>
              </tr>
              {#if selectedSpan.inputTokens != null}
                <tr>
                  <td class="prop-key">Input tokens</td>
                  <td class="prop-val">{selectedSpan.inputTokens?.toLocaleString()}</td>
                </tr>
              {/if}
              {#if selectedSpan.outputTokens != null}
                <tr>
                  <td class="prop-key">Output tokens</td>
                  <td class="prop-val">{selectedSpan.outputTokens?.toLocaleString()}</td>
                </tr>
              {/if}
              {#if selectedSpan.status === "error"}
                <tr>
                  <td class="prop-key">Error</td>
                  <td class="prop-val prop-error">{selectedSpan.errorMessage ?? "Unknown error"}</td>
                </tr>
              {/if}
            </tbody>
          </table>
        </div>

        <!-- Custom Properties -->
        {#if selectedSpan.attributes && Object.keys(selectedSpan.attributes).length > 0}
          <div class="prop-section">
            <h4 class="prop-section-title">Custom Properties</h4>
            <table class="prop-table">
              <tbody>
                {#each Object.entries(selectedSpan.attributes) as [key, val]}
                  <tr>
                    <td class="prop-key">{key}</td>
                    <td class="prop-val">{val}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}

        <!-- Related Items -->
        <div class="prop-section">
          <h4 class="prop-section-title">Related Items</h4>
          <div class="related-items">
            <div class="related-item">
              <span class="related-icon">↗</span>
              Show what happened before and after this dependency in User Flows
            </div>
            <div class="related-item">
              <span class="related-icon">↗</span>
              All available telemetry 5 minutes before and after this event
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .trace-explorer {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: var(--color-surface);
    display: flex;
    flex-direction: column;
    font-size: 0.82rem;
  }

  /* ── Top bar ── */
  .explorer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .explorer-title h2 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
  }

  .explorer-subtitle {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .close-btn {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 1rem;
    color: var(--color-text-muted);
  }

  .close-btn:hover {
    background: var(--color-bg);
    color: var(--color-text);
  }

  .explorer-toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 1rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.78rem;
    background: var(--color-bg);
  }

  .toolbar-btn {
    background: none;
    border: none;
    color: var(--color-primary);
    padding: 0;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 500;
  }

  .toolbar-btn:hover { text-decoration: underline; background: none; }

  .toolbar-sep {
    color: var(--color-border);
  }

  .toolbar-label {
    color: var(--color-text-muted);
  }

  /* ── Body: 3-column layout with resizers ── */
  .explorer-body {
    display: grid;
    /* grid-template-columns set inline via style binding */
    flex: 1;
    overflow: hidden;
  }

  .explorer-body.resizing {
    cursor: col-resize;
    user-select: none;
  }

  .panel-resizer {
    width: 5px;
    cursor: col-resize;
    background: var(--color-border);
    transition: background 0.15s;
    flex-shrink: 0;
  }

  .panel-resizer:hover,
  .explorer-body.resizing .panel-resizer {
    background: var(--color-primary);
  }

  /* ── Left panel ── */
  .left-panel {
    overflow-y: auto;
    padding: 0.75rem 0;
  }

  .panel-title {
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0 0.75rem 0.5rem;
    margin: 0;
  }

  .search-filters {
    padding: 0 0.75rem 0.5rem;
  }

  .filter-tag {
    display: inline-block;
    font-size: 0.68rem;
    padding: 0.15rem 0.4rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text-muted);
  }

  .search-list {
    display: flex;
    flex-direction: column;
  }

  .search-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.55rem 0.75rem;
    border: none;
    border-left: 3px solid transparent;
    background: none;
    cursor: pointer;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.72rem;
    line-height: 1.45;
  }

  .search-item:hover {
    background: var(--color-bg);
  }

  .search-item.selected {
    border-left-color: var(--color-primary);
    background: #ddf4ff22;
  }

  .search-item-time {
    font-weight: 600;
    color: var(--color-text);
    font-size: 0.74rem;
  }

  .search-item-agent {
    color: var(--color-text-muted);
  }

  .search-item-meta {
    color: var(--color-text-muted);
    display: flex;
    justify-content: space-between;
  }

  .search-item-arrow {
    color: var(--color-primary);
    font-weight: bold;
  }

  .search-item-tag {
    margin-top: 0.2rem;
    color: var(--color-text-muted);
  }

  .op-tag {
    display: inline-block;
    padding: 0 0.3rem;
    border-radius: 3px;
    font-weight: 600;
    font-size: 0.68rem;
  }

  .op-tag.invoke {
    background: #0078d420;
    color: #0078d4;
  }

  /* ── Middle panel ── */
  .middle-panel {
    overflow-y: auto;
    padding: 0.75rem 1rem;
  }

  .panel-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--color-text-muted);
  }

  .txn-header {
    margin-bottom: 0.75rem;
  }

  .txn-title {
    font-size: 0.85rem;
    font-weight: 600;
    margin: 0 0 0.2rem;
  }

  .txn-opid {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
  }

  .txn-root-summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 0.35rem;
  }

  .span-badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.72rem;
    font-weight: 600;
  }

  .root-agent {
    font-weight: 500;
    font-size: 0.82rem;
  }

  .root-timing {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  /* Span list */
  .span-list {
    display: flex;
    flex-direction: column;
  }

  .span-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.35rem 0.25rem;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: none;
    cursor: pointer;
    text-align: left;
    width: 100%;
    gap: 0.5rem;
    border-radius: 0;
  }

  .span-row:hover {
    background: var(--color-bg);
  }

  .span-row.selected {
    background: #0078d410;
  }

  .span-row.root {
    font-weight: 500;
  }

  .span-indent {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex: 1;
    min-width: 0;
  }

  .expand-icon {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    width: 12px;
  }

  .span-op-badge {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-size: 0.68rem;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .span-name {
    font-size: 0.78rem;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .span-metrics {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .span-dur {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
  }

  .span-tokens {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
  }

  /* ── Right panel ── */
  .right-panel {
    overflow-y: auto;
    padding: 0.75rem 1rem;
  }

  .prop-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .prop-header-name {
    font-weight: 600;
    font-size: 0.9rem;
  }

  .prop-section {
    margin-bottom: 1.25rem;
  }

  .prop-section-title {
    font-size: 0.78rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
    color: var(--color-text);
  }

  .prop-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.76rem;
  }

  .prop-table td {
    padding: 0.3rem 0.4rem;
    border-bottom: 1px solid var(--color-border);
    vertical-align: top;
  }

  .prop-table tr:last-child td {
    border-bottom: none;
  }

  .prop-key {
    color: var(--color-text-muted);
    white-space: nowrap;
    width: 40%;
    font-weight: 500;
  }

  .prop-val {
    color: var(--color-text);
    word-break: break-all;
  }

  .prop-error {
    color: var(--color-danger);
  }

  .related-items {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .related-item {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    display: flex;
    align-items: flex-start;
    gap: 0.35rem;
    line-height: 1.4;
  }

  .related-icon {
    color: var(--color-primary);
    flex-shrink: 0;
  }

  .panel-loading, .panel-empty {
    padding: 1rem 0.75rem;
    color: var(--color-text-muted);
    font-size: 0.78rem;
  }
</style>
