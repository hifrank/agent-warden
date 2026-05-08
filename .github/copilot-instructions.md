# Copilot Instructions — Agent Warden

## Overview

Agent Warden is a secure multi-tenant AI agent platform hosting isolated [OpenClaw](https://github.com/pinkpixel-dev/openclaw) instances on Azure Kubernetes Service. The **Agent Warden Server** (MCP) manages the full tenant lifecycle — provisioning, identity, DLP enforcement, and cryptographic deletion.

## Architecture

The platform runs on a **2-pool AKS cluster** (system pool + tenant pool) with Azure-native security:

- **System pool** (`agent-warden-system` namespace): Agent Warden Server (MCP), K8s Operator, shared LiteLLM Proxy, OTel Collector DaemonSet
- **Tenant pool** (one namespace per tenant, `tenant-{id}`): OpenClaw gateway + DLP plugin + Agents View plugin + SaaS Auth Proxy sidecar + Heartbeat sidecar — all isolated via NetworkPolicy, ResourceQuota, and per-tenant Key Vault + Managed Identity

Traffic flows: **Entra ID → Application Gateway (WAF) → Gateway API HTTPRoute → per-tenant pod**

### Key Components

| Component | Path | Role |
|-----------|------|------|
| **MCP Server** | `agent-warden-server/` | Control plane — tenant lifecycle, identity, DLP, inventory, health tools |
| **K8s Operator** | `k8s/operator/` | Watches `OpenClawTenant` CRD, reconciles tenant namespaces |
| **Portal** | `agent-warden-portal/` | SvelteKit 2 admin dashboard (SSR via adapter-node) |
| **Purview DLP Plugin** | `agent-warden-purview-dlp/` | 6-layer DLP (L1 prompt guard → L1.5 pre-tool file/archive scan → L2 output scanner → L2b response blocker → L3 input audit) with cross-instance taint propagation via globalThis |
| **Agents View Plugin** | `agent-warden-agents-view/` | Emits GenAI OTel spans to App Insights |
| **A365 Plugin** | `agent-warden-a365/` | Microsoft Agent 365 Observability SDK integration |
| **SaaS Auth Proxy** | `agent-warden-saas-proxy/` | Per-tenant sidecar injecting OAuth tokens (agents never see credentials) |
| **Heartbeat** | `agent-warden-heartbeat/` | Per-tenant sidecar probing gateway health → OTel metrics |
| **Helm Chart** | `k8s/helm/openclaw-tenant/` | Per-tenant chart: StatefulSet, NetworkPolicy, ResourceQuota, SecretProviderClass |
| **Infra** | `infra/terraform/` | Terraform modules for AKS, VNet, Key Vault, Cosmos DB, ACR, App Gateway, Purview |

## Build, Test, and Lint

All TypeScript services use **Node.js 22+** and **pnpm 9+**. There is no root-level workspace — each subproject manages its own dependencies.

### agent-warden-server (MCP Server)

```bash
cd agent-warden-server
pnpm install
pnpm run build        # tsc
pnpm run dev          # tsx watch src/index.ts
pnpm test             # vitest run (full suite)
pnpm run test:watch   # vitest (watch mode)
pnpm run lint         # eslint src/
```

Run a single test file:

```bash
cd agent-warden-server
pnpm exec vitest run src/tools/tenant.test.ts
```

### agent-warden-portal (SvelteKit Dashboard)

```bash
cd agent-warden-portal
pnpm install
pnpm run dev          # vite dev
pnpm run build        # vite build (SSR)
pnpm run preview      # vite preview
```

### Sidecars & Plugins (heartbeat, saas-proxy, purview-dlp, agents-view, a365)

These have minimal scripts. Plugins have no build step (bundled at Docker build time). Sidecars compile with `tsc`:

```bash
cd agent-warden-heartbeat   # or agent-warden-saas-proxy
pnpm install && pnpm run build
```

### Infrastructure

```bash
cd infra/terraform
terraform init
terraform plan -var-file=environments/dev.tfvars -out=tfplan
terraform apply tfplan
```

### Verification Scripts

```bash
./scripts/verify-all.sh               # Run all verification checks
./scripts/verify-infra.sh             # Infrastructure verification
./scripts/verify-k8s-base.sh          # K8s base resources
./scripts/verify-security.sh          # Security posture
./scripts/verify-dlp.sh               # DLP enforcement
./scripts/verify-tenant.sh <id>       # Per-tenant verification
```

## Conventions

### TypeScript

- **Target**: ES2022, Node 22+
- **Validation**: Zod for schema validation (MCP server)
- **Testing**: Vitest (not Jest)
- **Dev mode**: `tsx watch` for live reload
- **Strict mode** enabled in all tsconfig files

### OpenClaw Plugin Pattern

Plugins follow a fixed structure:

```
agent-warden-{name}/
├── src/index.ts            # Plugin entry — exports hook functions
├── openclaw.plugin.json    # Plugin manifest with JSON Schema configSchema
├── package.json
└── Dockerfile
```

Available hooks: `before_agent_start`, `before_tool_call`, `tool_result_persist`, `message_sending`, `message_received`, `llm_input`, `llm_output`

**CRITICAL**: All OpenClaw plugin hooks are **synchronous**. Returning a Promise is silently ignored. Do not use `async` in hook functions.

### DLP Plugin Architecture (v0.6.0)

The Purview DLP plugin (`agent-warden-purview-dlp/`) enforces 6 layers:

| Layer | Hook | Role |
|-------|------|------|
| **L1** | `before_agent_start` | Injects DLP policy prompt — forces LLM to analyze files before exec |
| **L1.5** | `before_tool_call` | Pre-scans file content (read tools), archive extraction (ZIP/tar), exec file refs; taint check blocks tools after prior DLP violation |
| **L2** | `tool_result_persist` | Scans tool output via Purview processContent; redacts on block; taints thread |
| **L2b** | `message_sending` | Blocks outbound LLM response if thread tainted (enforce mode, Telegram only) |
| **L3** | `message_received` | Scans inbound user messages |

Key implementation details:
- **Cross-instance taint**: Plugin loads twice (gateway + plugins context). Taint state shared via `globalThis[Symbol.for()]` to ensure L2 blocks in one instance propagate to L1.5 in the other
- **Archive extraction**: L1.5 uses `execSync` to run `unzip -p`/`tar -xzf -O` before exec, scanning extracted text through Purview
- **Exec file ref scanning**: L1.5 parses `@file` refs and archive arguments from exec commands
- **Image DLP**: L1 prompt forces two-step flow — analyze image first (separate turn), then exec only if not blocked
- **Deployment**: Init container copies plugin to PVC; must use unique image tags (not `:latest` or reused tags) due to `imagePullPolicy: IfNotPresent` caching

### Docker

All images use a consistent multi-stage pattern:

```dockerfile
FROM node:22-alpine AS build
# install deps, compile TypeScript
FROM node:22-alpine
# copy dist + production deps only
USER 65534                    # non-root
CMD ["node", "--require", "@opentelemetry/auto-instrumentations-node/register", "dist/index.js"]
```

### Kubernetes & Helm

- Tenant namespaces: `tenant-{tenant-id}`
- Helm chart: `k8s/helm/openclaw-tenant/`
- CRD: `OpenClawTenant` (watched by the operator in `k8s/operator/`)
- All pods use Workload Identity — never static credentials
- NetworkPolicy is default-deny per tenant namespace

### Secrets & Identity

- **Never** commit or hardcode Azure credentials, API keys, or tokens
- Per-tenant secrets live in Azure Key Vault (HSM Premium), mounted via CSI driver
- Workload Identity federated credentials for all Azure SDK access
- SaaS Auth Proxy handles third-party OAuth — agents never see raw tokens

### Observability

- OpenTelemetry everywhere: traces, metrics, logs
- OTel Collector DaemonSet (gRPC:4317, HTTP:4318) → Azure Monitor exporter → App Insights
- GenAI semantic conventions for LLM call tracing

### CI/CD

- GitHub Actions with OIDC federated credentials (no static Azure secrets)
- Workflows: `infra-terraform.yaml`, `build-images.yaml`, `deploy-k8s.yaml`, `security-scan.yaml`
- Trivy for container/IaC scanning, Checkov for policy compliance

## Tenant Lifecycle Scripts

```bash
./scripts/provision-tenant.sh <tenant-id> <tier> <admin-email>   # Create tenant
./scripts/set-tenant-secrets.sh <tenant-id>                       # Set API keys
./scripts/suspend-tenant.sh <tenant-id>                           # Scale to 0
./scripts/delete-tenant.sh <tenant-id>                            # Crypto-shred + cleanup
```

Tiers: `free`, `pro`, `enterprise` — each with different CPU/memory/storage quotas defined in the Helm chart values.
