<script lang="ts">
  import type { GlobalSettings } from "$lib/types";

  let { data } = $props();

  let activeSection = $state("global");
  let saving = $state(false);
  let saveMessage = $state("");

  // Form state initialized from server data
  let computeTenant = $state({
    entraTenanId: data.globalSettings?.computeTenant?.entraTenanId ?? "",
    aksClusterName: data.globalSettings?.computeTenant?.aksClusterName ?? "",
    aksResourceGroup: data.globalSettings?.computeTenant?.aksResourceGroup ?? "",
    acrLoginServer: data.globalSettings?.computeTenant?.acrLoginServer ?? "",
    sharedKeyVaultName: data.globalSettings?.computeTenant?.sharedKeyVaultName ?? "",
    kekKeyVaultName: data.globalSettings?.computeTenant?.kekKeyVaultName ?? "",
  });

  let e5Tenant = $state({
    purviewTenantId: data.globalSettings?.e5Tenant?.purviewTenantId ?? "",
    enabledByDefault: data.globalSettings?.e5Tenant?.enabledByDefault ?? true,
    defaultMode: (data.globalSettings?.e5Tenant?.defaultMode ?? "enforce") as "enforce" | "audit",
    defaultLayers: {
      promptGuard: data.globalSettings?.e5Tenant?.defaultLayers?.promptGuard ?? true,
      outputScanner: data.globalSettings?.e5Tenant?.defaultLayers?.outputScanner ?? true,
      inputAudit: data.globalSettings?.e5Tenant?.defaultLayers?.inputAudit ?? true,
    },
  });

  // ── E5 Admin App state ──
  let adminApp = $state({
    clientId: "",
    clientSecret: "",
  });
  let adminAppSaving = $state(false);
  let adminAppMessage = $state("");
  let adminAppConfigured = $state(!!data.globalSettings?.e5Tenant?.adminApp?.clientId);
  let adminAppConfiguredId = $state(data.globalSettings?.e5Tenant?.adminApp?.clientId ?? "");
  let adminAppTesting = $state(false);
  let adminAppTestResult = $state("");
  let showAdminCli = $state(false);

  // ── SCC App state ──
  let sccApp = $state({
    clientId: "",
    certificateThumbprint: "",
    e5OrgDomain: "",
  });
  let sccAppSaving = $state(false);
  let sccAppMessage = $state("");
  let sccAppConfigured = $state(!!data.globalSettings?.e5Tenant?.sccApp?.clientId);
  let sccAppConfiguredId = $state(data.globalSettings?.e5Tenant?.sccApp?.clientId ?? "");
  let showSccCli = $state(false);

  async function handleSave() {
    saving = true;
    saveMessage = "";
    try {
      // Preserve adminApp/sccApp that are managed by separate endpoints
      const e5TenantPayload: Record<string, unknown> = { ...e5Tenant };
      if (data.globalSettings?.e5Tenant?.adminApp) {
        e5TenantPayload.adminApp = data.globalSettings.e5Tenant.adminApp;
      }
      if (data.globalSettings?.e5Tenant?.sccApp) {
        e5TenantPayload.sccApp = data.globalSettings.e5Tenant.sccApp;
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ computeTenant, e5Tenant: e5TenantPayload }),
      });
      if (res.ok) {
        saveMessage = "Settings saved successfully";
      } else {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        saveMessage = `Error: ${err.error}`;
      }
    } catch (err) {
      saveMessage = `Error: ${err instanceof Error ? err.message : "Network error"}`;
    } finally {
      saving = false;
      setTimeout(() => (saveMessage = ""), 4000);
    }
  }

  async function handleSaveAdminApp() {
    if (!adminApp.clientId || !adminApp.clientSecret) {
      adminAppMessage = "Error: Client ID and Client Secret are required";
      return;
    }
    adminAppSaving = true;
    adminAppMessage = "";
    try {
      const res = await fetch("/api/settings/e5-admin-app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(adminApp),
      });
      const data = await res.json();
      if (res.ok) {
        adminAppMessage = "E5 Admin App credentials saved (secret encrypted with KEK)";
        adminAppConfigured = true;
        adminAppConfiguredId = adminApp.clientId;
        adminApp.clientSecret = "";
      } else {
        adminAppMessage = `Error: ${data.error}`;
      }
    } catch (err) {
      adminAppMessage = `Error: ${err instanceof Error ? err.message : "Network error"}`;
    } finally {
      adminAppSaving = false;
      setTimeout(() => (adminAppMessage = ""), 5000);
    }
  }

  async function handleTestAdminApp() {
    adminAppTesting = true;
    adminAppTestResult = "";
    try {
      const res = await fetch("/api/settings/e5-admin-app/test", { method: "POST" });
      const data = await res.json();
      adminAppTestResult = res.ok ? `✓ ${data.message}` : `✗ ${data.error}`;
    } catch (err) {
      adminAppTestResult = `✗ ${err instanceof Error ? err.message : "Network error"}`;
    } finally {
      adminAppTesting = false;
      setTimeout(() => (adminAppTestResult = ""), 8000);
    }
  }

  async function handleSaveSccApp() {
    if (!sccApp.clientId || !sccApp.certificateThumbprint || !sccApp.e5OrgDomain) {
      sccAppMessage = "Error: All fields are required";
      return;
    }
    sccAppSaving = true;
    sccAppMessage = "";
    try {
      const res = await fetch("/api/settings/scc-app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sccApp),
      });
      const data = await res.json();
      if (res.ok) {
        sccAppMessage = "SCC App credentials saved";
        sccAppConfigured = true;
        sccAppConfiguredId = sccApp.clientId;
      } else {
        sccAppMessage = `Error: ${data.error}`;
      }
    } catch (err) {
      sccAppMessage = `Error: ${err instanceof Error ? err.message : "Network error"}`;
    } finally {
      sccAppSaving = false;
      setTimeout(() => (sccAppMessage = ""), 5000);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  const sidebarItems = [
    { id: "global", label: "Global Settings", icon: "⚙" },
    { id: "e5-admin-app", label: "E5 Admin App", icon: "🔑" },
    { id: "scc-app", label: "SCC PowerShell App", icon: "📜" },
    { id: "purview-dlp", label: "Purview DLP", icon: "🛡" },
  ];
</script>

<div class="page-header">
  <h1>Settings</h1>
</div>

<div class="settings-layout">
  <!-- Left Sidebar -->
  <aside class="settings-sidebar">
    {#each sidebarItems as item (item.id)}
      <button
        class="sidebar-item"
        class:active={activeSection === item.id}
        onclick={() => (activeSection = item.id)}
      >
        <span class="sidebar-icon">{item.icon}</span>
        <span>{item.label}</span>
      </button>
    {/each}
  </aside>

  <!-- Right Content -->
  <section class="settings-content">
    {#if activeSection === "global"}
      <div class="section-header">
        <h2>Global Settings</h2>
        <p class="section-desc">System-wide configuration for compute infrastructure and E5 tenant identity.</p>
      </div>

      <!-- Compute Tenant -->
      <div class="settings-group">
        <h3>Compute Tenant</h3>
        <p class="group-desc">Azure infrastructure settings for the subscription hosting AKS, ACR, and Key Vaults.</p>

        <div class="form-grid">
          <div class="form-field">
            <label for="entraTenanId">Entra Tenant ID</label>
            <input id="entraTenanId" type="text" bind:value={computeTenant.entraTenanId} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            <span class="hint">Azure AD tenant ID where compute resources reside</span>
          </div>

          <div class="form-field">
            <label for="aksCluster">AKS Cluster Name</label>
            <input id="aksCluster" type="text" bind:value={computeTenant.aksClusterName} placeholder="aks-agentwarden-dev" />
          </div>

          <div class="form-field">
            <label for="aksRg">AKS Resource Group</label>
            <input id="aksRg" type="text" bind:value={computeTenant.aksResourceGroup} placeholder="rg-agentwarden-dev" />
          </div>

          <div class="form-field">
            <label for="acr">ACR Login Server</label>
            <input id="acr" type="text" bind:value={computeTenant.acrLoginServer} placeholder="myacr.azurecr.io" />
          </div>

          <div class="form-field">
            <label for="sharedKv">Shared Key Vault</label>
            <input id="sharedKv" type="text" bind:value={computeTenant.sharedKeyVaultName} placeholder="kv-demo-tenant" />
            <span class="hint">Platform secrets (API keys, credentials) — vault-level RBAC</span>
          </div>

          <div class="form-field">
            <label for="kekKv">KEK Key Vault</label>
            <input id="kekKv" type="text" bind:value={computeTenant.kekKeyVaultName} placeholder="kv-aw-kek-dev" />
            <span class="hint">Per-tenant envelope encryption keys — secret-scoped RBAC</span>
          </div>
        </div>
      </div>

      <!-- E5 Tenant Identity -->
      <div class="settings-group">
        <h3>E5 Tenant Identity</h3>
        <p class="group-desc">Microsoft 365 E5 tenant providing Purview DLP compliance capabilities.</p>

        <div class="form-grid">
          <div class="form-field">
            <label for="purviewTid">E5 Tenant ID</label>
            <input id="purviewTid" type="text" bind:value={e5Tenant.purviewTenantId} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            <span class="hint">M365 E5 tenant — must have Microsoft Purview DLP enabled</span>
          </div>

          <div class="form-field">
            <label>E5-Licensed User ID</label>
            <span class="hint">Moved to per-agent configuration — set during provisioning or in Instance Detail → DLP section</span>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button class="primary" onclick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
        {#if saveMessage}
          <span class="save-msg" class:error={saveMessage.startsWith("Error")}>{saveMessage}</span>
        {/if}
      </div>

    {:else if activeSection === "e5-admin-app"}
      <div class="section-header">
        <h2>E5 Admin App</h2>
        <p class="section-desc">App registration in the E5 tenant used for cross-tenant Graph API operations (creating per-agent app registrations).</p>
      </div>

      <!-- CLI Setup Instructions -->
      <div class="settings-group">
        <div class="cli-toggle">
          <h3>Setup Instructions</h3>
          <button class="text-btn" onclick={() => (showAdminCli = !showAdminCli)}>
            {showAdminCli ? "Hide CLI Commands" : "Show CLI Commands"}
          </button>
        </div>
        <p class="group-desc">Create an app registration in your E5 tenant with permissions to manage other app registrations.</p>

        {#if showAdminCli}
          <div class="cli-commands">
            <div class="cli-step">
              <span class="cli-num">1</span>
              <div class="cli-content">
                <p class="cli-label">Login to E5 tenant</p>
                <div class="cli-code">
                  <code>az login --tenant {e5Tenant.purviewTenantId || "<E5_TENANT_ID>"}</code>
                  <button class="copy-btn" onclick={() => copyToClipboard(`az login --tenant ${e5Tenant.purviewTenantId || "<E5_TENANT_ID>"}`)}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">2</span>
              <div class="cli-content">
                <p class="cli-label">Create the app registration</p>
                <div class="cli-code">
                  <code>az ad app create --display-name "AgentWarden-E5-Admin" --sign-in-audience AzureADMyOrg</code>
                  <button class="copy-btn" onclick={() => copyToClipboard('az ad app create --display-name "AgentWarden-E5-Admin" --sign-in-audience AzureADMyOrg')}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">3</span>
              <div class="cli-content">
                <p class="cli-label">Add Graph API permissions (Application.ReadWrite.All)</p>
                <div class="cli-code">
                  <code>az ad app permission add --id &lt;APP_ID&gt; --api 00000003-0000-0000-c000-000000000000 --api-permissions 1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9=Role</code>
                  <button class="copy-btn" onclick={() => copyToClipboard('az ad app permission add --id <APP_ID> --api 00000003-0000-0000-c000-000000000000 --api-permissions 1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9=Role')}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">4</span>
              <div class="cli-content">
                <p class="cli-label">Grant admin consent</p>
                <div class="cli-code">
                  <code>az ad app permission admin-consent --id &lt;APP_ID&gt;</code>
                  <button class="copy-btn" onclick={() => copyToClipboard('az ad app permission admin-consent --id <APP_ID>')}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">5</span>
              <div class="cli-content">
                <p class="cli-label">Create a client secret</p>
                <div class="cli-code">
                  <code>az ad app credential reset --id &lt;APP_ID&gt; --years 2</code>
                  <button class="copy-btn" onclick={() => copyToClipboard('az ad app credential reset --id <APP_ID> --years 2')}>📋</button>
                </div>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Credentials Input -->
      <div class="settings-group">
        <h3>Credentials</h3>
        <p class="group-desc">Enter the Client ID and Client Secret from the app registration above. The secret will be encrypted with KEK before storage.</p>

        {#if adminAppConfigured}
          <div class="configured-badge">
            <span class="badge-icon">✓</span>
            <span>Configured — Client ID: <code>{adminAppConfiguredId}</code></span>
          </div>
        {/if}

        <div class="form-grid">
          <div class="form-field">
            <label for="adminClientId">Client ID</label>
            <input id="adminClientId" type="text" bind:value={adminApp.clientId} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </div>
          <div class="form-field">
            <label for="adminClientSecret">Client Secret</label>
            <input id="adminClientSecret" type="password" bind:value={adminApp.clientSecret} placeholder="Enter client secret (will be KEK-encrypted)" />
          </div>
        </div>

        <div class="form-actions">
          <button class="primary" onclick={handleSaveAdminApp} disabled={adminAppSaving}>
            {adminAppSaving ? "Saving..." : "Save Credentials"}
          </button>
          {#if adminAppConfigured}
            <button class="secondary" onclick={handleTestAdminApp} disabled={adminAppTesting}>
              {adminAppTesting ? "Testing..." : "Test Connection"}
            </button>
          {/if}
          {#if adminAppMessage}
            <span class="save-msg" class:error={adminAppMessage.startsWith("Error")}>{adminAppMessage}</span>
          {/if}
          {#if adminAppTestResult}
            <span class="save-msg" class:error={adminAppTestResult.startsWith("✗")}>{adminAppTestResult}</span>
          {/if}
        </div>
      </div>

    {:else if activeSection === "scc-app"}
      <div class="section-header">
        <h2>SCC PowerShell App</h2>
        <p class="section-desc">App registration in the E5 tenant used by the Security & Compliance Center PowerShell module for DLP policy management.</p>
      </div>

      <!-- CLI Setup Instructions -->
      <div class="settings-group">
        <div class="cli-toggle">
          <h3>Setup Instructions</h3>
          <button class="text-btn" onclick={() => (showSccCli = !showSccCli)}>
            {showSccCli ? "Hide CLI Commands" : "Show CLI Commands"}
          </button>
        </div>
        <p class="group-desc">Create an app registration with certificate-based auth for Connect-IPPSSession.</p>

        {#if showSccCli}
          <div class="cli-commands">
            <div class="cli-step">
              <span class="cli-num">1</span>
              <div class="cli-content">
                <p class="cli-label">Login to E5 tenant</p>
                <div class="cli-code">
                  <code>az login --tenant {e5Tenant.purviewTenantId || "<E5_TENANT_ID>"}</code>
                  <button class="copy-btn" onclick={() => copyToClipboard(`az login --tenant ${e5Tenant.purviewTenantId || "<E5_TENANT_ID>"}`)}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">2</span>
              <div class="cli-content">
                <p class="cli-label">Create the app registration</p>
                <div class="cli-code">
                  <code>az ad app create --display-name "AgentWarden-SCC-PowerShell" --sign-in-audience AzureADMyOrg</code>
                  <button class="copy-btn" onclick={() => copyToClipboard('az ad app create --display-name "AgentWarden-SCC-PowerShell" --sign-in-audience AzureADMyOrg')}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">3</span>
              <div class="cli-content">
                <p class="cli-label">Generate a self-signed certificate</p>
                <div class="cli-code">
                  <code>openssl req -x509 -newkey rsa:2048 -keyout scc-key.pem -out scc-cert.pem -days 730 -nodes -subj "/CN=AgentWarden-SCC"</code>
                  <button class="copy-btn" onclick={() => copyToClipboard('openssl req -x509 -newkey rsa:2048 -keyout scc-key.pem -out scc-cert.pem -days 730 -nodes -subj "/CN=AgentWarden-SCC"')}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">4</span>
              <div class="cli-content">
                <p class="cli-label">Get the certificate thumbprint</p>
                <div class="cli-code">
                  <code>openssl x509 -in scc-cert.pem -fingerprint -noout | sed 's/://g' | cut -d= -f2</code>
                  <button class="copy-btn" onclick={() => copyToClipboard("openssl x509 -in scc-cert.pem -fingerprint -noout | sed 's/://g' | cut -d= -f2")}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">5</span>
              <div class="cli-content">
                <p class="cli-label">Upload certificate to the app registration</p>
                <div class="cli-code">
                  <code>az ad app credential reset --id &lt;APP_ID&gt; --cert @scc-cert.pem</code>
                  <button class="copy-btn" onclick={() => copyToClipboard('az ad app credential reset --id <APP_ID> --cert @scc-cert.pem')}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">6</span>
              <div class="cli-content">
                <p class="cli-label">Add Exchange.ManageAsApp permission</p>
                <div class="cli-code">
                  <code>az ad app permission add --id &lt;APP_ID&gt; --api 00000002-0000-0ff1-ce00-000000000000 --api-permissions dc50a0fb-09a3-484d-be87-e023b12c6440=Role</code>
                  <button class="copy-btn" onclick={() => copyToClipboard('az ad app permission add --id <APP_ID> --api 00000002-0000-0ff1-ce00-000000000000 --api-permissions dc50a0fb-09a3-484d-be87-e023b12c6440=Role')}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">7</span>
              <div class="cli-content">
                <p class="cli-label">Grant admin consent</p>
                <div class="cli-code">
                  <code>az ad app permission admin-consent --id &lt;APP_ID&gt;</code>
                  <button class="copy-btn" onclick={() => copyToClipboard('az ad app permission admin-consent --id <APP_ID>')}>📋</button>
                </div>
              </div>
            </div>
            <div class="cli-step">
              <span class="cli-num">8</span>
              <div class="cli-content">
                <p class="cli-label">Assign "Compliance Administrator" role in Entra portal</p>
                <div class="cli-code">
                  <code>Entra portal → Roles and administrators → Compliance Administrator → Add assignment → select the app's service principal</code>
                </div>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- SCC Credentials Input -->
      <div class="settings-group">
        <h3>Credentials</h3>
        <p class="group-desc">Enter the app details. The certificate and private key should be mounted as a Kubernetes secret on the SCC microservice.</p>

        {#if sccAppConfigured}
          <div class="configured-badge">
            <span class="badge-icon">✓</span>
            <span>Configured — Client ID: <code>{sccAppConfiguredId}</code></span>
          </div>
        {/if}

        <div class="form-grid">
          <div class="form-field">
            <label for="sccClientId">Client ID</label>
            <input id="sccClientId" type="text" bind:value={sccApp.clientId} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </div>
          <div class="form-field">
            <label for="sccThumbprint">Certificate Thumbprint</label>
            <input id="sccThumbprint" type="text" bind:value={sccApp.certificateThumbprint} placeholder="SHA1 thumbprint (40 hex chars)" />
          </div>
          <div class="form-field">
            <label for="sccOrgDomain">E5 Organization Domain</label>
            <input id="sccOrgDomain" type="text" bind:value={sccApp.e5OrgDomain} placeholder="contoso.onmicrosoft.com" />
            <span class="hint">Used for Connect-IPPSSession -Organization parameter</span>
          </div>
        </div>

        <div class="form-actions">
          <button class="primary" onclick={handleSaveSccApp} disabled={sccAppSaving}>
            {sccAppSaving ? "Saving..." : "Save Credentials"}
          </button>
          {#if sccAppMessage}
            <span class="save-msg" class:error={sccAppMessage.startsWith("Error")}>{sccAppMessage}</span>
          {/if}
        </div>
      </div>

    {:else if activeSection === "purview-dlp"}
      <div class="section-header">
        <h2>Purview DLP</h2>
        <p class="section-desc">Configure how the Purview DLP plugin behaves across all OpenClaw instances. DLP policies are managed in the <a href="https://purview.microsoft.com/datalossprevention/policies" target="_blank" rel="noopener">Microsoft Purview compliance portal</a>.</p>
      </div>

      <!-- How it works -->
      <div class="settings-group info-group">
        <h3>How Purview DLP Works</h3>
        <div class="info-content">
          <p>Each OpenClaw instance has its own <strong>Entra app registration</strong> in the E5 tenant. The DLP plugin calls the <code>processContent</code> Graph API to evaluate content against your Purview DLP policies.</p>
          <div class="info-flow">
            <div class="flow-step">
              <span class="flow-num">1</span>
              <span>Plugin intercepts messages at configured layers (L1/L2/L3)</span>
            </div>
            <div class="flow-step">
              <span class="flow-num">2</span>
              <span>Calls <code>protectionScopes/compute</code> to determine evaluation mode</span>
            </div>
            <div class="flow-step">
              <span class="flow-num">3</span>
              <span>Calls <code>processContent</code> API with message text</span>
            </div>
            <div class="flow-step">
              <span class="flow-num">4</span>
              <span>Purview evaluates against your DLP policies and returns actions (allow/block/restrict)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Default DLP Behavior -->
      <div class="settings-group">
        <h3>Default DLP Behavior</h3>
        <p class="group-desc">Default settings applied when provisioning new OpenClaw instances.</p>

        <div class="form-grid">
          <div class="form-field">
            <label for="dlpMode">Default Mode</label>
            <select id="dlpMode" bind:value={e5Tenant.defaultMode}>
              <option value="enforce">Enforce — block/restrict sensitive content</option>
              <option value="audit">Audit — log only, never block</option>
            </select>
            <span class="hint">Enforce mode disables Telegram streaming to ensure L2b hook fires</span>
          </div>

          <div class="form-field checkbox-field">
            <label>
              <input type="checkbox" bind:checked={e5Tenant.enabledByDefault} />
              Enable DLP for new instances by default
            </label>
          </div>
        </div>
      </div>

      <!-- DLP Layers -->
      <div class="settings-group">
        <h3>Default DLP Layers</h3>
        <p class="group-desc">Which protection layers are enabled by default for new instances. Each layer independently calls the Purview <code>processContent</code> API.</p>

        <div class="layers-list">
          <label class="layer-item">
            <input type="checkbox" bind:checked={e5Tenant.defaultLayers.promptGuard} />
            <div class="layer-info">
              <strong>L1 — Prompt Guard</strong>
              <span class="layer-desc">Injects DLP security policy into the agent's system context before each conversation. Instructs the LLM to never output raw sensitive data.</span>
              <span class="layer-hook">Hook: <code>before_agent_start</code></span>
            </div>
          </label>

          <label class="layer-item">
            <input type="checkbox" bind:checked={e5Tenant.defaultLayers.outputScanner} />
            <div class="layer-info">
              <strong>L2 — Output Scanner</strong>
              <span class="layer-desc">Scans tool results and outbound agent responses via Purview <code>processContent</code>. In enforce mode, blocks or redacts restricted content.</span>
              <span class="layer-hook">Hooks: <code>tool_result_persist</code>, <code>message_sending</code></span>
            </div>
          </label>

          <label class="layer-item">
            <input type="checkbox" bind:checked={e5Tenant.defaultLayers.inputAudit} />
            <div class="layer-info">
              <strong>L3 — Input Audit</strong>
              <span class="layer-desc">Audits inbound user messages via Purview <code>processContent</code>. Detects sensitive data in user input before it reaches the agent.</span>
              <span class="layer-hook">Hook: <code>message_received</code></span>
            </div>
          </label>
        </div>
      </div>

      <!-- Per-Instance App Registration Info -->
      <div class="settings-group info-group">
        <h3>Per-Instance App Registration</h3>
        <div class="info-content">
          <p>Each OpenClaw instance requires its own <strong>Entra app registration</strong> in the E5 tenant with the following permissions:</p>
          <table class="permissions-table">
            <thead>
              <tr>
                <th>Permission</th>
                <th>Type</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>InformationProtectionPolicy.Read.All</code></td>
                <td>Application</td>
                <td>Read protection scopes</td>
              </tr>
              <tr>
                <td><code>InformationProtectionContent.Write.All</code></td>
                <td>Application</td>
                <td>processContent API</td>
              </tr>
              <tr>
                <td><code>ContentActivity.Write</code></td>
                <td>Application</td>
                <td>Content activity logging</td>
              </tr>
            </tbody>
          </table>
          <p class="info-note">The app's Client ID and Client Secret are stored as Kubernetes secrets per instance (<code>PURVIEW_DLP_CLIENT_ID</code>, <code>PURVIEW_DLP_CLIENT_SECRET</code>) and configured during provisioning.</p>
        </div>
      </div>

      <!-- Manage Policies Link -->
      <div class="settings-group">
        <h3>DLP Policy Management</h3>
        <p class="group-desc">DLP policies (sensitive info types, conditions, and actions) are configured in the Microsoft Purview compliance portal. The <code>processContent</code> API evaluates content against those centrally-managed policies.</p>
        <a
          href="https://purview.microsoft.com/datalossprevention/policies"
          target="_blank"
          rel="noopener"
          class="external-link"
        >
          Open Microsoft Purview DLP Policies Portal →
        </a>
      </div>

      <div class="form-actions">
        <button class="primary" onclick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
        {#if saveMessage}
          <span class="save-msg" class:error={saveMessage.startsWith("Error")}>{saveMessage}</span>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  .page-header {
    margin-bottom: 1.5rem;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 700;
  }

  .settings-layout {
    display: flex;
    gap: 1.5rem;
    min-height: calc(100vh - 140px);
  }

  .settings-sidebar {
    width: 220px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .sidebar-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--color-text-muted);
    font-size: 0.875rem;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s;
  }

  .sidebar-item:hover {
    background: var(--color-surface);
    color: var(--color-text);
  }

  .sidebar-item.active {
    background: var(--color-primary);
    color: white;
  }

  .sidebar-icon {
    font-size: 1rem;
    width: 1.25rem;
    text-align: center;
  }

  .settings-content {
    flex: 1;
    min-width: 0;
  }

  .section-header {
    margin-bottom: 1.5rem;
  }

  .section-header h2 {
    font-size: 1.25rem;
    font-weight: 700;
    margin-bottom: 0.25rem;
  }

  .section-desc {
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }

  .settings-group {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 1.25rem;
    margin-bottom: 1rem;
  }

  .settings-group h3 {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .group-desc {
    color: var(--color-text-muted);
    font-size: 0.8125rem;
    margin-bottom: 1rem;
  }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .form-field label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text);
  }

  .form-field input[type="text"],
  .form-field select {
    width: 100%;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .checkbox-field {
    grid-column: 1 / -1;
  }

  .checkbox-field label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 500;
    cursor: pointer;
  }

  .checkbox-field input[type="checkbox"] {
    width: 1rem;
    height: 1rem;
    accent-color: var(--color-primary);
  }

  .form-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: 1.5rem;
  }

  .save-msg {
    font-size: 0.875rem;
    color: var(--color-success);
  }

  .save-msg.error {
    color: var(--color-danger);
  }

  /* ── Purview DLP section styles ── */

  .section-desc a {
    color: var(--color-primary);
    text-decoration: none;
  }

  .section-desc a:hover {
    text-decoration: underline;
  }

  .info-group {
    background: var(--color-bg);
  }

  .info-content {
    font-size: 0.875rem;
    line-height: 1.6;
  }

  .info-content p {
    margin-bottom: 0.75rem;
  }

  .info-content code {
    background: var(--color-surface);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.8rem;
  }

  .info-flow {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .flow-step {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    font-size: 0.8125rem;
  }

  .flow-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border-radius: 50%;
    background: var(--color-primary);
    color: white;
    font-size: 0.7rem;
    font-weight: 700;
    flex-shrink: 0;
  }

  .layers-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .layer-item {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .layer-item:hover {
    border-color: var(--color-primary);
  }

  .layer-item input[type="checkbox"] {
    width: 1.125rem;
    height: 1.125rem;
    margin-top: 0.125rem;
    accent-color: var(--color-primary);
    flex-shrink: 0;
  }

  .layer-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .layer-info strong {
    font-size: 0.875rem;
  }

  .layer-desc {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    line-height: 1.4;
  }

  .layer-hook {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .layer-hook code {
    background: var(--color-bg);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.7rem;
  }

  .permissions-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
    margin: 0.5rem 0;
  }

  .permissions-table th {
    text-align: left;
    padding: 0.5rem 0.75rem;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }

  .permissions-table td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .permissions-table code {
    background: var(--color-bg);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .info-note {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin-top: 0.5rem;
  }

  .info-note code {
    font-size: 0.75rem;
  }

  .external-link {
    display: inline-flex;
    align-items: center;
    color: var(--color-primary);
    font-size: 0.875rem;
    font-weight: 500;
    text-decoration: none;
    margin-top: 0.25rem;
  }

  .external-link:hover {
    text-decoration: underline;
  }

  /* ── CLI Commands & Admin/SCC App styles ── */

  .cli-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .text-btn {
    background: none;
    border: none;
    color: var(--color-primary);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
  }

  .text-btn:hover {
    text-decoration: underline;
  }

  .cli-commands {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .cli-step {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
  }

  .cli-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border-radius: 50%;
    background: var(--color-primary);
    color: white;
    font-size: 0.7rem;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 0.125rem;
  }

  .cli-content {
    flex: 1;
    min-width: 0;
  }

  .cli-label {
    font-size: 0.8125rem;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .cli-code {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
  }

  .cli-code code {
    font-size: 0.75rem;
    white-space: nowrap;
    flex: 1;
  }

  .copy-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    padding: 0.125rem;
    opacity: 0.6;
    flex-shrink: 0;
  }

  .copy-btn:hover {
    opacity: 1;
  }

  .configured-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, var(--color-success) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
    border-radius: var(--radius);
    font-size: 0.8125rem;
    margin-bottom: 1rem;
  }

  .badge-icon {
    color: var(--color-success);
    font-weight: 700;
  }

  .configured-badge code {
    background: var(--color-surface);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .secondary {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    padding: 0.5rem 1rem;
    border-radius: var(--radius);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .secondary:hover {
    background: var(--color-bg);
    border-color: var(--color-primary);
  }

  .secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
