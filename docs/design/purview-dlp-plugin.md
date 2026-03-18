# Purview DLP Plugin — Cross-Tenant Architecture

> **Status:** Validated (E2E tested)  
> **Date:** 2026-03-17 (updated from 2025-07-12)  
> **Version:** v0.4.0  
> **Depends on:** OpenClaw v2026.3.12 plugin hooks, Microsoft Purview processContent API (GA)

---

## 1. Overview

This document describes the architecture for integrating Microsoft Purview Data Loss Prevention (DLP) into OpenClaw as a native plugin. The Purview account resides in a **different Entra ID tenant** (E5 tenant) from the AKS cluster hosting OpenClaw (Contoso tenant).

### Tenants

| Role | Tenant | Tenant ID |
|------|--------|-----------|
| **Hosting** (AKS, AOAI, Key Vault) | Contoso (ME-AI) | `9a72f9b7-227c-4b28-9aca-de6c1ec605a4` |
| **Purview** (DLP policies, E5 license) | E5 Tenant | `2cf24558-0d31-439b-9c8d-6fdce3931ae7` |

### Goal

Scan all content flowing through OpenClaw (user input, LLM output, tool results) against the E5 tenant's Purview DLP policies, and enforce or audit policy actions — without requiring user interactive login.

### Operational Modes

| Mode | Streaming | L2 Behavior | L2b | Use Case |
|------|-----------|-------------|-----|----------|
| **`enforce`** (default) | OFF | Sync Purview (`spawnSync`+`curl`), redacts on block | Active — blocks outbound PII | Production |
| **`audit`** | ON (partial) | Async Purview, log only | Not registered | Monitoring |

---

## 2. Cross-Tenant Authentication

### 2.1 Why Cross-Tenant?

The `processContent` Graph API enforces DLP policies configured in the tenant where the **licensed user** resides. Since our M365 E5 license and DLP policies live in the E5 tenant, we must authenticate **as a service principal in the E5 tenant** to call the API.

### 2.2 Auth Options

| Option | Pros | Cons | Chosen? |
|--------|------|------|---------|
| **A. Client Secret** (ClientSecretCredential) | Simple setup, works today | Secret rotation burden, secret stored in K8s | **Phase 1 ✓** |
| **B. Federated Identity Credential** (Workload Identity → E5 app) | No secrets, leverages AKS Workload Identity | Requires cross-tenant FIC setup, more complex | **Phase 2** |
| **C. Managed Identity + cross-tenant consent** | Simplest if same tenant | Not applicable — different tenants | ✗ |

### 2.3 Phase 1: Client Secret Flow

```
┌──────────────────┐       ┌──────────────────┐       ┌───────────────────┐
│   AKS Pod        │       │  Entra ID (E5)   │       │  Microsoft Graph  │
│   (Contoso)      │       │  Tenant           │       │  (Purview API)    │
│                  │       │                  │       │                   │
│ OpenClaw Gateway │──1──▶ │  Token Endpoint  │       │                   │
│  + DLP Plugin    │       │  /oauth2/v2.0/   │       │                   │
│                  │◀──2── │  token           │       │                   │
│                  │       │                  │       │                   │
│                  │──────────────3──────────────────▶ │ processContent    │
│                  │◀─────────────4──────────────────  │ (DLP evaluation)  │
└──────────────────┘       └──────────────────┘       └───────────────────┘
```

1. Plugin requests token from E5 tenant: `POST https://login.microsoftonline.com/{E5_TENANT_ID}/oauth2/v2.0/token`
2. Entra ID returns access token (scope: `https://graph.microsoft.com/.default`)
3. Plugin calls `POST /v1.0/users/{userId}/dataSecurityAndGovernance/processContent` with Bearer token
4. Graph returns `policyActions` (allow / restrictAccess / block)

**Required env vars:**

| Env Var | Source | Description |
|---------|--------|-------------|
| `PURVIEW_DLP_TENANT_ID` | Helm value | E5 tenant ID |
| `PURVIEW_DLP_CLIENT_ID` | Key Vault → SecretProviderClass | App registration client ID (in E5 tenant) |
| `PURVIEW_DLP_CLIENT_SECRET` | Key Vault → SecretProviderClass | App registration client secret |

### 2.4 Phase 2: Federated Identity Credential (Future)

Eliminates the client secret by establishing trust between AKS Workload Identity and the E5 tenant app registration:

```
AKS Pod (Contoso)                    Entra ID (E5 Tenant)
  │                                     │
  │ Workload Identity OIDC token        │
  │ (iss: AKS OIDC issuer URL)         │
  │                                     │
  └───── exchanges OIDC token ─────────▶│ App Registration
         for Graph access token         │ + Federated Identity
                                        │   Credential (FIC)
                                        │   trusts AKS OIDC issuer
```

**Setup steps:**
1. On the E5 tenant app registration, add a Federated Identity Credential:
   - **Issuer**: AKS OIDC issuer URL (`az aks show --query oidcIssuerProfile.issuerUrl`)
   - **Subject**: `system:serviceaccount:tenant-demo-tenant:openclaw-demo-tenant`
   - **Audience**: `api://AzureADTokenExchange`
2. In the plugin, use `WorkloadIdentityCredential` with `tenantId` set to E5 tenant
3. Remove client secret from Key Vault

### 2.5 App Registration Setup (E5 Tenant)

The existing app registration (client ID: `d94c93dd-3c80-4f3d-9671-8b71a7dccafa`) in the E5 tenant needs:

**API Permissions (Application type, not Delegated):**

| Permission | Type | Description |
|------------|------|-------------|
| `InformationProtectionPolicy.Read.All` | Application | Read tenant DLP policy scope |
| `Content.DLP.Process.All` | Application | Call processContent API |

> **Note:** These permissions require **admin consent** in the E5 tenant. The `processContent` API also requires the target user to have an **M365 E5, E5 Compliance, or F5 Security** license.

---

## 3. Plugin Hook Architecture

### 3.1 Available Hooks (Relevant to DLP)

From the OpenClaw v2026.3.12 gateway binary analysis, these hooks are relevant for DLP:

| Hook | Execution | Can Modify/Block? | v0.4.0 Use | Notes |
|------|-----------|-------------------|------------|-------|
| `message_received` | async, parallel | No (void) | **L3: Input Audit** | Cannot block delivery |
| `before_agent_start` | async, sequential | Yes: `{ prependContext }` | **L1: Prompt Guard** | Injects DLP system policy |
| `tool_result_persist` | **SYNC**, sequential | Yes: `{ message }` | **L2: Output Scanner** | Enforce: sync `spawnSync`+`curl`. Audit: async (return ignored) |
| `message_sending` | async, sequential (`runModifyingHook`) | Yes: `{ content, cancel }` | **L2b: Response Scanner** | Enforce only. **Bypassed by Telegram streaming preview** |
| `before_tool_call` | async, sequential | Yes: `{ block, blockReason }` | — (future L5) | Tool gating after DLP violations |

> **Critical discovery:** `message_sending` fires via `deliverOutboundPayloadsCore` but is **bypassed** by Telegram's streaming path (`deliverReplies` → `editMessageTelegram`). Enforce mode must set `streaming: "off"` for L2b to work.

### 3.2 v0.4.0 Layer Architecture (Implemented)

```
User sends message via Telegram
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway (Tenant Pod)                               │
│                                                              │
│   L3: Input Audit (message_received)  ────► Purview API      │
│   • Async, void — log BLOCKED/ALLOWED      (uploadText)      │
│   • Cannot block delivery                                    │
│         │                                                    │
│         ▼                                                    │
│   L1: Prompt Guard (before_agent_start)                      │
│   • Injects DLP security policy into LLM context             │
│   • No API call — static policy injection                    │
│         │                                                    │
│         ▼                                                    │
│   🤖 LLM (gpt-4o via LiteLLM)                               │
│   • DLP policy in system context                             │
│   • May call tools (exec, file read, etc.)                   │
│         │                                                    │
│         ▼                                                    │
│   L2: Output Scanner (tool_result_persist)  ─► Purview API   │
│   • enforce: spawnSync+curl (SYNC) → redact  (uploadText)    │
│   • audit: async log only (return ignored)                   │
│         │                                                    │
│         ▼                                                    │
│   L2b: Response Scanner (message_sending)  ──► Purview API   │
│   • enforce only (requires streaming OFF)    (uploadText)    │
│   • Replaces outbound PII with DLP notice                    │
│   • Skips own "[Agent Warden DLP]" messages                  │
│         │                                                    │
│         ▼                                                    │
│   Telegram sendMessage                                       │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 Layer Details (v0.4.0 — Implemented)

#### L1: Prompt Guard (`before_agent_start` — async, sequential, modifying)

- **When:** Before building the LLM prompt
- **Action:** Inject a DLP security policy into `prependContext` instructing the LLM to never output PII, credit card numbers, SSNs, credentials
- **Enforcement:** Modifies agent context. LLM self-censors based on injected policy
- **Purview activity:** None (no API call — static policy injection)
- **Returns:** `{ prependContext: string }`
- **Always active** regardless of Purview availability

#### L2: Output Scanner (`tool_result_persist` — **SYNC** in enforce, async in audit)

- **When:** Before persisting a tool's result into conversation history
- **Enforce mode:** Synchronous handler calls `processContentSync()` which uses `spawnSync('curl', ...)` to make a blocking HTTP call to Purview. If Purview returns `restrictAccess`, the tool output is replaced with `[Agent Warden DLP] Content redacted`. The sync approach is required because this hook ignores async return values.
- **Audit mode:** Async handler calls `processContent()` via `fetch`. Return value is ignored (sync hook warning logged). Logs `would BLOCK` for violations.
- **Purview activity:** `uploadText`
- **Returns (enforce):** `{ message: redactedMessage }` (synchronously)
- **Content extraction:** Handles string content, `[{type: "text", text: "..."}]` arrays, and raw message objects

#### L2b: Response Scanner (`message_sending` — async, sequential, modifying) — **Enforce only**

- **When:** Before sending an LLM response to the user via Telegram
- **Action:** Purview `processContent(content, "uploadText")` on the outbound message
- **Enforcement:** If Purview returns `restrictAccess` or `block`: replaces `content` with `[Agent Warden DLP] Response blocked — sensitive information detected by Purview DLP policy.`
- **Skip condition:** Messages starting with `[Agent Warden DLP]` are skipped to avoid re-scanning own redaction notices
- **Purview activity:** `uploadText`
- **Returns:** `{ content: "..blocked.." }` or `undefined` (passthrough)
- **CRITICAL:** Only fires when Telegram streaming is OFF. The `message_sending` hook is dispatched via `deliverOutboundPayloadsCore` which is **bypassed** by Telegram's streaming preview path (`deliverReplies` → `editMessageTelegram`). The plugin auto-sets `streaming: "off"` in enforce mode.
- **Not registered** in audit mode (no blocking needed, streaming ON for UX)

#### L3: Input Audit (`message_received` — async, void, parallel)

- **When:** Every inbound user message
- **Action:** Purview `processContent(content, "uploadText")`
- **Enforcement:** Cannot block (void hook). Logs BLOCKED/ALLOWED for audit trail
- **Purview activity:** `uploadText`
- **Always active** in both enforce and audit modes

#### Future: L5 Tool Gating (`before_tool_call`)

- Not yet implemented. Would block high-risk tools (shell exec, file write) after DLP violations

---

## 4. processContent API Integration

### 4.1 API Endpoint

```
POST https://graph.microsoft.com/v1.0/users/{userId}/dataSecurityAndGovernance/processContent
```

- `{userId}`: An E5-licensed user's Object ID in the E5 tenant
- Auth: Bearer token from E5 tenant app registration

### 4.2 Request Body

```jsonc
{
  "contentToProcess": {
    "contentEntries": [
      {
        "@odata.type": "microsoft.graph.processConversationMetadata",
        "identifier": "<uuid>",
        "content": {
          "@odata.type": "microsoft.graph.textContent",
          "data": "<text to scan>"
        },
        "name": "Agent Warden DLP scan",
        "correlationId": "<session-correlation-id>",
        "sequenceNumber": 0,
        "isTruncated": false,
        "createdDateTime": "2025-07-12T00:00:00Z",
        "modifiedDateTime": "2025-07-12T00:00:00Z"
      }
    ],
    "activityMetadata": {
      "activity": "uploadText"    // or "downloadText"
    },
    "deviceMetadata": {
      "deviceType": "Managed",
      "operatingSystemSpecifications": {
        "operatingSystemPlatform": "Linux",
        "operatingSystemVersion": "AKS"
      }
    },
    "protectedAppMetadata": {
      "name": "Agent Warden",
      "version": "0.2.0",
      "applicationLocation": {
        "@odata.type": "#microsoft.graph.policyLocationApplication",
        "value": "<APP_CLIENT_ID>"
      }
    },
    "integratedAppMetadata": {
      "name": "Agent Warden",
      "version": "0.2.0"
    }
  }
}
```

### 4.3 Response

```jsonc
{
  "policyActions": [
    // Empty array = ALLOWED
    { "action": "restrictAccess", "restrictionAction": "block" },
    { "action": "restrictWebGrounding" }
  ],
  "processingErrors": []
}
```

### 4.4 Activity Types

| Activity | Direction | Used In |
|----------|-----------|---------|
| `uploadText` | User → Agent (inbound) | L1 (input scan) |
| `downloadText` | Agent → User (outbound) | L4 (output enforcement) |

### 4.5 Error Handling

| Scenario | Behavior |
|----------|----------|
| `processContent` returns HTTP 2xx, empty `policyActions` | **ALLOWED** |
| `processContent` returns HTTP 2xx, has block actions | **BLOCKED** (enforce mode) or **LOGGED** (audit mode) |
| `processContent` returns HTTP 4xx/5xx | **FAIL-OPEN** (allowed with error logged) |
| Network timeout (>5s) | **FAIL-OPEN** (allowed with timeout logged) |
| No E5 license on target user | API returns error → **FAIL-OPEN** |
| No DLP policies configured | Returns empty `policyActions` → **ALLOWED** |

### 4.6 Performance Optimizations

| Optimization | Description |
|-------------|-------------|
| **Content hash cache** | Cache `processContent` result by SHA-256(content) for 60s. Avoids re-scanning identical content |
| **Size threshold** | Skip Purview for content < 10 chars (too short to contain sensitive data) |
| **Truncation** | Truncate content > 50KB (API limit). Set `isTruncated: true` |
| **Local pre-screen** | Only call Purview if local regex detects potential sensitive data (optional, reduces API calls but may miss ML-detected patterns) |
| **Token caching** | Cache access token until 60s before expiry |
| **Batching** | Future: batch multiple content entries in a single `processContent` call via the `contentEntries` array |

---

## 5. Plugin Configuration

### 5.1 Plugin `config.json` Schema (v0.4.0)

```jsonc
{
  "mode": "enforce",           // "enforce" | "block" | "audit" ("block" maps to enforce)
  "layers": {
    "promptGuard": true,       // L1: before_agent_start
    "outputScanner": true,     // L2: tool_result_persist + L2b: message_sending (enforce only)
    "inputAudit": true         // L3: message_received
  },
  "purview": {
    "enabled": true,
    "appName": "Agent Warden",
    "appVersion": "0.4.0",
    "userId": "<E5-licensed-user-object-id>",
    "crossTenant": true
  }
}
```

### 5.2 Helm Values

```yaml
purviewDlpPlugin:
  enabled: true
  mode: "enforce"             # enforce | audit
  layers:
    promptGuard: true          # L1: before_agent_start
    outputScanner: true        # L2 + L2b (enforce only)
    inputAudit: true           # L3: message_received
  purviewEnabled: true
  purviewUserId: "<E5-user-object-id>"
  purviewTenantId: "2cf24558-0d31-439b-9c8d-6fdce3931ae7"
  image:
    repository: acragentwardendev.azurecr.io/purview-dlp-plugin
    tag: "0.4.0"
    pullPolicy: Always
```

---

## 6. Deployment Architecture

### 6.1 Plugin Installation into OpenClaw Pod

The plugin is installed via an **init container** that copies plugin files into the gateway's state volume:

```
┌──────────────────────────────────────────────┐
│ Pod: openclaw-demo-tenant-0                  │
│                                              │
│  Init: install-purview-dlp-plugin            │
│  ┌────────────────────────────────────────┐  │
│  │ Copy plugin → /data/state/plugins/     │  │
│  │ Write config.json from Helm values     │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Container: openclaw-gateway                 │
│  ┌────────────────────────────────────────┐  │
│  │ Loads plugin from /data/state/plugins/ │  │
│  │ Plugin registers hooks: L1, L2, L2b, L3│  │
│  │ Auto-configures Telegram streaming     │  │
│  │ Env: PURVIEW_DLP_CLIENT_ID             │  │
│  │      PURVIEW_DLP_CLIENT_SECRET         │  │
│  │      PURVIEW_DLP_TENANT_ID             │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Container: litellm-proxy                    │
│  ┌────────────────────────────────────────┐  │
│  │ localhost:4000 (OpenAI → Azure OpenAI) │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

### 6.2 Secret Flow

```
Key Vault (kv-demo-tenant)           AKS Pod
  │                                     │
  │ PURVIEW-DLP-CLIENT-ID              │
  │ PURVIEW-DLP-CLIENT-SECRET          │
  │                                     │
  └──── SecretProviderClass ──────────▶ │ /mnt/secrets/
        (Workload Identity)             │ → env vars via
                                        │   secretKeyRef
```

---

## 7. Data Flow — Full Request Lifecycle (v0.4.0 Enforce Mode)

```
User sends message via Telegram (streaming OFF)
         │
         ▼
L3: message_received (async, void)
    ├─ Purview processContent("uploadText") → log result
    └─ Cannot block (void hook) — audit only
    │
    ▼
L1: before_agent_start (async, modifying)
    └─ Inject DLP security policy into prependContext
    │
    ▼
OpenClaw builds prompt → sends to LLM (via LiteLLM sidecar)
    │
    ▼
LLM responds with tool call (e.g. exec: cat report.txt)
    │
    ▼
Tool executes → returns result (contains PII)
    │
    ▼
L2: tool_result_persist (SYNC, modifying)
    ├─ processContentSync(content, "uploadText") via spawnSync+curl
    ├─ If BLOCKED: replace message.content with redaction notice
    └─ Returns { message: redactedMessage } synchronously
    │
    ▼
LLM generates final response (sees redacted tool output + DLP policy)
    │
    ▼
L2b: message_sending (async, modifying) — LAST LINE OF DEFENSE
    ├─ processContent(content, "uploadText") via async fetch
    ├─ If BLOCKED: replace content with DLP block notice
    ├─ Skip if content starts with "[Agent Warden DLP]"
    └─ Returns { content: "..blocked.." } or undefined
    │
    ▼
Message delivered to user via Telegram sendMessage
```

**Audit Mode Flow:** Same as above except:
- L2 is async (return value ignored), logs `would BLOCK` instead of redacting
- L2b is not registered (streaming ON → `message_sending` bypassed anyway)
- PII may reach the user (L1 prompt guard still active as soft defense)

---

## 8. Known Issues and Resolutions

### 8.1 tool_result_persist Async Bug (Resolved in v0.4.0)

**Problem:** The `tool_result_persist` hook is **synchronous** — async handlers' return values are silently ignored with a warning:
> `tool_result_persist handler from agent-warden-purview-dlp returned a Promise; this hook is synchronous and the result was ignored.`

**Resolution:** In enforce mode, L2 uses `processContentSync()` which calls `spawnSync('curl', ...)` to make a **blocking** HTTP call to the Purview API. This keeps the handler synchronous while still performing a real Purview DLP evaluation. In audit mode, an async handler is used (return value intentionally ignored — we only need logging).

### 8.2 `message_sending` Bypassed by Telegram Streaming (Resolved in v0.4.0)

**Problem:** The `message_sending` hook fires via `deliverOutboundPayloadsCore`, but Telegram streaming preview uses `deliverReplies` → `editMessageTelegram` which **completely bypasses** the hook.

**Resolution:** Enforce mode auto-sets `streaming: "off"` in `/data/state/openclaw.json` at plugin startup. This forces Telegram delivery through `deliverOutboundPayloadsCore` where `message_sending` fires. Audit mode keeps `streaming: "partial"` for better UX (L2b not needed).

### 8.3 `message_received` Cannot Block

**Status:** By design. L3 is an audit/logging layer. Enforcement happens at L2 (tool output redaction) and L2b (outbound message blocking).

---

## 9. Prerequisites

| # | Requirement | Status |
|---|------------|--------|
| 1 | E5 tenant app registration with `Content.DLP.Process.All` permission | ✅ Exists (`d94c93dd`) |
| 2 | Admin consent granted in E5 tenant | ✅ Done |
| 3 | E5-licensed user Object ID configured as `purviewUserId` | ✅ `7ade9412-3a6e-4b37-a3a8-51d8f81de596` |
| 4 | DLP policies created in Purview compliance portal | ✅ "Agent Warden - Block PII" (CC min 85, SSN min 75) |
| 5 | Client secret stored in Key Vault | ✅ In `kv-demo-tenant` |
| 6 | Plugin container image built and pushed to ACR | ✅ `purview-dlp-plugin:0.4.0` |
| 7 | Helm values updated with cross-tenant config | ✅ `values-demo-tenant.yaml` |

---

## 10. Implementation Phases

### Phase 1: Core Implementation ✅ Complete (v0.1.0 → v0.4.0)

1. ✅ L1 prompt guard (before_agent_start)
2. ✅ L2 output scanner — sync Purview via spawnSync+curl (enforce), async log-only (audit)
3. ✅ L2b response scanner (message_sending) — enforce mode, requires streaming OFF
4. ✅ L3 input audit (message_received)
5. ✅ Cross-tenant auth (ClientSecretCredential to E5 tenant)
6. ✅ Dual-mode support (enforce/audit) with auto-streaming configuration
7. ✅ E2E tested: enforce mode blocks PII (L2+L2b), audit mode logs only

### Phase 2: Production Hardening (Next)

1. Switch to Federated Identity Credential (eliminate client secret)
2. Add L5 tool gating (`before_tool_call`)
3. Add content hash caching (avoid re-scanning identical content)
4. Add Prometheus metrics (scan count, block count, latency)
5. Add Cosmos DB audit log for DLP events
6. Add DLP strike tracking (block tools after N violations)

### Phase 3: Advanced Features (Future)

1. Batched `processContent` calls (multiple content entries)
2. Custom SIT definitions for API keys, credentials
3. Per-tenant DLP policy configuration
4. Sensitivity label application on session transcripts
5. Integration with Sentinel for automated incident response
