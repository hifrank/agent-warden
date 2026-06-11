<script lang="ts">
  let {
    tenantId,
  }: {
    tenantId: string;
  } = $props();

  type SubTab = "aks" | "dspm";
  let activeSubTab = $state<SubTab>("aks");

  // ── AKS Logs state ──
  let aksLogs = $state("");
  let aksPodName = $state("");
  let aksContainer = $state("openclaw-gateway");
  let aksTailLines = $state(200);
  let aksSinceSeconds = $state(3600);
  let aksLoading = $state(false);
  let aksError = $state("");
  let aksAutoRefresh = $state(false);
  let aksRefreshTimer = $state<ReturnType<typeof setInterval> | null>(null);

  const containerOptions = ["openclaw-gateway", "saas-auth-proxy", "heartbeat", "agent-warden-purview-dlp"];
  const sinceOptions = [
    { label: "5m", value: 300 },
    { label: "15m", value: 900 },
    { label: "1h", value: 3600 },
    { label: "6h", value: 21600 },
    { label: "24h", value: 86400 },
  ];

  // ── DSPM Activities state ──
  interface DlpActivity {
    timestamp: string;
    traceId: string;
    spanId: string;
    toolName: string;
    action: string;
    result: string;
    durationMs: number;
    agentName: string;
    plugin: string;
  }

  let dlpActivities = $state<DlpActivity[]>([]);
  let dlpLoading = $state(false);
  let dlpError = $state("");
  let dlpDays = $state(14);

  // ── AKS Logs functions ──
  async function loadAksLogs() {
    aksLoading = true;
    aksError = "";
    try {
      const res = await fetch(
        `/api/instances/${encodeURIComponent(tenantId)}/logs?container=${encodeURIComponent(aksContainer)}&tail=${aksTailLines}&since=${aksSinceSeconds}`
      );
      const data = await res.json();
      if (!res.ok) {
        aksError = data.error ?? `HTTP ${res.status}`;
        aksLogs = "";
      } else {
        aksLogs = data.logs ?? "";
        aksPodName = data.podName ?? "";
      }
    } catch (err) {
      aksError = err instanceof Error ? err.message : "Failed to fetch logs";
    } finally {
      aksLoading = false;
    }
  }

  function toggleAutoRefresh() {
    aksAutoRefresh = !aksAutoRefresh;
    if (aksAutoRefresh) {
      loadAksLogs();
      aksRefreshTimer = setInterval(loadAksLogs, 10_000);
    } else if (aksRefreshTimer) {
      clearInterval(aksRefreshTimer);
      aksRefreshTimer = null;
    }
  }

  // ── DSPM Activities functions ──
  async function loadDlpActivities() {
    dlpLoading = true;
    dlpError = "";
    try {
      const res = await fetch(
        `/api/instances/${encodeURIComponent(tenantId)}/dlp-activities?days=${dlpDays}`
      );
      const data = await res.json();
      if (data.error) dlpError = data.error;
      dlpActivities = data.activities ?? [];
    } catch (err) {
      dlpError = err instanceof Error ? err.message : "Failed to fetch DLP activities";
    } finally {
      dlpLoading = false;
    }
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  }

  function formatDur(ms: number): string {
    if (ms >= 60000) return (ms / 60000).toFixed(1) + "m";
    if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
    return ms.toFixed(0) + "ms";
  }

  function truncateResult(text: string, max = 120): string {
    if (!text || text.length <= max) return text;
    return text.slice(0, max) + "…";
  }

  // Load on tab switch
  function switchSubTab(tab: SubTab) {
    activeSubTab = tab;
    if (tab === "aks" && !aksLogs && !aksLoading) loadAksLogs();
    if (tab === "dspm" && !dlpActivities.length && !dlpLoading) loadDlpActivities();
  }

  // Load initial data
  $effect(() => {
    if (tenantId) loadAksLogs();
  });

  // Cleanup auto-refresh on destroy
  $effect(() => {
    return () => {
      if (aksRefreshTimer) clearInterval(aksRefreshTimer);
    };
  });
</script>

<div class="logging-panel">
  <!-- Sub-tabs -->
  <div class="sub-tabs">
    <button class="sub-tab" class:active={activeSubTab === "aks"} onclick={() => switchSubTab("aks")}>
      <span class="sub-tab-icon">📋</span> AKS Logs
    </button>
    <button class="sub-tab" class:active={activeSubTab === "dspm"} onclick={() => switchSubTab("dspm")}>
      <span class="sub-tab-icon">🛡️</span> Purview AI Activities (DSPM)
    </button>
  </div>

  <!-- ═══ AKS LOGS TAB ═══ -->
  {#if activeSubTab === "aks"}
    <div class="aks-panel">
      <div class="aks-toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">Container:</span>
          <select bind:value={aksContainer} onchange={loadAksLogs} class="toolbar-select">
            {#each containerOptions as c}
              <option value={c}>{c}</option>
            {/each}
          </select>
        </div>

        <div class="toolbar-group">
          <span class="toolbar-label">Since:</span>
          {#each sinceOptions as opt}
            <button
              class="since-btn" class:active={aksSinceSeconds === opt.value}
              onclick={() => { aksSinceSeconds = opt.value; loadAksLogs(); }}
            >{opt.label}</button>
          {/each}
        </div>

        <div class="toolbar-group">
          <span class="toolbar-label">Lines:</span>
          <input type="number" bind:value={aksTailLines} min="10" max="2000" class="lines-input" />
        </div>

        <div class="toolbar-actions">
          <button class="refresh-btn" onclick={loadAksLogs} disabled={aksLoading}>
            {aksLoading ? "Loading…" : "⟳ Refresh"}
          </button>
          <button class="auto-refresh-btn" class:active={aksAutoRefresh} onclick={toggleAutoRefresh}>
            {aksAutoRefresh ? "⏸ Stop" : "▶ Auto (10s)"}
          </button>
        </div>
      </div>

      {#if aksPodName}
        <div class="pod-info">Pod: <code>{aksPodName}</code></div>
      {/if}

      {#if aksError}
        <div class="log-error">{aksError}</div>
      {/if}

      <div class="log-viewer">
        <pre class="log-content">{aksLogs || (aksLoading ? "Loading…" : "No logs available")}</pre>
      </div>
    </div>
  {/if}

  <!-- ═══ DSPM ACTIVITIES TAB ═══ -->
  {#if activeSubTab === "dspm"}
    <div class="dspm-panel">
      <div class="dspm-toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">Time range:</span>
          {#each [1, 7, 14, 28] as d}
            <button
              class="since-btn" class:active={dlpDays === d}
              onclick={() => { dlpDays = d; loadDlpActivities(); }}
            >{d === 1 ? '24h' : `${d}d`}</button>
          {/each}
        </div>
        <div class="toolbar-actions">
          <button class="refresh-btn" onclick={loadDlpActivities} disabled={dlpLoading}>
            {dlpLoading ? "Loading…" : "⟳ Refresh"}
          </button>
        </div>
      </div>

      {#if dlpError}
        <div class="log-error">{dlpError}</div>
      {/if}

      {#if dlpLoading}
        <p class="loading-msg">Loading DLP activities…</p>
      {:else if dlpActivities.length === 0}
        <div class="empty-state">
          <div class="empty-icon">🛡️</div>
          <p>No DLP/Purview activity detected in the last {dlpDays === 1 ? '24 hours' : `${dlpDays} days`}</p>
          <p class="empty-hint">DLP events appear when the Purview DLP plugin intercepts or scans agent content.</p>
        </div>
      {:else}
        <div class="activities-summary">
          <span class="summary-count">{dlpActivities.length} event{dlpActivities.length !== 1 ? 's' : ''}</span>
          <span class="summary-blocked">{dlpActivities.filter(a => a.result.includes('redact') || a.result.includes('DLP')).length} blocked/redacted</span>
        </div>

        <div class="activities-table-wrap">
          <table class="activities-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Tool</th>
                <th>Result</th>
                <th>Duration</th>
                <th>Agent</th>
              </tr>
            </thead>
            <tbody>
              {#each dlpActivities as activity (activity.spanId)}
                <tr class:blocked={activity.result.includes('redact') || activity.result.includes('DLP')}>
                  <td class="col-time">{formatTime(activity.timestamp)}</td>
                  <td class="col-action">
                    <span class="action-badge" class:scan={activity.action === 'dlp_scan'} class:tool={activity.action === 'execute_tool'}>
                      {activity.action}
                    </span>
                  </td>
                  <td class="col-tool"><code>{activity.toolName}</code></td>
                  <td class="col-result" title={activity.result}>{truncateResult(activity.result)}</td>
                  <td class="col-dur">{formatDur(activity.durationMs)}</td>
                  <td class="col-agent">{activity.agentName}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .logging-panel {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* Sub-tabs */
  .sub-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 0.75rem;
  }

  .sub-tab {
    padding: 0.55rem 1rem;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 500;
    color: var(--color-text-muted);
    border-bottom: 2px solid transparent;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    transition: color 0.15s, border-color 0.15s;
  }

  .sub-tab:hover {
    color: var(--color-text);
    background: none;
  }

  .sub-tab.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
  }

  .sub-tab-icon {
    font-size: 0.9rem;
  }

  /* Shared toolbar */
  .aks-toolbar, .dspm-toolbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 0;
    flex-wrap: wrap;
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .toolbar-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .toolbar-select {
    font-size: 0.78rem;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-bg);
    color: var(--color-text);
  }

  .since-btn {
    font-size: 0.72rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-bg);
    color: var(--color-text-muted);
    cursor: pointer;
  }

  .since-btn:hover { background: var(--color-surface); }
  .since-btn.active {
    background: var(--color-primary);
    color: white;
    border-color: var(--color-primary);
  }

  .lines-input {
    width: 60px;
    font-size: 0.78rem;
    padding: 0.2rem 0.35rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-bg);
    color: var(--color-text);
  }

  .toolbar-actions {
    margin-left: auto;
    display: flex;
    gap: 0.4rem;
  }

  .refresh-btn {
    font-size: 0.75rem;
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-bg);
    cursor: pointer;
    color: var(--color-text);
  }

  .refresh-btn:hover { background: var(--color-surface); }
  .refresh-btn:disabled { opacity: 0.5; cursor: default; }

  .auto-refresh-btn {
    font-size: 0.72rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-bg);
    cursor: pointer;
    color: var(--color-text-muted);
  }

  .auto-refresh-btn.active {
    background: #107c1020;
    color: #107c10;
    border-color: #107c10;
  }

  /* Pod info */
  .pod-info {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    padding: 0.25rem 0;
  }

  .pod-info code {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    background: var(--color-bg);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.72rem;
  }

  /* Log viewer */
  .log-error {
    padding: 0.5rem 0.75rem;
    background: #dc354520;
    border: 1px solid #dc354540;
    border-radius: var(--radius);
    color: var(--color-danger);
    font-size: 0.78rem;
    margin: 0.5rem 0;
  }

  .log-viewer {
    flex: 1;
    overflow: auto;
    background: #1e1e1e;
    border-radius: var(--radius);
    border: 1px solid var(--color-border);
    max-height: 500px;
  }

  .log-content {
    margin: 0;
    padding: 0.75rem;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 0.72rem;
    line-height: 1.55;
    color: #d4d4d4;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* DSPM Panel */
  .loading-msg {
    color: var(--color-text-muted);
    font-size: 0.82rem;
    padding: 1rem 0;
  }

  .empty-state {
    text-align: center;
    padding: 2rem 1rem;
    color: var(--color-text-muted);
  }

  .empty-icon {
    font-size: 2rem;
    margin-bottom: 0.5rem;
  }

  .empty-state p {
    margin: 0.25rem 0;
    font-size: 0.82rem;
  }

  .empty-hint {
    font-size: 0.75rem !important;
    opacity: 0.7;
  }

  .activities-summary {
    display: flex;
    gap: 1rem;
    padding: 0.4rem 0;
    font-size: 0.78rem;
  }

  .summary-count {
    font-weight: 600;
    color: var(--color-text);
  }

  .summary-blocked {
    color: var(--color-danger);
    font-weight: 500;
  }

  /* Activities table */
  .activities-table-wrap {
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }

  .activities-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }

  .activities-table th {
    text-align: left;
    padding: 0.45rem 0.6rem;
    font-weight: 600;
    font-size: 0.72rem;
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .activities-table td {
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--color-border);
    vertical-align: top;
  }

  .activities-table tr:last-child td {
    border-bottom: none;
  }

  .activities-table tr:hover {
    background: var(--color-bg);
  }

  .activities-table tr.blocked {
    background: #dc354508;
  }

  .activities-table tr.blocked:hover {
    background: #dc354512;
  }

  .col-time {
    white-space: nowrap;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }

  .action-badge {
    display: inline-block;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    font-size: 0.68rem;
    font-weight: 600;
  }

  .action-badge.scan {
    background: #dc354520;
    color: #dc3545;
  }

  .action-badge.tool {
    background: #107c1020;
    color: #107c10;
  }

  .col-tool code {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 0.72rem;
  }

  .col-result {
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.72rem;
    color: var(--color-text);
  }

  .col-dur {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 0.7rem;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .col-agent {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
</style>
