<script lang="ts">
  import type { CreateInstanceInput } from "$lib/types";

  let {
    onCreate,
    onClose,
  }: {
    onCreate: (input: CreateInstanceInput) => void;
    onClose: () => void;
  } = $props();

  let tenantId = $state("");
  let adminEmail = $state("");
  let model = $state("gpt-5.4");
  let region = $state("eastus2");

  function handleSubmit(e: Event) {
    e.preventDefault();
    onCreate({ tenantId, adminEmail, model, region, channels: [] });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={onClose}>
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    <h2>Create OpenClaw Instance</h2>
    <form onsubmit={handleSubmit}>
      <div class="field">
        <label for="tenantId">Tenant ID</label>
        <input
          id="tenantId"
          bind:value={tenantId}
          oninput={(e) => { tenantId = e.currentTarget.value.toLowerCase(); }}
          placeholder="e.g. contoso-prod"
          required
          pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]"
          title="Lowercase letters, numbers, and hyphens only"
        />
      </div>
      <div class="field">
        <label for="adminEmail">Admin Email</label>
        <input id="adminEmail" type="email" bind:value={adminEmail} required />
      </div>
      <div class="field">
        <label for="model">Model</label>
        <select id="model" bind:value={model}>
          <option value="gpt-5.4">gpt-5.4</option>
        </select>
      </div>
      <div class="field">
        <label for="region">Region</label>
        <select id="region" bind:value={region}>
          <option value="eastus2">East US 2</option>
          <option value="westus3">West US 3</option>
          <option value="northeurope">North Europe</option>
          <option value="southeastasia">Southeast Asia</option>
        </select>
      </div>
      <div class="actions">
        <button type="button" onclick={onClose}>Cancel</button>
        <button type="submit" class="primary">Create Instance</button>
      </div>
    </form>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    background: var(--color-surface);
    border-radius: var(--radius);
    padding: 1.5rem;
    width: 440px;
    max-width: 90vw;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
  }

  h2 {
    font-size: 1.15rem;
    margin-bottom: 1.25rem;
  }

  .field {
    margin-bottom: 1rem;
  }

  label {
    display: block;
    font-size: 0.8rem;
    font-weight: 600;
    margin-bottom: 0.3rem;
  }

  input, select {
    width: 100%;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }
</style>
