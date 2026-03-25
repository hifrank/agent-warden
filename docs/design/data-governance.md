# Data Governance Design — Agent Warden + OpenClaw

## 1. Problem Statement

OpenClaw agents interact with multiple data sources (Google Workspace, Microsoft 365, Salesforce, GitHub) via the SaaS Auth Proxy, send/receive data through LLMs, and execute tools in sandboxes. Today we have DLP scanning (Purview plugin) and SaaS path-level policies, but **no unified visibility** into:

- What data the agent **read** from which SaaS provider, and when
- What data flowed **into the LLM** (and what came back)
- What data the agent **wrote back** to SaaS providers (or exported elsewhere)
- Full **lineage**: source → agent processing → LLM enrichment → destination
- **Who authorized** what access, and whether delegated scopes are actually used

## 2. Current State — What We Already Have

| Layer | Component | What It Captures | Gap |
|---|---|---|---|
| **DLP** | Purview DLP Plugin (L1/L2/L3) | Sensitive data detection in messages + tool output | No data lineage; audit-only on inbound (can't block) |
| **SaaS Access Control** | SaaS Auth Proxy :9090 | Provider, method, path, statusCode, durationMs, blocked | No response content metadata; no read-vs-write semantics; no data classification |
| **Sandbox Telemetry** | sandbox-monitor | Process tree, syscalls, filesystem, network, risk score | Captures tool behavior, not data content |
| **Platform Audit** | Cosmos DB `audit` container | DLP scan results, tenant lifecycle events | Fragmented — not correlated into lineage |
| **Infrastructure** | Log Analytics + Sentinel | K8s audit, container logs, Azure resource logs | Raw logs, no app-level data flow context |

## 3. Target State — Data Governance Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Data Governance Stack                            │
│                                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐ │
│  │ L1: Activity │  │ L2: Data     │  │ L3: Access   │  │ L4: Compliance│ │
│  │    Ledger    │  │   Lineage    │  │  Governance  │  │   Reporting   │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘  └──────┬───────┘ │
│         │                │                  │                │          │
│  ┌──────▼──────────────────────────────────────────────────────────┐   │
│  │                   Cosmos DB: governance container               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│         │                │                  │                │          │
│  ┌──────▼────┐  ┌───────▼──────┐  ┌───────▼──────┐  ┌─────▼────────┐ │
│  │ SaaS Proxy │  │ DLP Plugin   │  │ MCP Server   │  │ Log Analytics │ │
│  │ (enhanced) │  │ (existing)   │  │ (new tools)  │  │ + Sentinel    │ │
│  └────────────┘  └──────────────┘  └──────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. L1: Activity Ledger — Every Data Interaction Logged

### 4.1 What to capture

Every SaaS API call logged as a **`data.activity`** event with enriched metadata:

```typescript
interface DataActivity {
  // Identity
  id: string;                     // unique event ID
  tenantId: string;
  sessionId: string;              // OpenClaw conversation session
  timestamp: string;              // ISO 8601

  // What happened
  operation: "read" | "write" | "delete" | "list" | "search";
  provider: string;               // "google" | "graph" | "sfdc" | "slack" | "github"
  apiPath: string;                // /calendar/v3/events, /v1.0/me/messages
  httpMethod: string;             // GET, POST, PUT, DELETE, PATCH

  // Data characterization (from response metadata, NOT content)
  resource: string;               // "calendar.event" | "mail.message" | "drive.file" ...
  resourceId?: string;            // ID of the specific resource accessed
  resourceName?: string;          // Human-readable name (file title, email subject line — first 50 chars)
  itemCount?: number;             // Number of items returned (list operations)
  byteSize?: number;              // Response content-length

  // Context
  triggeredBy: "agent" | "tool" | "skill";
  toolName?: string;              // Which OpenClaw tool triggered this
  skillName?: string;             // Which skill context
  userMessageId?: string;         // Trace back to the user request that caused this

  // Outcome
  statusCode: number;
  durationMs: number;
  blocked: boolean;
  blockReason?: string;

  // DLP (populated async if Purview scan runs on response)
  dlpScanned: boolean;
  dlpResult?: "allowed" | "blocked" | "redacted";
  sensitiveTypesFound?: string[];
}
```

### 4.2 Where to implement — Enhanced SaaS Proxy

The SaaS Auth Proxy already intercepts every outbound request. Enhance it to:

1. **Classify the operation** — Map `(provider, method, path)` → `(operation, resource)` using a route classification table
2. **Extract response metadata** — Capture `Content-Length`, item counts from list responses (parse JSON array length), resource IDs from URLs
3. **Write to Cosmos DB** — Append `data.activity` events to the `governance` container (partition key: `tenantId`)
4. **Correlate with session** — Pass `X-Session-Id` and `X-Tool-Name` headers from OpenClaw gateway to the SaaS proxy

### 4.3 Route Classification Table (Google Workspace example)

```typescript
const ROUTE_CLASSIFICATIONS: RouteClassification[] = [
  // Google Calendar
  { provider: "google", pathPattern: /^\/calendar\/v3\/calendars\/[^/]+\/events$/, method: "GET",  operation: "list",   resource: "calendar.event" },
  { provider: "google", pathPattern: /^\/calendar\/v3\/calendars\/[^/]+\/events\/[^/]+$/, method: "GET",  operation: "read",   resource: "calendar.event" },
  { provider: "google", pathPattern: /^\/calendar\/v3\/calendars\/[^/]+\/events$/, method: "POST", operation: "write",  resource: "calendar.event" },
  { provider: "google", pathPattern: /^\/calendar\/v3\/calendars\/[^/]+\/events\/[^/]+$/, method: "PUT",  operation: "write",  resource: "calendar.event" },
  { provider: "google", pathPattern: /^\/calendar\/v3\/calendars\/[^/]+\/events\/[^/]+$/, method: "DELETE", operation: "delete", resource: "calendar.event" },

  // Google Drive
  { provider: "google", pathPattern: /^\/drive\/v3\/files$/, method: "GET",  operation: "list",   resource: "drive.file" },
  { provider: "google", pathPattern: /^\/drive\/v3\/files\/[^/]+$/, method: "GET",  operation: "read",   resource: "drive.file" },
  { provider: "google", pathPattern: /^\/drive\/v3\/files\/[^/]+\/export$/, method: "GET",  operation: "read",   resource: "drive.file.export" },
  { provider: "google", pathPattern: /^\/upload\/drive\/v3\/files$/, method: "POST", operation: "write",  resource: "drive.file" },
  { provider: "google", pathPattern: /^\/drive\/v3\/files\/[^/]+$/, method: "PATCH", operation: "write", resource: "drive.file" },
  { provider: "google", pathPattern: /^\/drive\/v3\/files\/[^/]+$/, method: "DELETE", operation: "delete", resource: "drive.file" },

  // Gmail (read only by default — send is blocked by path policy)
  { provider: "google", pathPattern: /^\/gmail\/v1\/users\/[^/]+\/messages$/, method: "GET",  operation: "list",   resource: "gmail.message" },
  { provider: "google", pathPattern: /^\/gmail\/v1\/users\/[^/]+\/messages\/[^/]+$/, method: "GET",  operation: "read",   resource: "gmail.message" },
  { provider: "google", pathPattern: /^\/gmail\/v1\/users\/[^/]+\/messages\/send$/, method: "POST", operation: "write",  resource: "gmail.message.send" },

  // Google Sheets
  { provider: "google", pathPattern: /^\/v4\/spreadsheets\/[^/]+$/, method: "GET",  operation: "read",   resource: "sheets.spreadsheet" },
  { provider: "google", pathPattern: /^\/v4\/spreadsheets\/[^/]+\/values\//, method: "GET",  operation: "read",   resource: "sheets.values" },
  { provider: "google", pathPattern: /^\/v4\/spreadsheets\/[^/]+\/values\//, method: "PUT",  operation: "write",  resource: "sheets.values" },

  // Microsoft Graph
  { provider: "graph", pathPattern: /^\/v1\.0\/me\/messages$/, method: "GET",  operation: "list",   resource: "outlook.message" },
  { provider: "graph", pathPattern: /^\/v1\.0\/me\/messages\/[^/]+$/, method: "GET",  operation: "read",   resource: "outlook.message" },
  { provider: "graph", pathPattern: /^\/v1\.0\/me\/drive\//, method: "GET",  operation: "read",   resource: "onedrive.file" },
  { provider: "graph", pathPattern: /^\/v1\.0\/me\/events/, method: "GET",  operation: "list",   resource: "outlook.event" },

  // GitHub
  { provider: "github", pathPattern: /^\/repos\/[^/]+\/[^/]+\/contents\//, method: "GET",  operation: "read",   resource: "github.file" },
  { provider: "github", pathPattern: /^\/repos\/[^/]+\/[^/]+\/contents\//, method: "PUT",  operation: "write",  resource: "github.file" },
  { provider: "github", pathPattern: /^\/repos\/[^/]+\/[^/]+\/issues$/, method: "GET",  operation: "list",   resource: "github.issue" },
  { provider: "github", pathPattern: /^\/repos\/[^/]+\/[^/]+\/issues$/, method: "POST", operation: "write",  resource: "github.issue" },
];
```

---

## 5. L2: Data Lineage — Track Data Flow End-to-End

### 5.1 Lineage Model

Each user request can trigger a chain of data interactions. We track this as a **lineage trace**:

```
User Message → [LLM reasoning] → Tool Call → SaaS Read (Google Calendar)
                                            → SaaS Read (Gmail)
                                → LLM summarizes
                                → Tool Call → SaaS Write (Google Sheets)
                                → Response to User
```

This becomes a **lineage record**:

```typescript
interface DataLineage {
  id: string;
  tenantId: string;
  traceId: string;              // Correlation ID across the full chain
  sessionId: string;
  timestamp: string;

  // The user request that initiated this chain
  trigger: {
    type: "user_message" | "scheduled" | "webhook";
    messageId?: string;
    channel: string;            // "telegram" | "slack" etc.
  };

  // Ordered list of data hops
  hops: DataHop[];

  // Summary
  sourcesRead: string[];        // ["google:calendar.event", "google:gmail.message"]
  destinationsWritten: string[]; // ["google:sheets.values"]
  llmInvocations: number;
  totalDurationMs: number;
  dlpViolations: number;
}

interface DataHop {
  sequence: number;
  type: "saas_read" | "saas_write" | "llm_call" | "tool_exec" | "user_response";
  timestamp: string;
  durationMs: number;

  // For saas_read / saas_write
  provider?: string;
  resource?: string;
  resourceId?: string;
  operation?: string;
  itemCount?: number;
  byteSize?: number;

  // For llm_call
  model?: string;
  promptTokens?: number;
  completionTokens?: number;

  // For tool_exec
  toolName?: string;
  sandbox?: boolean;

  // DLP
  dlpResult?: string;
  sensitiveTypes?: string[];
}
```

### 5.2 Implementation — Trace Context Propagation

1. **OpenClaw Gateway** generates a `traceId` per inbound user message
2. Pass `X-Trace-Id` + `X-Session-Id` + `X-Tool-Name` as headers to:
   - LiteLLM proxy (→ logged with token usage metrics)
   - SaaS Auth Proxy (→ logged with data activity)
3. **New: LiteLLM callback** — Configure LiteLLM `success_callback` to emit a `data.llm` event to stdout (JSON) with: model, tokens, traceId, duration
4. **Lineage aggregator** — A background process (or MCP Server query) correlates `data.activity` + `data.llm` + `data.tool` events by `traceId` into `DataLineage` records

Trace header flow:
```
User msg → Gateway (generates traceId: "abc123")
  → LiteLLM :4000  [X-Trace-Id: abc123]     → data.llm event
  → SaaS Proxy :9090 [X-Trace-Id: abc123]    → data.activity event
  → Sandbox Pod [env TRACE_ID=abc123]         → sandbox telemetry event
```

### 5.3 Where does OpenClaw set these headers?

OpenClaw doesn't natively propagate trace headers. Two options:

**Option A: Patch via plugin hook** — Use `before_agent_start` to inject traceId into context. LiteLLM and SaaS proxy can extract session/trace from OpenClaw's internal request routing by parsing `X-Request-Id` if present.

**Option B: Sidecar injection** — A lightweight Envoy/nginx sidecar in the pod that intercepts localhost traffic between containers and injects `X-Trace-Id` headers. Higher complexity but zero OpenClaw changes.

**Recommended: Option A + OpenClaw feature request** — Start with what's available (use `message_received` hook to log a traceId, tag saas-proxy logs with session context from env vars), then request first-class trace propagation from OpenClaw.

---

## 6. L3: Access Governance — OAuth Scope & Permission Tracking

### 6.1 Problem

The SaaS proxy has OAuth tokens with broad scopes. We need to know:
- Which **scopes** are actually being used vs. granted
- Which **resources** each tenant actually accesses
- **Anomaly detection** — alert if an agent suddenly accesses resources it never accessed before

### 6.2 OAuth Scope Usage Tracking

Enhance the SaaS proxy to emit a periodic **scope usage report**:

```typescript
interface ScopeUsageReport {
  tenantId: string;
  provider: string;
  period: string;                // "2026-03-16"

  grantedScopes: string[];       // From the OAuth token
  usedScopes: string[];          // Inferred from API paths accessed
  unusedScopes: string[];        // Granted but never used (minimize!)

  resourcesAccessed: {
    resource: string;            // "calendar.event"
    readCount: number;
    writeCount: number;
    deleteCount: number;
    uniqueResourceIds: number;   // How many distinct items
  }[];

  anomalies: {
    type: "new_resource_type" | "spike_in_access" | "new_write_pattern";
    description: string;
    severity: "low" | "medium" | "high";
  }[];
}
```

### 6.3 Least-Privilege Recommendations

Based on scope usage data, the MCP Server can recommend scope reductions:

> "Tenant `demo-tenant` has `https://www.googleapis.com/auth/drive` (full Drive access) but only accesses `drive.file.read` — recommend downgrading to `https://www.googleapis.com/auth/drive.readonly`."

---

## 7. L4: Compliance Reporting — MCP Server Tools

### 7.1 New MCP Server Tools

Add governance query tools to the Agent Warden MCP Server:

| Tool | Description |
|---|---|
| `warden.governance.activity` | Query data activity events by tenant, provider, resource, time range |
| `warden.governance.lineage` | Get lineage trace for a specific user message or session |
| `warden.governance.scope-usage` | Show OAuth scope usage report for a tenant/provider |
| `warden.governance.data-map` | Show all data sources/destinations a tenant has interacted with |
| `warden.governance.anomalies` | List access anomalies detected across tenants |
| `warden.governance.export` | Export governance data for compliance audit (CSV/JSON) |

### 7.2 Data Map View

The `data-map` tool produces a per-tenant view of all data interactions:

```
Tenant: demo-tenant
Period: 2026-03-01 to 2026-03-16

Data Sources (READ):
  ├─ Google Calendar    42 reads   (12 unique events)
  ├─ Gmail              18 reads   (18 unique messages)
  ├─ Google Sheets       6 reads   (2 spreadsheets)
  └─ GitHub Issues       3 reads   (1 repo)

Data Destinations (WRITE):
  ├─ Google Sheets       4 writes  (1 spreadsheet)
  └─ Google Calendar     2 writes  (2 events created)

LLM Usage:
  ├─ Azure OpenAI (gpt-54)  156 calls  48,230 prompt tokens  12,840 completion tokens
  └─ DLP violations: 3 (2 blocked, 1 audit-only)

No anomalies detected.
```

---

## 8. Cosmos DB Schema

### 8.1 New Container: `governance`

Partition key: `/tenantId`

Document types (distinguished by `type` field):
- `data.activity` — Individual SaaS API interaction (Section 4)
- `data.llm` — LLM invocation metadata (Section 5)
- `data.lineage` — Aggregated lineage trace (Section 5)
- `scope.usage` — Daily scope usage report (Section 6)
- `anomaly` — Detected anomaly (Section 6)

TTL policy: 90 days (configurable per tier: free=30d, pro=90d, enterprise=365d)

### 8.2 Indexing

```json
{
  "includedPaths": [
    { "path": "/tenantId/?" },
    { "path": "/type/?" },
    { "path": "/timestamp/?" },
    { "path": "/provider/?" },
    { "path": "/operation/?" },
    { "path": "/resource/?" },
    { "path": "/traceId/?" },
    { "path": "/dlpResult/?" }
  ],
  "compositeIndexes": [
    [
      { "path": "/tenantId", "order": "ascending" },
      { "path": "/type", "order": "ascending" },
      { "path": "/timestamp", "order": "descending" }
    ]
  ]
}
```

---

## 9. Implementation Phases

> **Superseded** — See §12 "Implementation Phases — Updated with Purview" for the current phased plan that includes Purview Data Map integration.

---

## 10. Architecture Diagram (Updated Data Flow with Purview Data Map)

```
                     External Channels
                   ┌─────────────────────┐
                   │ Telegram/Slack/Discord│
                   └──────────┬──────────┘
                              │ webhook
                              ▼
                   ┌──────────────────────┐
                   │   AGC (Gateway API)   │
                   └──────────┬──────────┘
                              │ HTTPRoute
          ┌───────────────────▼────────────────────────────┐
          │  Tenant Namespace (StatefulSet pod)             │
          │                                                 │
          │  ┌──────────────────────────────────────────┐  │
          │  │         OpenClaw Gateway :18789           │  │
          │  │                                          │  │
          │  │  ┌─ Purview DLP Plugin (L1/L2/L3) ────┐ │  │
          │  │  │ L3: Audit inbound → Purview DLP     │ │  │
          │  │  │ L1: Inject DLP policy to LLM context│ │  │
          │  │  │ L2: Scan tool output → redact/block │ │  │
          │  │  └────────────────┬────────────────────┘ │  │
          │  └──────┬────────────┼──────────┬───────────┘  │
          │         │            │          │               │
          │    ┌────▼────┐  ┌───▼────┐  ┌──▼─────────┐    │
          │    │ Sandbox │  │        │  │ SaaS Proxy  │    │
          │    │ (Kata)  │  │        │  │ :9090       │    │
          │    │ teleme- │  │        │  │             │    │
          │    │ try     │  │        │  │ data.activity│   │
          │    └────┬────┘  │        │  │ events      │    │
          └─────────┼───────┼────────┼──┴─────────────┘    │
                    │       │        │                      │
                    │       │        ▼                      │
  ┌─────────────────┼───────┼──────────────────────────────┼──┐
  │  agent-warden-system    │                              │  │
  │    ┌────────────────────▼──────────────────────┐       │  │
  │    │  Shared LiteLLM Proxy :4000                │       │  │
  │    │  ┌─ DataLLMCallback (custom_callback.py) ─┐│       │  │
  │    │  │ • Tenant ID via pod IP → K8s API        ││       │  │
  │    │  │ • data.llm events → stdout + Cosmos DB  ││       │  │
  │    │  │ • Token counts (prompt + completion)    ││       │  │
  │    │  └────────────────────────────────────────┘│       │  │
  │    │  RBAC: pods:list (litellm-rbac.yaml)       │       │  │
  │    └────────────────────┬──────────────────────┘       │  │
  └─────────────────────────┼──────────────────────────────┘  │
                    │       │          │
        ┌───────────▼──┐  ┌────▼──────┐  ┌▼───────────────────────┐
        │ Azure OpenAI │  │ Cosmos DB │  │ SaaS Providers         │
        │ (MI auth)    │  │governance │  │ Google · Graph · GitHub │
        └──────────────┘  │ container │  └─────────────────────────┘
                          └─────┬─────┘
                                │
                  ┌─────────────┼─────────────────┐
                  │             │                  │
        ┌─────────▼──────┐  ┌──▼───────────────┐  │
        │ Agent Warden   │  │ Purview Data Map  │  │
        │ MCP Server     │  │ (Atlas v2 API)    │  │
        │ warden.*       │  │                   │  │
        │ (Cosmos query) │  │ ┌─ Entity Catalog │  │
        └────────────────┘  │ ├─ Lineage Graph  │  │
                            │ ├─ Classification │  │
                            │ └─ Collections    │  │
                            └───────────────────┘  │
                                                   │
                            ┌──────────────────────▼──┐
                            │ Purview DLP (E5 tenant) │
                            │ processContent API      │
                            │ (cross-tenant)          │
                            └─────────────────────────┘
```

---

---

## 11. Purview Data Map Integration — Unified Governance

### 11.1 Why Purview Data Map?

The Purview account lives in the E5 tenant **ecardpoc4ecv** (`2cf24558-0d31-439b-9c8d-6fdce3931ae7`), not the platform subscription. Today we use it solely for DLP `processContent` API (via cross-tenant `ClientSecretCredential`). But Purview Data Map provides something our custom Cosmos-based governance cannot:

- **Visual data lineage** — see "Gmail message → OpenClaw agent → Google Sheet" in the Purview portal
- **Asset catalog** — every SaaS resource the agent touches becomes a discoverable, classified asset
- **Classification** — Purview auto-classifies data (PII, PHI, credentials) at the asset level
- **Sensitivity labels** — inherited from Microsoft 365 Information Protection
- **Cross-system lineage** — if Purview already scans the customer's Google Workspace or Azure resources, agent-generated lineage connects to the existing data estate

### 11.2 Architecture: Agent Warden as a Custom Data Source in Purview

Purview Data Map is built on Apache Atlas. We register **custom entity types** representing the agent ecosystem and push lineage via the Atlas v2 REST API.

```
Purview Data Map (Atlas v2 API)
├── Custom Types (registered once per Purview account)
│   ├── openclaw_tenant          (DataSet supertype)  — a tenant's agent instance
│   ├── openclaw_conversation    (DataSet supertype)  — a user conversation/session
│   ├── openclaw_agent_process   (Process supertype)  — agent processing a request
│   ├── saas_resource            (DataSet supertype)  — a specific SaaS resource (file, email, event)
│   └── llm_invocation           (Process supertype)  — LLM call (transforms data)
│
├── Entities (created/updated per data interaction)
│   ├── saas_resource: "google://drive/files/abc123" (Google Doc)
│   ├── saas_resource: "google://gmail/messages/xyz" (Gmail message)
│   ├── openclaw_agent_process: "agent://demo-tenant/trace-001" (agent run)
│   ├── llm_invocation: "llm://demo-tenant/trace-001/call-1" (GPT-4 call)
│   └── saas_resource: "google://sheets/spreadsheet/def456" (output Sheet)
│
└── Lineage (via Process inputs/outputs)
    Gmail message ──→ Agent Process ──→ Google Sheet
                         │
                         ├── LLM Invocation (gpt-54)
                         │
                         └── inputs: [Gmail], outputs: [Sheet]
```

### 11.3 Custom Type Definitions

Register once via Purview Data Map API (cross-tenant, auth with `ClientSecretCredential`):

```http
POST https://{purview-account}.purview.azure.com/datamap/api/atlas/v2/types/typedefs
Authorization: Bearer {token}   # scope: https://purview.azure.net/.default
                                 # tenant: 2cf24558-0d31-439b-9c8d-6fdce3931ae7
```

```json
{
  "entityDefs": [
    {
      "name": "openclaw_tenant",
      "description": "An OpenClaw tenant agent instance managed by Agent Warden",
      "superTypes": ["DataSet"],
      "serviceType": "Agent Warden",
      "typeVersion": "1.0",
      "attributeDefs": [
        { "name": "tier", "typeName": "string", "isOptional": true },
        { "name": "region", "typeName": "string", "isOptional": true },
        { "name": "activeChannels", "typeName": "array<string>", "isOptional": true }
      ]
    },
    {
      "name": "openclaw_conversation",
      "description": "A user conversation session with an OpenClaw agent",
      "superTypes": ["DataSet"],
      "serviceType": "Agent Warden",
      "typeVersion": "1.0",
      "attributeDefs": [
        { "name": "channel", "typeName": "string", "isOptional": true },
        { "name": "messageCount", "typeName": "int", "isOptional": true },
        { "name": "startedAt", "typeName": "string", "isOptional": true }
      ]
    },
    {
      "name": "openclaw_agent_process",
      "description": "Agent processing a user request — transforms input data to output",
      "superTypes": ["Process"],
      "serviceType": "Agent Warden",
      "typeVersion": "1.0",
      "attributeDefs": [
        { "name": "traceId", "typeName": "string", "isOptional": false },
        { "name": "toolsUsed", "typeName": "array<string>", "isOptional": true },
        { "name": "durationMs", "typeName": "long", "isOptional": true },
        { "name": "dlpViolations", "typeName": "int", "isOptional": true }
      ]
    },
    {
      "name": "llm_invocation",
      "description": "An LLM call that transforms/enriches data during agent processing",
      "superTypes": ["Process"],
      "serviceType": "Agent Warden",
      "typeVersion": "1.0",
      "attributeDefs": [
        { "name": "model", "typeName": "string", "isOptional": true },
        { "name": "promptTokens", "typeName": "long", "isOptional": true },
        { "name": "completionTokens", "typeName": "long", "isOptional": true },
        { "name": "provider", "typeName": "string", "isOptional": true }
      ]
    },
    {
      "name": "saas_resource",
      "description": "A specific resource in a SaaS provider accessed by an OpenClaw agent",
      "superTypes": ["DataSet"],
      "serviceType": "Agent Warden",
      "typeVersion": "1.0",
      "attributeDefs": [
        { "name": "provider", "typeName": "string", "isOptional": false },
        { "name": "resourceType", "typeName": "string", "isOptional": false },
        { "name": "resourceId", "typeName": "string", "isOptional": true },
        { "name": "lastAccessedAt", "typeName": "string", "isOptional": true },
        { "name": "accessCount", "typeName": "int", "isOptional": true }
      ]
    }
  ]
}
```

### 11.4 Lineage Push — How It Works

When the SaaS proxy completes a request, it writes an activity event (§4). A **lineage emitter** (in the SaaS proxy or as a background aggregator) batches these into Purview lineage:

**Example: User asks agent to "summarize my emails and put them in a spreadsheet"**

Step 1 — Agent reads Gmail messages (SaaS proxy logs `data.activity` events)
Step 2 — Agent calls LLM to summarize (LiteLLM logs `data.llm` event)
Step 3 — Agent writes to Google Sheets (SaaS proxy logs `data.activity` write event)

After the trace completes, push lineage to Purview:

```http
POST https://{purview-account}.purview.azure.com/datamap/api/atlas/v2/entity/bulk
Authorization: Bearer {token}   # same cross-tenant ClientSecretCredential
```

```json
{
  "entities": [
    {
      "typeName": "saas_resource",
      "attributes": {
        "name": "Gmail: user inbox messages",
        "qualifiedName": "agent-warden://demo-tenant/google/gmail/messages",
        "provider": "google",
        "resourceType": "gmail.message"
      }
    },
    {
      "typeName": "saas_resource",
      "attributes": {
        "name": "Google Sheet: Weekly Summary",
        "qualifiedName": "agent-warden://demo-tenant/google/sheets/spreadsheet/def456",
        "provider": "google",
        "resourceType": "sheets.spreadsheet",
        "resourceId": "def456"
      }
    },
    {
      "typeName": "llm_invocation",
      "attributes": {
        "name": "GPT-54 summarization",
        "qualifiedName": "agent-warden://demo-tenant/llm/trace-001/call-1",
        "model": "gpt-54",
        "promptTokens": 2400,
        "completionTokens": 800,
        "provider": "azure-openai",
        "inputs": [{ "typeName": "saas_resource", "uniqueAttributes": { "qualifiedName": "agent-warden://demo-tenant/google/gmail/messages" }}],
        "outputs": [{ "typeName": "saas_resource", "uniqueAttributes": { "qualifiedName": "agent-warden://demo-tenant/google/sheets/spreadsheet/def456" }}]
      }
    },
    {
      "typeName": "openclaw_agent_process",
      "attributes": {
        "name": "Agent run: summarize emails to sheet",
        "qualifiedName": "agent-warden://demo-tenant/process/trace-001",
        "traceId": "trace-001",
        "toolsUsed": ["gmail-reader", "sheet-writer"],
        "durationMs": 4500,
        "dlpViolations": 0,
        "inputs": [{ "typeName": "saas_resource", "uniqueAttributes": { "qualifiedName": "agent-warden://demo-tenant/google/gmail/messages" }}],
        "outputs": [{ "typeName": "saas_resource", "uniqueAttributes": { "qualifiedName": "agent-warden://demo-tenant/google/sheets/spreadsheet/def456" }}]
      }
    }
  ]
}
```

**Result in Purview portal:**
```
[Gmail Messages] ──→ [Agent Process: trace-001] ──→ [Google Sheet: def456]
                            │
                            └── [LLM: GPT-54 call-1]
```

### 11.5 What You See in Purview Portal — Data Map View

After lineage is pushed, the Purview portal provides:

1. **Data Map** — Visual graph of all SaaS resources the agent has ever touched, grouped by provider
   ```
   Agent Warden (custom source)
   ├── demo-tenant
   │   ├── Google Workspace
   │   │   ├── Gmail Messages (42 reads)
   │   │   ├── Google Calendar Events (18 reads, 2 writes)
   │   │   ├── Google Drive Files (6 reads)
   │   │   └── Google Sheets (4 reads, 3 writes)
   │   ├── Microsoft 365
   │   │   ├── Outlook Messages (12 reads)
   │   │   └── OneDrive Files (3 reads)
   │   └── GitHub
   │       ├── Issues (8 reads, 2 writes)
   │       └── Files (5 reads)
   └── tenant-b
       └── ...
   ```

2. **Lineage View** — Click any asset to see full lineage:
   - Where the data came from (inputs)
   - What process touched it (agent + LLM)
   - Where the data went (outputs)
   - DLP scan results on each hop

3. **Classification** — Purview auto-classifies assets that contain PII, credit cards, etc.
   - Sensitive Gmail messages get flagged
   - Google Sheets with SSNs get sensitivity labels
   - All visible in the unified Purview Data Map

4. **Search** — "Show me all assets tagged with 'Credit Card Number' that any agent accessed in the last 30 days"

### 11.6 Purview Account Setup (one-time)

**Purview is in the E5 tenant** `ecardpoc4ecv` (`2cf24558-0d31-439b-9c8d-6fdce3931ae7`).
The platform subscription does NOT contain a Purview account. All Purview API calls are cross-tenant.

What already exists:
- Purview account in E5 tenant (managed by E5 admin)
- Cross-tenant auth: multi-tenant app registration (`d94c93dd`) with `ClientSecretCredential`
- DLP plugin uses `PURVIEW_DLP_CLIENT_ID` / `PURVIEW_DLP_CLIENT_SECRET` / `PURVIEW_DLP_TENANT_ID` env vars
- Agent Warden Server `purview.ts` now auto-detects cross-tenant when `PURVIEW_DLP_TENANT_ID` is set
- Terraform `modules/purview/` outputs the endpoint URLs based on `purview_account_name` variable

What needs to be added in the E5 tenant's Purview portal:
1. **Data Curator role** — Grant the app registration (`d94c93dd`) Data Curator on the root collection (for pushing entities/lineage)
2. **Data Reader role** — Grant the app registration Data Reader (for reading catalog/lineage)
3. **Data Source Administrator** — Grant the app registration Data Source Administrator (for registering Agent Warden as a custom source)
4. **Custom type registration** — One-time API call (§11.3) during bootstrap
5. **Collection structure** — Create a collection per tenant under a root "Agent Warden" collection

Auth for Data Map API:
```
Scope:     https://purview.azure.net/.default
Tenant:    2cf24558-0d31-439b-9c8d-6fdce3931ae7
Client ID: d94c93dd-3c80-4f3d-9671-8b71a7dccafa  (multi-tenant app reg)
Auth:      ClientSecretCredential (same creds as DLP plugin)
```

### 11.7 Dual-Write: Cosmos DB + Purview

Keep the Cosmos `governance` container for fast, low-latency, per-tenant queries (MCP tools). Push to Purview asynchronously for the enterprise data map view:

```
SaaS Proxy → data.activity (stdout JSON)
    │
    ├──→ Container Insights → Log Analytics (real-time)
    │
    ├──→ Lineage Aggregator (batch by traceId)
    │        │
    │        ├──→ Cosmos governance container (low-latency queries)
    │        └──→ Purview Data Map Atlas API (enterprise catalog + lineage)
    │
    └──→ Sentinel (SIEM alerts on anomalies)
```

The lineage aggregator waits for a trace to complete (all hops for one `traceId`), then:
1. Writes a `data.lineage` doc to Cosmos (for MCP tools)
2. Pushes entities + lineage to Purview Data Map (for portal visualization)

### 11.8 Purview vs Custom Cosmos — When to Use Each

| Need | Use |
|---|---|
| Real-time query by tenant ("what did agent do in last 5 min?") | Cosmos `governance` container |
| Cross-tenant data map ("all resources across all agents") | Purview Data Map portal |
| Visual lineage graph | Purview Data Map lineage view |
| Asset classification + sensitivity labels | Purview Data Map |
| Compliance audit export | Either — Cosmos for per-tenant, Purview for enterprise |
| MCP tool responses | Cosmos (low latency, direct query) |
| Integration with existing corporate Purview catalog | Purview (assets appear alongside existing data estate) |

---

## 12. Implementation Phases — Updated with Purview

### Phase 1: Activity Ledger (SaaS Proxy Enhancement)
- Add route classification table to SaaS proxy
- Emit `data.activity` events to stdout (structured JSON)
- Create `governance` container in Cosmos DB
- Container Insights picks up logs → also available via KQL

### Phase 2: LLM Audit Trail + Tenant Attribution ✔️
- ✔️ LiteLLM custom callback (`DataLLMCallback`) emits `data.llm` events to stdout + Cosmos DB
- ✔️ Tenant ID attribution via pod IP → K8s namespace resolution (4-level fallback)
- ✔️ RBAC: `litellm-proxy-pods-reader` ClusterRole grants `pods:list` for IP resolution
- ✔️ Cosmos DB direct write via Workload Identity (federated token exchange)
- ⚠️ `X-Trace-Id` header propagation — pending OpenClaw trace support

### Phase 3: Purview Data Map Bootstrap
- Register custom type definitions (§11.3) — add to `scripts/bootstrap-azure.sh`
- Create Purview collection structure per tenant — add to operator provisioning
- Grant Platform MI Data Curator role — add to Terraform `modules/purview/main.tf`

### Phase 4: Lineage Aggregation + Purview Push
- Build lineage aggregator (CronJob or in MCP Server)
- Correlate events by `traceId` → write to Cosmos + push to Purview Atlas API
- Test lineage visualization in Purview portal

### Phase 5: Access Governance + MCP Tools
- Add scope usage tracking to SaaS proxy
- Anomaly detection (rolling baseline comparison)
- Add `warden.governance.*` tools to MCP Server
- Data map visualization through both MCP tools (Cosmos) and Purview portal

---

## 13. Security & Privacy Considerations

| Concern | Mitigation |
|---|---|
| **Logging content** | Activity ledger logs **metadata only** (path, resource type, byte size). Never log request/response bodies. Content scanning is delegated to Purview DLP. |
| **PII in resource names** | Truncate `resourceName` to 50 chars, apply Purview DLP scan before persisting if tier=enterprise. Free/pro tiers omit resourceName entirely. |
| **Cross-tenant data leakage** | Cosmos DB partition key is `tenantId`. Purview collections are per-tenant with RBAC. MCP tools enforce tenant isolation. |
| **Purview Data Map access** | Only platform MI can push entities. Tenant admins cannot read other tenants' collections. |
| **Storage costs** | Cosmos: TTL-based retention (30/90/365 days by tier). Purview: entity retention is permanent (asset catalog). Activity events are ~500 bytes each. |
| **Latency impact** | Activity logging is async. Purview push is batched (not on the hot path). Zero additional latency on user requests. |
| **Purview API limits** | Atlas bulk API accepts up to 50 entities per call. Lineage aggregator batches per trace (typically 5-15 entities). Well within limits. |
