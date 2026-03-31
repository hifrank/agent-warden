# OpenClaw Purview DLP Plugin

An OpenClaw plugin that enforces Microsoft Purview Data Loss Prevention (DLP) policies on all content flowing through an OpenClaw agent — user input, LLM output, and tool results — via the [Microsoft Graph processContent API](https://learn.microsoft.com/en-us/purview/developer/use-the-api).

## Features

- **L1: Prompt Guard** — Injects DLP-aware system prompt so the LLM self-censors sensitive data
- **L2: Output Scanner** — Scans tool results (file reads, web fetches, etc.) via Purview before the LLM sees them
- **L2b: Response Scanner** — Scans the LLM's final response before it reaches the user (enforce mode)
- **L3: Input Audit** — Scans inbound user messages via Purview
- **Protection Scopes** — Respects `evaluateInline` / `evaluateOffline` from Purview's `protectionScopes/compute` API
- **Two Modes** — `enforce` (block + redact) or `audit` (log only)

## Prerequisites

1. **OpenClaw** v2026.3.12+ with plugin hook support
2. **Microsoft 365 E5** (or E5 Compliance add-on) license — required for Purview DLP
3. **Entra ID App Registration** with the following Microsoft Graph application permissions:
   - `Content.Process.All`
   - `ProtectionScopes.Compute.All`
   - `InformationProtectionPolicy.Read.All` (optional — enables protectionScopes)
   - `ContentActivity.Write` (optional — enables audit logging)
4. **A licensed Entra user** — the `processContent` API requires a user context (Object ID)
5. **A Purview DLP policy** scoped to `Applications` workload with the `Entra` enforcement plane

## Installation

### 1. Copy the plugin into your OpenClaw instance

The plugin is a directory containing `openclaw.plugin.json`, `package.json`, and `src/`. Copy it into your OpenClaw plugins directory:

```bash
# From a release archive
tar xzf openclaw-purview-dlp-0.5.2.tar.gz -C /path/to/openclaw/plugins/

# Or from this repo
cp -r agent-warden-purview-dlp /path/to/openclaw/plugins/openclaw-purview-dlp
```

### 2. Install dependencies

```bash
cd /path/to/openclaw/plugins/openclaw-purview-dlp
npm install --omit=dev
```

### 3. Register the plugin in OpenClaw

Add the plugin to your OpenClaw configuration (`openclaw.json` or equivalent):

```json
{
  "plugins": [
    {
      "path": "./plugins/openclaw-purview-dlp",
      "enabled": true
    }
  ]
}
```

### 4. Configure the plugin

Create `config.json` in the plugin directory:

```json
{
  "mode": "enforce",
  "layers": {
    "promptGuard": true,
    "outputScanner": true,
    "inputAudit": true
  },
  "purview": {
    "enabled": true,
    "appName": "My App",
    "appVersion": "1.0.0",
    "userId": "<ENTRA_USER_OBJECT_ID>",
    "crossTenant": false
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `mode` | No | `"enforce"` (default) blocks content; `"audit"` logs only |
| `layers.promptGuard` | No | Enable L1 prompt guard (default: `true`) |
| `layers.outputScanner` | No | Enable L2/L2b output scanning (default: `true`) |
| `layers.inputAudit` | No | Enable L3 input audit (default: `true`) |
| `purview.appName` | No | App name reported to Purview (default: `"OpenClaw"`) |
| `purview.userId` | **Yes** | Entra Object ID of a licensed user in the Purview tenant |
| `purview.crossTenant` | No | Set `true` if Purview is in a different Entra tenant than the OpenClaw host |

### 5. Set environment variables

**Same-tenant** (OpenClaw and Purview in the same Entra tenant):

The plugin uses `DefaultAzureCredential` — no extra env vars needed if running with Managed Identity or `az login`.

**Cross-tenant** (Purview in a different tenant):

```bash
export PURVIEW_DLP_TENANT_ID="<PURVIEW_TENANT_ID>"
export PURVIEW_DLP_CLIENT_ID="<APP_REGISTRATION_CLIENT_ID>"
export PURVIEW_DLP_CLIENT_SECRET="<APP_REGISTRATION_CLIENT_SECRET>"
```

### 6. (Kubernetes) Use as init container

For Kubernetes deployments, the plugin ships as a container image that copies itself into a shared volume:

```yaml
initContainers:
  - name: purview-dlp-plugin
    image: your-registry/openclaw-purview-dlp:0.5.2
    command: ["sh", "-c", "cp -r /plugin/* /plugins/openclaw-purview-dlp/"]
    volumeMounts:
      - name: plugins
        mountPath: /plugins/openclaw-purview-dlp

containers:
  - name: openclaw-gateway
    # ...
    volumeMounts:
      - name: plugins
        mountPath: /data/state/plugins/openclaw-purview-dlp

volumes:
  - name: plugins
    emptyDir: {}
```

## Setting Up Purview DLP Policy

### 1. Create an App Registration

In the tenant where Purview is licensed:

```bash
az ad app create --display-name "OpenClaw Purview DLP" \
  --sign-in-audience AzureADMultipleOrgs
```

### 2. Grant Graph API Permissions

Grant these application permissions to the app's service principal:

| Permission | ID | Purpose |
|---|---|---|
| `Content.Process.All` | `5ad511bf-571c-4ef6-8c3c-85b94b85df98` | Call processContent API |
| `ProtectionScopes.Compute.All` | `e5a76501-dbb0-492c-ab55-5d09e8837263` | Query protectionScopes/compute |
| `InformationProtectionPolicy.Read.All` | `19da66cb-0fb0-4390-b071-ebc76a349482` | Read protection scope details |
| `ContentActivity.Write` | `2932e07a-3c29-44e4-bb36-6d0fc176387f` | Write audit logs |

```bash
# Get the service principal and Graph SP IDs
SP_ID=$(az ad sp show --id <APP_CLIENT_ID> --query id -o tsv)
GRAPH_SP=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query '[0].id' -o tsv)

# Grant permissions (example for Content.Process.All)
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignments" \
  --body "{
    \"principalId\": \"$SP_ID\",
    \"resourceId\": \"$GRAPH_SP\",
    \"appRoleId\": \"5ad511bf-571c-4ef6-8c3c-85b94b85df98\"
  }"
```

Repeat for each permission ID.

### 3. Create a DLP Policy in Purview

Use the Security & Compliance PowerShell module:

```powershell
# Connect to Security & Compliance
Connect-IPPSSession

# Create a policy scoped to Applications + Entra enforcement
New-DlpCompliancePolicy -Name "OpenClaw - Block PII" `
  -ExchangeLocation All `
  -SharePointLocation All `
  -OneDriveLocation All `
  -Workload "Exchange,SharePoint,OneDriveForBusiness,Applications" `
  -EnforcementPlanes "Entra"

# Add a rule to detect and block credit cards and SSNs
New-DlpComplianceRule -Name "Block SSN and Credit Card" `
  -Policy "OpenClaw - Block PII" `
  -ContentContainsSensitiveInformation @(
    @{Name="Credit Card Number"; minCount="1"; confidencelevel="Medium"},
    @{Name="U.S. Social Security Number (SSN)"; minCount="1"; confidencelevel="Medium"}
  ) `
  -BlockAccess $true `
  -BlockAccessScope All `
  -RestrictAccess @("UploadText:Block")
```

> **Note:** DLP policy changes take 15–60 minutes to propagate to the processContent API.

## Operational Modes

### Enforce Mode (default)

- Telegram streaming is set to **OFF** (required for L2b response scanning)
- `evaluateInline` activities use synchronous Purview calls — blocks the response until scanned
- `evaluateOffline` activities use async calls — logs violations but doesn't block
- Blocked content is replaced with: `[Agent Warden DLP] Content redacted — Purview DLP policy violation detected.`

### Audit Mode

- Telegram streaming stays **ON** (partial)
- All Purview calls are async — never blocks content
- Violations are logged but content flows through

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `protectionScopes/compute` returns 403 | Missing `InformationProtectionPolicy.Read.All` | Grant the permission; plugin falls back to `defaultExecutionMode` |
| `processContent` returns empty `policyActions` | DLP policy not propagated, or policy not scoped to `Applications`+`Entra` | Wait 15–60 min; verify policy has `EnforcementPlanes: Entra` |
| LLM self-censors before Purview scans | GPT safety filters trigger on PII patterns | This is expected — L1 prompt guard amplifies it; disable `promptGuard` to test L2/L3 independently |
| `The provided user doesn't exist` | Wrong `userId` for the Purview tenant | Use Object ID of a licensed user in the Purview tenant |
| Plugin disabled at startup | Missing env vars for cross-tenant auth | Set `PURVIEW_DLP_TENANT_ID`, `PURVIEW_DLP_CLIENT_ID`, `PURVIEW_DLP_CLIENT_SECRET` |

## Architecture

```
User ──► OpenClaw Gateway
              │
              ├── L3: message_received ──► Purview processContent (uploadText)
              │
              ├── L1: before_agent_start ──► Inject DLP system prompt
              │
              ├── LLM Call ──► GPT-5.4 / GPT-4o / etc.
              │
              ├── L2: tool_result_persist ──► Purview processContent (downloadText)
              │
              └── L2b: message_sending ──► Purview processContent (downloadText)
                        │
                        ├── ALLOWED → send to user
                        └── BLOCKED → "[DLP] Content redacted"
```
