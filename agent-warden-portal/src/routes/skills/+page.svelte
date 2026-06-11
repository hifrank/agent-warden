<script lang="ts">
  let { data } = $props();
</script>

<div class="page-header">
  <h1>Skill Management</h1>
</div>

<div class="table-wrapper">
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>Description</th>
        <th>Version</th>
        <th>Tenant</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      {#each data.skills as skill (skill.id)}
        <tr>
          <td class="name">{skill.name}</td>
          <td>{skill.description}</td>
          <td><code>{skill.version}</code></td>
          <td><code>{skill.tenantId}</code></td>
          <td>
            {#if skill.enabled}
              <span class="badge active">enabled</span>
            {:else}
              <span class="badge suspended">disabled</span>
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="5" class="empty">No skills configured</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .page-header {
    margin-bottom: 1.5rem;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 700;
  }

  .table-wrapper {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  th {
    text-align: left;
    padding: 0.75rem 1rem;
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }

  td {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border);
  }

  tr:last-child td {
    border-bottom: none;
  }

  .name {
    font-weight: 600;
  }

  code {
    background: var(--color-bg);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.8rem;
  }

  .empty {
    text-align: center;
    color: var(--color-text-muted);
    padding: 2rem;
  }
</style>
