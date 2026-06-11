<script lang="ts">
  import type { InstanceRecord, CreateInstanceInput } from "$lib/types";
  import InstanceDetail from "$lib/components/InstanceDetail.svelte";
  import CreateInstanceDialog from "$lib/components/CreateInstanceDialog.svelte";

  let { data } = $props();

  let instances = $state(data.instances);
  let selectedId = $state<string | null>(null);
  let showCreate = $state(false);
  let provisioningIds = $state<Set<string>>(new Set());
  let deletingIds = $state<Set<string>>(new Set());
  let pollTimer = $state<ReturnType<typeof setInterval> | null>(null);

  let selected = $derived(instances.find((i) => i.tenantId === selectedId) ?? null);

  const inactiveStates = new Set(["Deleting", "Deleted"]);
  let liveInstances = $derived(instances.filter((i) => !inactiveStates.has(i.state)));
  let inactiveInstances = $derived(instances.filter((i) => inactiveStates.has(i.state)));

  async function refresh() {
    const res = await fetch("/api/instances");
    instances = await res.json();
  }

  function startPolling(tenantId: string, kind: "provisioning" | "deleting") {
    if (kind === "provisioning") provisioningIds.add(tenantId);
    else deletingIds.add(tenantId);
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      await refresh();
      // Remove provisioning IDs that are no longer Provisioning
      for (const id of [...provisioningIds]) {
        const inst = instances.find((i) => i.tenantId === id);
        if (inst && inst.state !== "Provisioning") provisioningIds.delete(id);
      }
      // Remove deleting IDs that are no longer Deleting
      for (const id of [...deletingIds]) {
        const inst = instances.find((i) => i.tenantId === id);
        if (inst && inst.state !== "Deleting") deletingIds.delete(id);
      }
      if (provisioningIds.size === 0 && deletingIds.size === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 5000);
  }

  async function handleCreate(input: CreateInstanceInput) {
    const res = await fetch("/api/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      showCreate = false;
      selectedId = input.tenantId;
      // Start polling for provisioning status
      startPolling(input.tenantId, "provisioning");
      // Give server a moment to create the Cosmos record, then refresh
      setTimeout(refresh, 2000);
    }
  }

  async function handleSuspend(tenantId: string) {
    await fetch(`/api/instances/${encodeURIComponent(tenantId)}/suspend`, { method: "POST" });
    await refresh();
  }

  async function handleDelete(tenantId: string) {
    await fetch(`/api/instances/${encodeURIComponent(tenantId)}`, { method: "DELETE" });
    // Instance moves to Deleting — start polling
    startPolling(tenantId, "deleting");
    await refresh();
  }

  async function handleRemove(tenantId: string) {
    const res = await fetch(`/api/instances/${encodeURIComponent(tenantId)}/remove`, { method: "DELETE" });
    if (res.ok) {
      if (selectedId === tenantId) selectedId = null;
      await refresh();
    }
  }
</script>

<div class="page-header">
  <h1>OpenClaw Instance Management</h1>
  <button class="primary" onclick={() => (showCreate = true)}>+ Create Instance</button>
</div>

<div class="layout">
  <!-- Left: Instance List -->
  <aside class="instance-list">
    <div class="list-header">
      <span class="list-count">{liveInstances.length} Live instances</span>
    </div>
    {#each liveInstances as inst (inst.tenantId)}
      <button
        class="instance-card"
        class:selected={selectedId === inst.tenantId}
        onclick={() => (selectedId = inst.tenantId)}
      >
        <div class="card-top">
          <span class="card-name">{inst.tenantId}</span>
          {#if inst.state === "Provisioning"}
            <span class="badge provisioning"><span class="pulse-dot"></span>Provisioning</span>
          {:else}
            <span class="badge {inst.state.toLowerCase()}">{inst.state}</span>
          {/if}
        </div>
        <div class="card-meta">
          <span>v{inst.version}</span>
          <span>{inst.region}</span>
        </div>
      </button>
    {:else}
      <div class="empty">No live instances</div>
    {/each}

    {#if inactiveInstances.length > 0}
      <div class="list-header inactive-header">
        <span class="list-count">{inactiveInstances.length} Inactive instances</span>
      </div>
      {#each inactiveInstances as inst (inst.tenantId)}
        <button
          class="instance-card inactive-card"
          class:selected={selectedId === inst.tenantId}
          onclick={() => (selectedId = inst.tenantId)}
        >
          <div class="card-top">
            <span class="card-name">{inst.tenantId}</span>
            {#if inst.state === "Deleting"}
              <span class="badge deleting"><span class="pulse-dot deleting-dot"></span>Deleting</span>
            {:else}
              <span class="badge deleted">{inst.state}</span>
            {/if}
          </div>
          <div class="card-meta">
            <span>v{inst.version}</span>
            <span>{inst.region}</span>
            {#if inst.state === "Deleted"}
              <button class="remove-btn" onclick={(e) => { e.stopPropagation(); handleRemove(inst.tenantId); }}>Remove</button>
            {/if}
          </div>
        </button>
      {/each}
    {/if}
  </aside>

  <!-- Right: Detail Panel -->
  <section class="detail-panel">
    {#if selected}
      <InstanceDetail
        instance={selected}
        onSuspend={handleSuspend}
        onDelete={handleDelete}
        onRemove={handleRemove}
      />
    {:else}
      <div class="empty-detail">
        <p>Select an instance from the list or create a new one</p>
      </div>
    {/if}
  </section>
</div>

{#if showCreate}
  <CreateInstanceDialog
    onCreate={handleCreate}
    onClose={() => (showCreate = false)}
  />
{/if}

<style>
  .badge.provisioning {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: #4fc3f7;
    border-color: #4fc3f7;
  }
  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4fc3f7;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 700;
  }

  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 1.5rem;
    align-items: start;
  }

  .instance-list {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .list-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.8rem;
    color: var(--color-text-muted);
  }

  .instance-card {
    width: 100%;
    text-align: left;
    padding: 0.75rem 1rem;
    border: none;
    border-bottom: 1px solid var(--color-border);
    border-radius: 0;
    background: var(--color-surface);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    cursor: pointer;
  }

  .instance-card:hover {
    background: var(--color-bg);
  }

  .instance-card.selected {
    background: #ddf4ff;
    border-left: 3px solid var(--color-primary);
  }

  .card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .card-name {
    font-weight: 600;
    font-size: 0.9rem;
  }

  .card-meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .detail-panel {
    min-height: 500px;
  }

  .empty-detail {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 400px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    color: var(--color-text-muted);
  }

  .empty {
    padding: 2rem;
    text-align: center;
    color: var(--color-text-muted);
  }

  .inactive-header {
    border-top: 2px solid var(--color-border);
    margin-top: 0.25rem;
  }

  .inactive-card {
    opacity: 0.7;
  }

  .badge.deleting {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: #ef6c00;
    border-color: #ef6c00;
  }

  .deleting-dot {
    background: #ef6c00 !important;
  }

  .badge.deleted {
    color: #999;
    border-color: #999;
  }

  .remove-btn {
    padding: 0.1rem 0.4rem;
    font-size: 0.7rem;
    border: 1px solid var(--color-danger, #dc2626);
    border-radius: var(--radius);
    background: transparent;
    color: var(--color-danger, #dc2626);
    cursor: pointer;
    margin-left: auto;
  }

  .remove-btn:hover {
    background: var(--color-danger, #dc2626);
    color: #fff;
  }
</style>
