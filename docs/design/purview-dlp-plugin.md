# Purview DLP Plugin — Cross-Tenant Architecture

> **Status:** Validated (E2E tested)  
> **Date:** 2026-04-02 (updated from 2026-03-17)  
> **Version:** v0.5.5  
> **Depends on:** OpenClaw v2026.3.12 plugin hooks, Microsoft Purview processContent + protectionScopes + contentActivities APIs (GA)

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
| **`enforce`** (default) | OFF | executionMode-driven: evaluateInline → sync (`spawnSync`+`curl`), evaluateOffline → async, none → contentActivities log only | Active — blocks outbound PII + taint tracking | Production |
| **`audit`** | ON (partial) | Always async Purview, log only; no scope → contentActivities | Not registered | Monitoring |

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
| `message_received` | async, parallel | No (void) | **L3: Input Audit** | Cannot block delivery; taints thread in enforce mode |
| `before_agent_start` | async, sequential | Yes: `{ prependContext }` | **L1: Prompt Guard** | Injects DLP system policy |
| `tool_result_persist` | **SYNC**, sequential | Yes: `{ message }` | **L2: Output Scanner** | executionMode-driven: evaluateInline → sync, evaluateOffline → async, none → contentActivities |
| `message_sending` | async, sequential (`runModifyingHook`) | Yes: `{ content, cancel }` | **L2b: Response Scanner** | Enforce only. Checks taint from L2/L3. **Bypassed by Telegram streaming preview** |
| `before_tool_call` | async, sequential | Yes: `{ block, blockReason }` | — (future L5) | Tool gating after DLP violations |

> **Critical discovery:** `message_sending` fires via `deliverOutboundPayloadsCore` but is **bypassed** by Telegram's streaming path (`deliverReplies` → `editMessageTelegram`). Enforce mode must set `streaming: "off"` for L2b to work.

### 3.2 v0.5.5 Layer Architecture (Implemented)

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
│   • enforce+evaluateInline: spawnSync+curl (SYNC) → redact   │
│   • enforce+evaluateOffline: async scan, log+redact          │
│   • enforce+none: log via contentActivities, skip scan       │
│   • audit: async log only (return ignored)                   │
│         │                                                    │
│         ▼                                                    │
│   L2b: Response Scanner (message_sending)  ──► Purview API   │
│   • enforce only (requires streaming OFF)    (uploadText)    │
│   • Checks L2/L3 taint — blocks if thread tainted           │
│   • Replaces outbound PII with DLP notice                    │
│   • Skips own "[Agent Warden DLP]" messages                  │
│         │                                                    │
│         ▼                                                    │
│   Telegram sendMessage                                       │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 Layer Details (v0.5.5 — Implemented)

#### L1: Prompt Guard (`before_agent_start` — async, sequential, modifying)

- **When:** Before building the LLM prompt
- **Action:** Inject a DLP security policy into `prependContext` instructing the LLM to never output PII, credit card numbers, SSNs, credentials
- **Enforcement:** Modifies agent context. LLM self-censors based on injected policy
- **Purview activity:** None (no API call — static policy injection)
- **Returns:** `{ prependContext: string }`
- **Always active** regardless of Purview availability

#### L2: Output Scanner (`tool_result_persist` — executionMode-driven)

- **When:** Before persisting a tool's result into conversation history
- **executionMode resolution:** Calls `purview.getExecutionMode("uploadText")` against cached `protectionScopes/compute` results:
  - **`evaluateInline`**: Synchronous handler calls `processContentSync()` using `spawnSync('curl', ...)` for a blocking HTTP call. If Purview returns `restrictAccess`, replaces tool output with `[Agent Warden DLP] Content redacted`. Taints thread for L2b.
  - **`evaluateOffline`**: Async handler calls `processContent()` via `fetch`. Logs `would BLOCK` for violations (enforce mode) or logs only (audit mode).
  - **`none`** (no scopes apply): Logs activity via `contentActivities` API for audit compliance. Skips DLP scanning.
- **Taint tracking:** On block, taints the conversation thread. L2b will block the outbound response unconditionally for tainted threads (since the LLM already saw raw content before `tool_result_persist` fires).
- **Purview activity:** `uploadText` (both processContent and contentActivities)
- **Returns (enforce+inline):** `{ message: redactedMessage }` (synchronously)
- **Content extraction:** Handles string content, `[{type: "text", text: "..."}]` arrays, and raw message objects

#### L2b: Response Scanner (`message_sending` — async, sequential, modifying) — **Enforce only**

- **When:** Before sending an LLM response to the user via Telegram
- **Taint check:** If L2 or L3 tainted this thread, blocks **unconditionally** without calling Purview (the raw content already reached the LLM). Clears taint after blocking.
- **executionMode resolution:** If not tainted, resolves executionMode for `uploadText`:
  - **`none`**: Logs via `contentActivities` API, passes through
  - Otherwise: Calls `processContent()` via async fetch
- **Enforcement:** If Purview returns `restrictAccess` or `block`: replaces `content` with DLP block notice
- **Skip condition:** Messages starting with `[Agent Warden DLP]` are skipped
- **Purview activity:** `uploadText`
- **Returns:** `{ content: "..blocked.." }` or `undefined` (passthrough)
- **CRITICAL:** Only fires when Telegram streaming is OFF. The `message_sending` hook is dispatched via `deliverOutboundPayloadsCore` which is **bypassed** by Telegram's streaming preview path (`deliverReplies` → `editMessageTelegram`). The plugin auto-sets `streaming: "off"` in enforce mode.
- **Not registered** in audit mode (no blocking needed, streaming ON for UX)

#### L3: Input Audit (`message_received` — async, void, parallel)

- **When:** Every inbound user message
- **executionMode resolution:** Same as L2 — `none` → contentActivities log only
- **Enforcement:** Cannot block (void hook). Logs BLOCKED/ALLOWED for audit trail
- **Taint tracking (v0.5.5):** In enforce mode, if Purview returns blocked, **taints the thread** so L2b will block the outbound response. This prevents the LLM from echoing sensitive user input back.
- **Purview activity:** `uploadText`
- **Always active** in both enforce and audit modes

#### Future: L5 Tool Gating (`before_tool_call`)

- Not yet implemented. Would block high-risk tools (shell exec, file write) after DLP violations

---

## 4. Purview Graph API Integration

The plugin uses three Purview Data Security and Governance APIs:

| API | Purpose | When Called |
|-----|---------|-------------|
| `protectionScopes/compute` | Determine which activities need inline vs offline evaluation | Plugin startup + cached 60min |
| `processContent` | Evaluate content against DLP policies | L2, L2b, L3 when executionMode ≠ none |
| `contentActivities` | Log activity for audit/anomaly detection | All layers when executionMode = none |

> **Purview Audit Trail:** These API calls generate **"AI Interaction" / "Connected AI App Interaction"** entries in the Purview Activity Explorer automatically.

### 4.1 API Endpoints

```
POST /users/{userId}/dataSecurityAndGovernance/protectionScopes/compute
POST /users/{userId}/dataSecurityAndGovernance/processContent
POST /users/{userId}/dataSecurityAndGovernance/activities/contentActivities
```

Base: `https://graph.microsoft.com/v1.0`
- `{userId}`: An E5-licensed user's Object ID in the E5 tenant
- Auth: Bearer token from E5 tenant app registration

### 4.1.1 protectionScopes/compute

Determines which activities require inline vs offline DLP evaluation for the given application location.

```jsonc
// Request
{
  "activities": "uploadText,downloadText",
  "locations": [
    {
      "@odata.type": "microsoft.graph.policyLocationApplication",
      "value": "<APP_CLIENT_ID>"
    }
  ]
}

// Response
{
  "value": [
    {
      "activities": "uploadText,downloadText",
      "executionMode": "evaluateInline",  // or "evaluateOffline"
      "policyActions": [...]
    }
  ]
}
```

- Cached for 60 minutes (per API recommendation)
- Returns ETag header — passed as `If-None-Match` in subsequent `processContent` calls
- Response includes `protectionScopeState: "modified"` when policies change → triggers cache invalidation

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
      "version": "0.5.5",
      "applicationLocation": {
        "@odata.type": "#microsoft.graph.policyLocationApplication",
        "value": "<APP_CLIENT_ID>"
      }
    },
    "integratedAppMetadata": {
      "name": "Agent Warden",
      "version": "0.5.5"
    }
  }
}
```

**Conversation context (v0.5.5):** Each call includes a `correlationId` (unique per chat thread) and incrementing `sequenceNumber` (per message in thread). The `ConversationTracker` class maintains these across the conversation lifecycle.

### 4.3 Response

```jsonc
{
  "policyActions": [
    // Empty array = ALLOWED
    { "action": "restrictAccess", "restrictionAction": "block" },
    { "action": "restrictWebGrounding" }
  ],
  "processingErrors": [],
  "protectionScopeState": "unchanged"  // or "modified" → invalidate scope cache
}
```

### 4.4 Activity Types

| Activity | Direction | Used In |
|----------|-----------|---------|
| `uploadText` | User → Agent (inbound) | L2, L2b, L3 (all layers use uploadText — see note) |
| `downloadText` | Agent → User (outbound) | Reserved (not currently used — Entra enforcement plane does not support downloadText restrictions) |

> **Note (v0.5.5):** All layers use `uploadText` because the Entra enforcement plane does not support `downloadText` restrictions. The DLP policy evaluates content identically regardless of activity type.

### 4.4.1 contentActivities API (v0.5.5)

When `executionMode = "none"` (no protection scopes apply), activities are still logged via the `contentActivities` endpoint for audit compliance and anomaly detection:

```
POST /users/{userId}/dataSecurityAndGovernance/activities/contentActivities
```

The request body is similar to `processContent` but omits the `content.data` field (metadata only). This generates audit records in Purview Activity Explorer without performing DLP evaluation.

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
| **Protection scope caching** | Cache `protectionScopes/compute` result for 60 minutes with ETag. Avoids redundant scope lookups |
| **executionMode routing** | Skip `processContent` entirely when `executionMode = "none"` — log via lightweight `contentActivities` instead |
| **Size threshold** | Skip Purview for content < 10 chars (too short to contain sensitive data) |
| **Truncation** | Truncate content > 50KB (API limit). Set `isTruncated: true` |
| **Token caching** | Cache access token until 60s before expiry |
| **ETag propagation** | Pass cached scope ETag in `If-None-Match` header on `processContent` calls |
| **protectionScopeState** | When `processContent` returns `protectionScopeState: "modified"`, invalidate scope cache and re-compute on next call |
| **Batching** | Future: batch multiple content entries in a single `processContent` call via the `contentEntries` array |

---

## 5. Plugin Configuration

### 5.1 Plugin `config.json` Schema (v0.5.5)

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
    "appVersion": "0.5.5",
    "userId": "<E5-licensed-user-object-id>",
    "appId": "<Entra-app-registration-client-id>",  // Used for policyLocationApplication
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
    tag: "0.5.5"
    pullPolicy: Always
```

### 5.3 Required API Permissions (v0.5.5)

| Permission | Type | Used By |
|------------|------|--------|
| `InformationProtectionPolicy.Read.All` | Application | `protectionScopes/compute` |
| `Content.DLP.Process.All` | Application | `processContent`, `contentActivities` |

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

## 7. Data Flow — Full Request Lifecycle (v0.5.5 Enforce Mode)

```
User sends message via Telegram (streaming OFF)
         │
         ▼
L3: message_received (async, void)
    ├─ Resolve executionMode via protectionScopes cache
    ├─ none → log via contentActivities, skip scan
    ├─ Purview processContent("uploadText") → log result
    ├─ If BLOCKED: taint thread (L2b will block outbound)
    └─ Cannot block (void hook) — audit only
    │
    ▼
L1: before_agent_start (async, modifying)
    └─ Inject DLP security policy into prependContext
    │
    ▼
OpenClaw builds prompt → sends to LLM (via LiteLLM)
    │
    ▼
LLM responds with tool call (e.g. exec: cat report.txt)
    │
    ▼
Tool executes → returns result (contains PII)
    │
    ▼
L2: tool_result_persist (executionMode-driven)
    ├─ Resolve executionMode via protectionScopes cache
    ├─ evaluateInline: processContentSync via spawnSync+curl (SYNC)
    │   ├─ If BLOCKED: redact content + taint thread
    │   └─ Returns { message: redactedMessage } synchronously
    ├─ evaluateOffline: processContent via async fetch (log+flag)
    ├─ none: log via contentActivities, skip scan
    └─ Log to contentActivities (fire-and-forget)
    │
    ▼
LLM generates final response (sees redacted tool output + DLP policy)
    │
    ▼
L2b: message_sending (async, modifying) — LAST LINE OF DEFENSE
    ├─ Check taint: if thread tainted by L2/L3, block unconditionally
    ├─ Resolve executionMode → none: log via contentActivities
    ├─ processContent(content, "uploadText") via async fetch
    ├─ If BLOCKED: replace content with DLP block notice
    ├─ Skip if content starts with "[Agent Warden DLP]"
    └─ Returns { content: "..blocked.." } or undefined
    │
    ▼
Message delivered to user via Telegram sendMessage
```

**Audit Mode Flow:** Same as above except:
- All layers resolve executionMode the same way (protectionScopes cache)
- L2 is async (return value ignored), logs `would BLOCK` instead of redacting
- L2b is not registered (streaming ON → `message_sending` bypassed anyway)
- L3 does not taint threads (no enforcement)
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

### 8.4 Applications Workload DLP Policy — "Location is invalid" (Resolved 2026-04-15)

**Problem:** When creating or modifying a DLP policy to include a custom Entra-registered app (e.g., `d94c93dd`), `Set-DlpCompliancePolicy` returned **"Location is invalid"** and `New-DlpCompliancePolicy` failed with various errors depending on the approach.

**Root Cause:** The `-Locations` JSON was missing `LocationSource:"Entra"` and `LocationType:"Individual"`. These fields tell the DLP system that the `Location` value is an Entra-registered enterprise app ID — not a first-party Microsoft app like M365 Copilot. Without them, the system cannot resolve the app ID and rejects it.

**Key Constraints Discovered:**

| # | Constraint | Error if violated |
|---|-----------|-------------------|
| 1 | `Applications` workload **cannot** be combined with Exchange/SharePoint/OneDriveForBusiness — requires a **separate** policy | *"DLP Policy if configured for Applications workload, can only have Applications workload"* |
| 2 | `-Locations` JSON **must** include `"LocationSource":"Entra"` and `"LocationType":"Individual"` for custom Entra app IDs | *"Location is invalid"* |
| 3 | `-EnforcementPlanes` must be `@("Entra")` for custom apps (`CopilotExperiences` is only for the first-party M365 Copilot app `470f2276`) | *"Only CopilotExperiences supported for M365Copilot"* |
| 4 | `-BlockAccess` is **not supported** for the Applications workload | *"BlockAccess action is not allowed for Applications workload"* |
| 5 | `-RestrictAccess` requires a `Hashtable[]` format: `@(@{setting="UploadText";value="Block"})` — not a string array | Type conversion error |
| 6 | Use `Inclusions` for `New-DlpCompliancePolicy`, `AddInclusions` for `Set-DlpCompliancePolicy` | *"Could not find member 'AddInclusions'"* (on New-) |

**Correct Format (from Microsoft Learn `New-DlpComplianceRule` Example 4):**

```powershell
$locations = '[{
  "Workload":            "Applications",
  "Location":            "d94c93dd-3c80-4f3d-9671-8b71a7dccafa",
  "LocationDisplayName": "Agent Warden Purview DLP",
  "LocationSource":      "Entra",
  "LocationType":        "Individual",
  "Inclusions":          [{"Type":"Tenant","Identity":"All"}]
}]'

New-DlpCompliancePolicy -Name "Agent Warden - Entra DLP" `
  -Mode Enable `
  -Locations $locations `
  -EnforcementPlanes @("Entra")

New-DlpComplianceRule -Name "Block PII via Entra App" `
  -Policy "Agent Warden - Entra DLP" `
  -ContentContainsSensitiveInformation @(
    @{Name="Credit Card Number"; minCount="1"},
    @{Name="U.S. Social Security Number (SSN)"; minCount="1"}
  ) `
  -RestrictAccess @(@{setting="UploadText"; value="Block"})
```

**Resolution:** Created a separate "Agent Warden - Entra DLP" policy (GUID `1cb19044`) with the correct Locations JSON on tenant `dab94ed2`. The existing "Agent Warden - Block PII" policy remains for Exchange/SharePoint/OneDrive workloads.

---

## 9. Prerequisites

| # | Requirement | Status |
|---|------------|--------|
| 1 | E5 tenant app registration with `Content.DLP.Process.All` permission | ✅ Exists (`d94c93dd`) |
| 2 | Admin consent granted in E5 tenant | ✅ Done |
| 3 | E5-licensed user Object ID configured as `purviewUserId` | ✅ `7ade9412-3a6e-4b37-a3a8-51d8f81de596` |
| 4 | DLP policies created in Purview compliance portal | ✅ "Agent Warden - Block PII" (Exchange/SPO/OD4B) + "Agent Warden - Entra DLP" (Applications workload, `1cb19044`) |
| 5 | Client secret stored in Key Vault | ✅ In `kv-demo-tenant` |
| 6 | Plugin container image built and pushed to ACR | ✅ `purview-dlp-plugin:0.5.5` |
| 7 | Helm values updated with cross-tenant config | ✅ `values-demo-tenant.yaml` |

---

## 10. Implementation Phases

### Phase 1: Core Implementation ✅ Complete (v0.1.0 → v0.5.5)

1. ✅ L1 prompt guard (before_agent_start)
2. ✅ L2 output scanner — executionMode-driven: sync (evaluateInline), async (evaluateOffline), contentActivities (none)
3. ✅ L2b response scanner (message_sending) — enforce mode, requires streaming OFF
4. ✅ L3 input audit (message_received) with taint tracking in enforce mode
5. ✅ Cross-tenant auth (ClientSecretCredential to E5 tenant)
6. ✅ Dual-mode support (enforce/audit) with auto-streaming configuration
7. ✅ protectionScopes/compute with ETag caching + protectionScopeState handling
8. ✅ contentActivities API for audit logging when no scopes apply
9. ✅ Conversation tracking (correlationId per thread + sequenceNumber)
10. ✅ Taint tracking: L2→L2b and L3→L2b block chains
11. ✅ E2E tested: enforce mode blocks PII (L2+L2b), audit mode logs only

### Phase 2: Production Hardening (Next)

1. Switch to Federated Identity Credential (eliminate client secret)
2. Add L5 tool gating (`before_tool_call`)
3. Add content hash caching (avoid re-scanning identical content)
4. Add Prometheus metrics (scan count, block count, latency)
5. Add Cosmos DB audit log for DLP events
6. Add DLP strike tracking (block tools after N violations)
7. Replace `spawnSync+curl` with native sync HTTP (when Node.js supports it)

### Phase 3: Advanced Features (Future)

1. Batched `processContent` calls (multiple content entries)
2. Custom SIT definitions for API keys, credentials
3. Per-tenant DLP policy configuration
4. Sensitivity label application on session transcripts
5. Integration with Sentinel for automated incident response
