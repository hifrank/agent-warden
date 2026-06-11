<script lang="ts">
  import type { InstanceRecord, TraceSpan, TelegramChannelConfig, InstanceConfigFiles, ActivityMetrics, DailyPoint } from "$lib/types";
  import TraceExplorer from "./TraceExplorer.svelte";
  import LoggingPanel from "./LoggingPanel.svelte";

  let {
    instance,
    onSuspend,
    onDelete,
    onRemove,
  }: {
    instance: InstanceRecord;
    onSuspend: (id: string) => void;
    onDelete: (id: string) => void;
    onRemove: (id: string) => void;
  } = $props();

  type TabId = "activity" | "dashboard" | "channels" | "configurations" | "logging";
  let activeTab = $state<TabId>("activity");

  // ── Activity tab state ──
  let metrics = $state<ActivityMetrics | null>(null);
  let metricsLoading = $state(false);
  let showTraceExplorer = $state(false);
  let activityDays = $state(1);
  const dayOptions = [1, 7, 14, 28];

  // ── Channels tab state ──
  let tgConfig = $state<TelegramChannelConfig | null>(null);
  let botTokenInput = $state("");
  let botUsernameInput = $state("");
  let showToken = $state(false);
  let pairingCode = $state("");
  let tgSaving = $state(false);
  let tgPairing = $state(false);
  let tgMessage = $state("");

  // ── Configurations tab state ──
  let configFiles = $state<InstanceConfigFiles | null>(null);
  let soulMdEdit = $state("");
  let openclawMdEdit = $state("");
  let configSaving = $state(false);
  let configMessage = $state("");
  let podConfig = $state<Record<string, unknown> | null>(null);
  let podConfigLoading = $state(false);
  let podConfigError = $state("");

  // ── DLP User ID state ──
  let dlpUserIdEdit = $state(instance.dlpConfig?.userId ?? "");
  let dlpUserIdSaving = $state(false);
  let dlpUserIdMessage = $state("");

  async function saveDlpUserId() {
    dlpUserIdSaving = true;
    dlpUserIdMessage = "";
    try {
      const res = await fetch(`/api/instances/${instance.tenantId}/dlp-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: dlpUserIdEdit || undefined }),
      });
      if (res.ok) {
        dlpUserIdMessage = "Saved";
        if (instance.dlpConfig) {
          instance.dlpConfig.userId = dlpUserIdEdit || undefined;
        } else {
          (instance as any).dlpConfig = { userId: dlpUserIdEdit || undefined, mode: "inherit" };
        }
      } else {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        dlpUserIdMessage = `Error: ${err.error}`;
      }
    } catch (err) {
      dlpUserIdMessage = `Error: ${err instanceof Error ? err.message : "Network error"}`;
    } finally {
      dlpUserIdSaving = false;
      setTimeout(() => (dlpUserIdMessage = ""), 4000);
    }
  }

  // ── Derived stats ──
  // (removed old traceStats)

  // ── Data fetching ──
  async function loadActivity() {
    metricsLoading = true;
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instance.tenantId)}/activity?days=${activityDays}`);
      if (res.ok) metrics = await res.json();
    } finally {
      metricsLoading = false;
    }
  }

  async function loadTelegram() {
    const res = await fetch(`/api/instances/${encodeURIComponent(instance.tenantId)}/telegram`);
    tgConfig = await res.json();
    botTokenInput = "";
    botUsernameInput = tgConfig?.botUsername ?? "";
    tgMessage = "";
  }

  async function loadConfig() {
    podConfigLoading = true;
    podConfigError = "";
    try {
      const [cfgRes, podRes] = await Promise.all([
        fetch(`/api/instances/${encodeURIComponent(instance.tenantId)}/config`),
        fetch(`/api/instances/${encodeURIComponent(instance.tenantId)}/pod-config`),
      ]);
      configFiles = await cfgRes.json();
      soulMdEdit = configFiles?.soulMd ?? "";
      openclawMdEdit = configFiles?.openclawMd ?? "";
      configMessage = "";
      if (podRes.ok) {
        podConfig = await podRes.json();
      } else {
        const err = await podRes.json().catch(() => ({}));
        podConfigError = (err as { error?: string }).error ?? "Failed to load pod config";
        podConfig = null;
      }
    } catch (e) {
      podConfigError = e instanceof Error ? e.message : "Failed to load config";
    } finally {
      podConfigLoading = false;
    }
  }

  async function saveTelegram() {
    if (!botTokenInput) return;
    tgSaving = true;
    tgMessage = "";
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instance.tenantId)}/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botTokenInput, botUsername: botUsernameInput }),
      });
      if (res.ok) {
        tgMessage = "Telegram bot token saved. Syncing to pod…";
        await loadTelegram();
        // Sync config to pod and send SIGUSR1 for hot-reload
        const syncRes = await fetch(`/api/instances/${encodeURIComponent(instance.tenantId)}/sync-config`, {
          method: "POST",
        });
        if (syncRes.ok) {
          tgMessage = "Telegram bot token saved and synced to pod";
        } else {
          tgMessage = "Token saved but pod sync failed — config will apply on next restart";
        }
      } else {
        const err = await res.json();
        tgMessage = err.error ?? "Save failed";
      }
    } finally {
      tgSaving = false;
    }
  }

  async function approvePairing() {
    if (!pairingCode || pairingCode.length < 4) return;
    tgPairing = true;
    tgMessage = "";
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instance.tenantId)}/telegram/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairingCode }),
      });
      const data = await res.json();
      if (res.ok) {
        tgMessage = data.message;
        pairingCode = "";
        await loadTelegram();
      } else {
        tgMessage = data.error ?? "Pairing failed";
      }
    } finally {
      tgPairing = false;
    }
  }

  async function saveConfig() {
    configSaving = true;
    configMessage = "";
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instance.tenantId)}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soulMd: soulMdEdit, openclawMd: openclawMdEdit }),
      });
      if (res.ok) {
        configMessage = "Configuration saved";
        configFiles = await res.json();
      }
    } finally {
      configSaving = false;
    }
  }

  // ── Tab activation triggers data load ──
  function switchTab(tab: TabId) {
    activeTab = tab;
    if (tab === "activity") loadActivity();
    if (tab === "channels") loadTelegram();
    if (tab === "configurations") loadConfig();
  }

  // Load on tenant change only
  let lastLoadedTenant = $state("");
  $effect(() => {
    const tid = instance.tenantId;
    if (tid !== lastLoadedTenant) {
      lastLoadedTenant = tid;
      if (activeTab === "activity") loadActivity();
      else if (activeTab === "channels") loadTelegram();
      else if (activeTab === "configurations") loadConfig();
    }
  });

  // ── SVG sparkline helper ──
  function sparklinePath(values: number[], w = 120, h = 28): string {
    if (!values.length) return "";
    const max = Math.max(...values, 1);
    const step = w / (values.length - 1 || 1);
    return values.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  }

  function barChartPath(points: DailyPoint[], w = 280, h = 80): { rects: { x: number; y: number; w: number; h: number }[] } {
    if (!points.length) return { rects: [] };
    const max = Math.max(...points.map((p) => p.value), 1);
    const barW = w / points.length * 0.7;
    const gap = w / points.length;
    return {
      rects: points.map((p, i) => ({
        x: i * gap + (gap - barW) / 2,
        y: h - (p.value / max) * h,
        w: barW,
        h: (p.value / max) * h,
      })),
    };
  }

  function formatNum(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + " M";
    if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + " K";
    return n.toString();
  }

  function formatDuration(ms: number): string {
    if (ms >= 60000) return (ms / 60000).toFixed(1) + " m";
    if (ms >= 1000) return (ms / 1000).toFixed(2) + " s";
    return ms + " ms";
  }
</script>

<div class="detail">
  <!-- Header -->
  <div class="detail-header">
    <div class="detail-title">
      <h2>{instance.tenantId}</h2>
      <span class="badge {instance.state.toLowerCase()}">{instance.state}</span>
      <span class="badge {instance.tier}">{instance.tier}</span>
      {#if instance.healthStatus}
        <span class="badge {instance.healthStatus.toLowerCase()}">{instance.healthStatus}</span>
      {/if}
    </div>
    <div class="detail-actions">
      {#if instance.state === "Active"}
        <button class="danger" onclick={() => onSuspend(instance.tenantId)}>Suspend</button>
      {/if}
      {#if instance.state !== "Deleted" && instance.state !== "Deleting"}
        <button class="danger" onclick={() => onDelete(instance.tenantId)}>Delete</button>
      {/if}
      {#if instance.state === "Deleted"}
        <button class="danger" onclick={() => onRemove(instance.tenantId)}>Remove Record</button>
      {/if}
    </div>
  </div>

  <!-- Info Grid -->
  <div class="info-grid">
    <div class="info-item">
      <span class="label">Version</span>
      <span class="value">v{instance.version}</span>
    </div>
    <div class="info-item">
      <span class="label">Region</span>
      <span class="value">{instance.region}</span>
    </div>
    <div class="info-item">
      <span class="label">Owner</span>
      <span class="value">{instance.ownerIdentity}</span>
    </div>
    <div class="info-item">
      <span class="label">Created</span>
      <span class="value">{new Date(instance.createdAt).toLocaleDateString()}</span>
    </div>
    <div class="info-item">
      <span class="label">Pods</span>
      <span class="value">{instance.podCount}</span>
    </div>
    <div class="info-item">
      <span class="label">Skills</span>
      <span class="value">{instance.skillCount}</span>
    </div>
    {#if instance.dlpAppRegistration}
      <div class="info-item">
        <span class="label">DLP App ID</span>
        <span class="value mono">{instance.dlpAppRegistration.e5TenantId}/{instance.dlpAppRegistration.appId}</span>
      </div>
    {/if}
    <div class="info-item" style="grid-column: 1 / -1;">
      <span class="label">DLP User ID</span>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex: 1;">
        <input type="text" bind:value={dlpUserIdEdit} placeholder="E5-licensed user Object ID" style="flex: 1; font-family: monospace; font-size: 0.85rem;" />
        <button class="compact-btn" onclick={saveDlpUserId} disabled={dlpUserIdSaving}>
          {dlpUserIdSaving ? "…" : "Save"}
        </button>
        {#if dlpUserIdMessage}
          <span class="save-msg" class:error={dlpUserIdMessage.startsWith("Error")}>{dlpUserIdMessage}</span>
        {/if}
      </div>
    </div>
  </div>

  <!-- Provisioning Progress Banner -->
  {#if instance.state === "Provisioning"}
    <div class="provisioning-banner">
      <div class="progress-header">
        <div class="spinner"></div>
        <span>Provisioning in progress{instance.provisioningStepLabel ? ` — ${instance.provisioningStepLabel}` : ''}…</span>
        {#if instance.provisioningStep && instance.provisioningTotalSteps}
          <span class="step-counter">Step {instance.provisioningStep} of {instance.provisioningTotalSteps}</span>
        {/if}
      </div>
      {#if instance.provisioningStep && instance.provisioningTotalSteps}
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: {(instance.provisioningStep / instance.provisioningTotalSteps) * 100}%"></div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Deleting Progress Banner -->
  {#if instance.state === "Deleting"}
    <div class="deleting-banner">
      <div class="progress-header">
        <div class="spinner deleting-spinner"></div>
        <span>Deletion in progress{instance.provisioningStepLabel ? ` — ${instance.provisioningStepLabel}` : ''}…</span>
        {#if instance.provisioningStep && instance.provisioningTotalSteps}
          <span class="step-counter">Step {instance.provisioningStep} of {instance.provisioningTotalSteps}</span>
        {/if}
      </div>
      {#if instance.provisioningStep && instance.provisioningTotalSteps}
        <div class="progress-bar-track">
          <div class="progress-bar-fill deleting-fill" style="width: {(instance.provisioningStep / instance.provisioningTotalSteps) * 100}%"></div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Deleted Banner -->
  {#if instance.state === "Deleted"}
    <div class="deleted-banner">
      <span>This instance has been deleted. All resources have been cleaned up.</span>
      <button class="remove-record-btn" onclick={() => onRemove(instance.tenantId)}>Remove Record</button>
    </div>
  {/if}

  <!-- Provisioning Error Banner -->
  {#if instance.provisioningError}
    <div class="error-banner">
      <strong>Provisioning failed:</strong> {instance.provisioningError}
    </div>
  {/if}

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab" class:active={activeTab === "activity"} onclick={() => switchTab("activity")}>Activity</button>
    <button class="tab" class:active={activeTab === "dashboard"} onclick={() => switchTab("dashboard")}>Dashboard</button>
    <button class="tab" class:active={activeTab === "channels"} onclick={() => switchTab("channels")}>Channels</button>
    <button class="tab" class:active={activeTab === "configurations"} onclick={() => switchTab("configurations")}>Configurations</button>
    <button class="tab" class:active={activeTab === "logging"} onclick={() => switchTab("logging")}>Logging</button>
  </div>

  <!-- Tab Content -->
  <div class="tab-content">

    <!-- ══════ ACTIVITY TAB ══════ -->
    {#if activeTab === "activity"}
      <div class="activity-panel">
        <div class="activity-toolbar">
          <div class="time-range-selector">
            <span class="range-label">Time range:</span>
            {#each dayOptions as d}
              <button
                class="range-btn" class:active={activityDays === d}
                onclick={() => { activityDays = d; loadActivity(); }}
              >{d === 1 ? '24h' : `${d}d`}</button>
            {/each}
          </div>
        </div>
        {#if metricsLoading}
          <p class="loading">Loading activity metrics…</p>
        {:else if !metrics}
          <p class="empty-msg">No activity data available</p>
        {:else}
          <!-- Section: Agent Operational Metrics -->
          <h3 class="section-header">Agent Operational Metrics</h3>

          <!-- Row 1: Agent Runs + Gen AI Errors -->
          <div class="metrics-grid two-col">
            <!-- Agent Runs Card -->
            <div class="metric-card">
              <div class="card-header">
                <span class="card-title">Agent Runs</span>
                <span class="card-badge">{metrics.agentRuns?.agentName ?? 'N/A'}</span>
              </div>
              <div class="card-chart-area">
                <svg class="line-chart" viewBox="0 0 280 80" preserveAspectRatio="none">
                  <path
                    d={sparklinePath((metrics.agentRuns?.daily ?? []).map(d => d.value), 280, 80)}
                    fill="none" stroke="var(--color-primary)" stroke-width="2"
                  />
                </svg>
              </div>
              <div class="card-metric-row">
                <span class="big-number">{formatNum(metrics.agentRuns?.total ?? 0)}</span>
                <span class="metric-label">Total Agent Runs (28d)</span>
              </div>
              <button class="card-link-btn" onclick={() => (showTraceExplorer = true)}>View Traces with Agent Runs</button>
            </div>

            <!-- Gen AI Errors Card -->
            <div class="metric-card">
              <div class="card-header">
                <span class="card-title">Gen AI Errors</span>
              </div>
              <div class="card-status-area">
                {#if metrics.genAiErrors?.hasErrors}
                  <div class="error-indicator">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="var(--color-danger)" stroke-width="2"/>
                      <path d="M12 8v4m0 4h.01" stroke="var(--color-danger)" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                    <span class="error-count">{metrics.genAiErrors.total} errors</span>
                  </div>
                {:else}
                  <div class="no-error-indicator">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="var(--color-success)" stroke-width="2"/>
                      <path d="M8 12l3 3 5-5" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="no-error-text">No traces with Gen AI Errors</span>
                  </div>
                {/if}
              </div>
              <button class="card-link-btn" onclick={() => (showTraceExplorer = true)}>View Traces with Gen AI Errors</button>
            </div>
          </div>

          <!-- Row 2: Tool Calls + Models -->
          <div class="metrics-grid two-col">
            <!-- Tool Calls Table -->
            <div class="metric-card">
              <div class="card-header">
                <span class="card-title">Tool Calls</span>
              </div>
              <table class="metrics-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Errors</th>
                    <th>Avg. Duration</th>
                    <th class="num-col">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {#each (metrics.toolCalls ?? []) as tool (tool.name)}
                    <tr>
                      <td class="name-cell">{tool.name}</td>
                      <td>
                        {#if tool.errors > 0}
                          <div class="error-bar-container">
                            <div class="error-bar" style="width: {Math.min(tool.errors / Math.max(...(metrics.toolCalls ?? []).map(t => t.errors || 1)) * 100, 100)}%"></div>
                            <span class="error-bar-label">{tool.errors}</span>
                          </div>
                        {:else}
                          <span class="no-errors-dash">—</span>
                        {/if}
                      </td>
                      <td>
                        <div class="sparkline-cell">
                          <svg class="sparkline" viewBox="0 0 120 28" preserveAspectRatio="none">
                            <path d={sparklinePath(tool.dailyCalls, 120, 28)} fill="none" stroke="var(--color-primary)" stroke-width="1.5"/>
                          </svg>
                          <span class="spark-val">{formatDuration(tool.avgDurationMs)}</span>
                        </div>
                      </td>
                      <td class="num-col mono">{formatNum(tool.calls)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <!-- Models Table -->
            <div class="metric-card">
              <div class="card-header">
                <span class="card-title">Models</span>
              </div>
              <table class="metrics-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Errors</th>
                    <th>Avg. Duration</th>
                    <th class="num-col">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {#each (metrics.models ?? []) as model (model.name)}
                    <tr>
                      <td class="name-cell">{model.name}</td>
                      <td>
                        {#if model.errors > 0}
                          <div class="error-bar-container">
                            <div class="error-bar" style="width: {Math.min(model.errors / Math.max(...(metrics.models ?? []).map(m => m.errors || 1)) * 100, 100)}%"></div>
                            <span class="error-bar-label">{model.errors}</span>
                          </div>
                        {:else}
                          <span class="no-errors-dash">—</span>
                        {/if}
                      </td>
                      <td>
                        <div class="sparkline-cell">
                          <svg class="sparkline" viewBox="0 0 120 28" preserveAspectRatio="none">
                            <path d={sparklinePath(model.dailyCalls, 120, 28)} fill="none" stroke="#6f42c1" stroke-width="1.5"/>
                          </svg>
                          <span class="spark-val">{formatDuration(model.avgDurationMs)}</span>
                        </div>
                      </td>
                      <td class="num-col mono">{formatNum(model.calls)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Section: Token Consumption -->
          <h3 class="section-header">Token Consumption</h3>

          <div class="metrics-grid two-col">
            <!-- Token Consumption by Model -->
            <div class="metric-card">
              <div class="card-header">
                <span class="card-title">Token Consumption by Model</span>
              </div>
              <div class="card-chart-area">
                <svg class="bar-chart" viewBox="0 0 280 80" preserveAspectRatio="none">
                  {#each barChartPath(metrics.tokenConsumption?.dailyInput ?? [], 280, 80).rects as r, i}
                    <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="var(--color-primary)" opacity="0.7" rx="1"/>
                  {/each}
                </svg>
              </div>
              <div class="model-totals">
                {#each (metrics.tokenConsumption?.byModel ?? []) as m}
                  <div class="model-total-row">
                    <span class="model-dot" style="background: {m.model.includes('4o') ? '#e36209' : m.model.includes('5.4') ? 'var(--color-primary)' : '#6f42c1'}"></span>
                    <span class="model-name">{m.model}</span>
                    <span class="model-val mono">{formatNum(m.total)}</span>
                  </div>
                {/each}
              </div>
            </div>

            <!-- Input vs Output Tokens -->
            <div class="metric-card">
              <div class="card-header">
                <span class="card-title">Input vs Output Tokens</span>
              </div>
              <div class="card-chart-area">
                <svg class="line-chart" viewBox="0 0 280 80" preserveAspectRatio="none">
                  <path
                    d={sparklinePath((metrics.tokenConsumption?.dailyInput ?? []).map(d => d.value), 280, 80)}
                    fill="none" stroke="var(--color-primary)" stroke-width="2"
                  />
                  <path
                    d={sparklinePath((metrics.tokenConsumption?.dailyOutput ?? []).map(d => d.value), 280, 80)}
                    fill="none" stroke="#e36209" stroke-width="2"
                  />
                </svg>
              </div>
              <div class="token-totals">
                <div class="token-total">
                  <span class="token-dot" style="background: var(--color-primary)"></span>
                  <span class="token-label">Input Tokens</span>
                  <span class="token-val mono">{formatNum(metrics.tokenConsumption?.inputTokensTotal ?? 0)}</span>
                </div>
                <div class="token-total">
                  <span class="token-dot" style="background: #e36209"></span>
                  <span class="token-label">Output Tokens</span>
                  <span class="token-val mono">{formatNum(metrics.tokenConsumption?.outputTokensTotal ?? 0)}</span>
                </div>
              </div>
            </div>
          </div>
        {/if}
        <div class="powered-by">Powered by <a href="https://learn.microsoft.com/en-us/azure/azure-monitor/app/agents-view" target="_blank" rel="noopener noreferrer">Application Insights</a></div>
      </div>

    <!-- ══════ DASHBOARD TAB ══════ -->
    {:else if activeTab === "dashboard"}
      <div class="dashboard-panel">
        <div class="dashboard-card">
          <div class="dashboard-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18"/><path d="M9 21V9"/>
            </svg>
          </div>
          <h3>OpenClaw Dashboard</h3>
          <p>Access the OpenClaw Gateway Control UI to manage your agent instance, view live conversations, approve exec requests, and configure settings.</p>
          <a href="https://docs.openclaw.ai/web/dashboard" target="_blank" rel="noopener noreferrer" class="dashboard-btn">
            Open OpenClaw Dashboard →
          </a>
          <div class="dashboard-hint">
            <strong>Local access:</strong> <code>http://127.0.0.1:18789/</code><br/>
            <strong>Quick open:</strong> Run <code>openclaw dashboard</code> to get an authenticated URL.<br/>
            <strong>Auth:</strong> Paste your <code>gateway.auth.token</code> or password in the Control UI settings.
          </div>
        </div>
      </div>

    <!-- ══════ CHANNELS TAB (Telegram) ══════ -->
    {:else if activeTab === "channels"}
      <div class="channels-panel">
        <div class="channel-header">
          <span class="channel-icon">✈️</span>
          <h3>Telegram</h3>
          {#if tgConfig}
            <span class="badge {tgConfig.pairingStatus}">{tgConfig.pairingStatus}</span>
          {/if}
        </div>

        {#if tgMessage}
          <div class="tg-message">{tgMessage}</div>
        {/if}

        <!-- Bot Token Section -->
        <div class="tg-section">
          <h4>Bot Configuration</h4>
          <p class="hint">Get your bot token from <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a> on Telegram.</p>
          <div class="field-row">
            <div class="field">
              <label for="botToken">Bot Token</label>
              <div class="token-input">
                {#if showToken}
                  <input id="botToken" type="text" bind:value={botTokenInput} placeholder={tgConfig?.botToken || "123:abc..."} />
                {:else}
                  <input id="botToken" type="password" bind:value={botTokenInput} placeholder={tgConfig?.botToken || "••••••••••"} />
                {/if}
                <button class="toggle-btn" onclick={() => (showToken = !showToken)}>
                  {showToken ? "🙈" : "👁️"}
                </button>
              </div>
            </div>
            <div class="field">
              <label for="botUsername">Bot Username</label>
              <input id="botUsername" type="text" bind:value={botUsernameInput} placeholder="my_agent_bot" />
            </div>
          </div>
          <button class="primary" onclick={saveTelegram} disabled={tgSaving || !botTokenInput}>
            {tgSaving ? "Saving…" : "Save Bot Config"}
          </button>
        </div>

        <!-- Pairing Section -->
        <div class="tg-section">
          <h4>DM Pairing Approval</h4>
          <p class="hint">
            When <code>dmPolicy: "pairing"</code> is set, unknown senders receive an 8-character pairing code.
            Enter the code below to approve access. Codes expire after 1 hour.
          </p>
          {#if tgConfig?.pairedAt}
            <p class="paired-info">Last paired: {new Date(tgConfig.pairedAt).toLocaleString()}</p>
          {/if}
          <div class="pair-row">
            <input
              type="text"
              bind:value={pairingCode}
              placeholder="e.g. ABCD1234"
              maxlength="8"
              class="pair-input"
            />
            <button class="primary" onclick={approvePairing} disabled={tgPairing || pairingCode.length < 4}>
              {tgPairing ? "Approving…" : "Approve"}
            </button>
          </div>
          <p class="hint">Equivalent to: <code>openclaw pairing approve telegram {pairingCode || "<CODE>"}</code></p>
        </div>
      </div>

    <!-- ══════ CONFIGURATIONS TAB ══════ -->
    {:else if activeTab === "configurations"}
      <div class="config-panel">
        {#if configMessage}
          <div class="tg-message">{configMessage}</div>
        {/if}

        <!-- Live Pod Config (read-only) -->
        <div class="config-section">
          <h4>Pod Configuration <span class="hint">(openclaw.json — live from pod, read-only)</span></h4>
          {#if podConfigLoading}
            <p class="hint">Loading pod config…</p>
          {:else if podConfigError}
            <p class="hint" style="color: var(--color-error, #e74c3c);">{podConfigError}</p>
          {:else if podConfig}
            <pre class="config-viewer">{JSON.stringify(podConfig, null, 2)}</pre>
          {:else}
            <p class="hint">No pod config available</p>
          {/if}
        </div>

        <div class="config-section">
          <h4>SOUL.md</h4>
          <p class="hint">Agent personality, identity, boundaries, and operating instructions.</p>
          <textarea class="config-editor" bind:value={soulMdEdit} rows="12" spellcheck="false"></textarea>
        </div>

        <div class="config-section">
          <h4>openclaw.md</h4>
          <p class="hint">Gateway configuration, channel settings, skill bindings, and security policies.</p>
          <textarea class="config-editor" bind:value={openclawMdEdit} rows="12" spellcheck="false"></textarea>
        </div>

        <button class="primary" onclick={saveConfig} disabled={configSaving}>
          {configSaving ? "Saving…" : "Save Configurations"}
        </button>
      </div>
    {:else if activeTab === "logging"}
      <LoggingPanel tenantId={instance.tenantId} />
    {/if}
  </div>
</div>

{#if showTraceExplorer}
  <TraceExplorer tenantId={instance.tenantId} onClose={() => (showTraceExplorer = false)} />
{/if}

<style>
  .activity-toolbar {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .time-range-selector {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .range-label {
    font-size: 0.8rem;
    color: var(--color-text-secondary, #888);
    margin-right: 0.25rem;
  }
  .range-btn {
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius, 4px);
    background: transparent;
    color: var(--color-text, #ccc);
    cursor: pointer;
  }
  .range-btn:hover { background: var(--color-hover, #333); }
  .range-btn.active {
    background: var(--color-primary, #0078d4);
    color: #fff;
    border-color: var(--color-primary, #0078d4);
  }
  .powered-by {
    text-align: center;
    font-size: 0.75rem;
    color: var(--color-text-secondary, #888);
    padding: 1rem 0 0.5rem;
    opacity: 0.7;
  }
  .powered-by a {
    color: var(--color-primary, #0078d4);
    text-decoration: none;
  }
  .powered-by a:hover {
    text-decoration: underline;
  }

  .provisioning-banner {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    background: var(--color-info-bg, #0c3b5e);
    border-left: 3px solid var(--color-primary, #0078d4);
    color: #ffffff;
    font-size: 0.85rem;
  }
  .progress-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .step-counter {
    margin-left: auto;
    font-size: 0.75rem;
    opacity: 0.8;
    white-space: nowrap;
  }
  .progress-bar-track {
    width: 100%;
    height: 4px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%;
    background: var(--color-primary, #0078d4);
    border-radius: 2px;
    transition: width 0.5s ease;
  }
  .deleting-banner {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    background: #4a1c00;
    border-left: 3px solid #ef6c00;
    color: #ffffff;
    font-size: 0.85rem;
  }
  .deleting-spinner {
    border-top-color: #ef6c00 !important;
  }
  .deleting-fill {
    background: #ef6c00;
  }
  .deleted-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    background: #2a2a2a;
    border-left: 3px solid #999;
    color: #ccc;
    font-size: 0.85rem;
  }
  .remove-record-btn {
    padding: 0.3rem 0.75rem;
    font-size: 0.8rem;
    border: 1px solid var(--color-danger, #dc2626);
    border-radius: var(--radius, 4px);
    background: transparent;
    color: var(--color-danger, #dc2626);
    cursor: pointer;
    white-space: nowrap;
  }
  .remove-record-btn:hover {
    background: var(--color-danger, #dc2626);
    color: #fff;
  }
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--color-border, #444);
    border-top-color: var(--color-primary, #0078d4);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .error-banner {
    padding: 0.75rem 1.25rem;
    background: #fef2f2;
    border-left: 3px solid #dc2626;
    color: #7f1d1d;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .error-banner strong {
    color: #dc2626;
  }

  .detail {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--color-border);
  }

  .detail-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .detail-title h2 {
    font-size: 1.2rem;
    font-weight: 700;
  }

  .detail-actions {
    display: flex;
    gap: 0.5rem;
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
    border-bottom: 1px solid var(--color-border);
  }

  .info-item {
    padding: 0.75rem 1.25rem;
    border-right: 1px solid var(--color-border);
    border-bottom: 1px solid var(--color-border);
  }

  .info-item:nth-child(3n) {
    border-right: none;
  }

  .info-item:nth-child(n+4) {
    border-bottom: 1px solid var(--color-border);
  }

  .info-item:last-child {
    border-bottom: none;
  }

  .info-grid .info-item:nth-last-child(-n+3):nth-child(3n+1),
  .info-grid .info-item:nth-last-child(-n+3):nth-child(3n+1) ~ .info-item {
    border-bottom: none;
  }

  .label {
    display: block;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    margin-bottom: 0.15rem;
  }

  .value {
    font-size: 0.9rem;
    font-weight: 600;
  }

  .value.mono {
    font-family: monospace;
    font-size: 0.8rem;
    word-break: break-all;
  }

  .tabs {
    display: flex;
    border-bottom: 1px solid var(--color-border);
    padding: 0 1rem;
  }

  .tab {
    padding: 0.65rem 1rem;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--color-text-muted);
    font-weight: 500;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }

  .tab:hover {
    color: var(--color-text);
    background: transparent;
  }

  .tab.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
  }

  .tab-content {
    padding: 1.25rem;
    min-height: 200px;
  }

  /* ── Activity tab (Azure Monitor style) ── */
  .section-header {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-text);
    margin: 0.75rem 0 0.5rem;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--color-border);
  }

  .section-header:first-child {
    margin-top: 0;
  }

  .metrics-grid {
    display: grid;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .metrics-grid.two-col {
    grid-template-columns: 1fr 1fr;
  }

  .metric-card {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .card-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--color-text);
  }

  .card-badge {
    font-size: 0.68rem;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    background: var(--color-primary);
    color: white;
    font-weight: 500;
  }

  .card-chart-area {
    height: 80px;
    margin-bottom: 0.5rem;
    overflow: hidden;
  }

  .line-chart, .bar-chart {
    width: 100%;
    height: 100%;
  }

  .card-metric-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .big-number {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1;
    color: var(--color-text);
  }

  .metric-label {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }

  .card-link-btn {
    background: none;
    border: none;
    color: var(--color-primary);
    font-size: 0.75rem;
    font-weight: 500;
    padding: 0.35rem 0;
    text-align: left;
    cursor: pointer;
  }

  .card-link-btn:hover {
    text-decoration: underline;
    background: none;
  }

  /* Gen AI Errors status */
  .card-status-area {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100px;
  }

  .no-error-indicator, .error-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .no-error-text {
    font-size: 0.8rem;
    color: var(--color-text-muted);
  }

  .error-count {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-danger);
  }

  /* Metrics tables (Tool Calls / Models) */
  .metrics-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
  }

  .metrics-table th {
    text-align: left;
    padding: 0.4rem 0.5rem;
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
  }

  .metrics-table td {
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    vertical-align: middle;
  }

  .metrics-table tr:last-child td {
    border-bottom: none;
  }

  .name-cell {
    font-weight: 500;
    color: var(--color-text);
  }

  .num-col {
    text-align: right;
  }

  /* Error bar mini-visualization */
  .error-bar-container {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .error-bar {
    height: 6px;
    background: var(--color-danger);
    border-radius: 3px;
    min-width: 6px;
    max-width: 60px;
  }

  .error-bar-label {
    font-size: 0.72rem;
    color: var(--color-danger);
    font-weight: 600;
  }

  .no-errors-dash {
    color: var(--color-text-muted);
  }

  /* Sparkline cell */
  .sparkline-cell {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .sparkline {
    width: 60px;
    height: 20px;
    flex-shrink: 0;
  }

  .spark-val {
    font-size: 0.72rem;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  /* Token consumption */
  .model-totals {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .model-total-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
  }

  .model-dot, .token-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .model-name {
    flex: 1;
    color: var(--color-text-muted);
  }

  .model-val {
    font-weight: 600;
    font-size: 0.78rem;
  }

  .token-totals {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .token-total {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
  }

  .token-label {
    flex: 1;
    color: var(--color-text-muted);
  }

  .token-val {
    font-weight: 600;
    font-size: 0.78rem;
  }

  .mono {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 0.78rem;
  }

  .loading, .empty-msg {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-muted);
  }

  /* ── Dashboard tab ── */
  .dashboard-panel {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 280px;
  }

  .dashboard-card {
    text-align: center;
    max-width: 480px;
  }

  .dashboard-icon {
    color: var(--color-primary);
    margin-bottom: 1rem;
  }

  .dashboard-card h3 {
    font-size: 1.2rem;
    margin-bottom: 0.5rem;
  }

  .dashboard-card p {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin-bottom: 1.25rem;
    line-height: 1.6;
  }

  .dashboard-btn {
    display: inline-block;
    padding: 0.65rem 1.5rem;
    background: var(--color-primary);
    color: white;
    text-decoration: none;
    border-radius: var(--radius);
    font-weight: 600;
    font-size: 0.9rem;
    transition: background 0.15s;
  }

  .dashboard-btn:hover {
    background: var(--color-primary-hover);
  }

  .dashboard-hint {
    margin-top: 1.5rem;
    text-align: left;
    background: var(--color-bg);
    padding: 0.85rem 1rem;
    border-radius: var(--radius);
    font-size: 0.8rem;
    color: var(--color-text-muted);
    line-height: 1.7;
  }

  .dashboard-hint code {
    background: var(--color-surface);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.78rem;
    border: 1px solid var(--color-border);
  }

  /* ── Channels tab (Telegram) ── */
  .channels-panel {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .channel-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .channel-header h3 {
    font-size: 1.1rem;
    flex: 1;
  }

  .channel-icon {
    font-size: 1.3rem;
  }

  .tg-section {
    background: var(--color-bg);
    padding: 1rem 1.25rem;
    border-radius: var(--radius);
  }

  .tg-section h4 {
    font-size: 0.9rem;
    margin-bottom: 0.35rem;
  }

  .hint {
    font-size: 0.78rem;
    color: var(--color-text-muted);
    margin-bottom: 0.75rem;
  }

  .hint code {
    background: var(--color-surface);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.75rem;
    border: 1px solid var(--color-border);
  }

  .hint a {
    color: var(--color-primary);
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .field label {
    display: block;
    font-size: 0.78rem;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .field input {
    width: 100%;
  }

  .token-input {
    display: flex;
    gap: 0;
  }

  .token-input input {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .toggle-btn {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: none;
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    line-height: 1;
  }

  .pair-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .pair-input {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    width: 160px;
  }

  .paired-info {
    font-size: 0.78rem;
    color: var(--color-success);
    margin-bottom: 0.5rem;
  }

  .tg-message {
    padding: 0.5rem 0.75rem;
    background: #ddf4ff;
    border-radius: var(--radius);
    font-size: 0.8rem;
    color: var(--color-primary);
  }

  .badge.pending { background: #fff8c5; color: var(--color-warning); }
  .badge.approved { background: #dafbe1; color: var(--color-success); }
  .badge.rejected { background: #ffebe9; color: var(--color-danger); }

  /* ── Configurations tab ── */
  .config-panel {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .config-section {
    background: var(--color-bg);
    padding: 1rem 1.25rem;
    border-radius: var(--radius);
  }

  .config-section h4 {
    font-size: 0.9rem;
    margin-bottom: 0.25rem;
  }

  .config-editor {
    width: 100%;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 0.8rem;
    line-height: 1.5;
    padding: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface);
    color: var(--color-text);
    resize: vertical;
    tab-size: 2;
  }

  .config-editor:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .config-viewer {
    width: 100%;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 0.75rem;
    line-height: 1.5;
    padding: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface);
    color: var(--color-text);
    overflow-x: auto;
    max-height: 500px;
    overflow-y: auto;
    white-space: pre;
    margin: 0;
  }
</style>
