# Agent Warden — Secure Multi-Tenant AI Agent Platform

A production-grade platform for hosting isolated [OpenClaw](https://github.com/pinkpixel-dev/openclaw) AI agent instances on Azure Kubernetes Service, governed by the **Agent Warden Server** that manages the full tenant lifecycle — from provisioning to cryptographic deletion.

Agent Warden provides **defense-in-depth security** for multi-tenant AI agent hosting, combining Kubernetes-level isolation, Microsoft Purview DLP enforcement, Kata Containers hardware sandboxing, and Azure-native identity and secret management. Each tenant operates in a fully isolated namespace with its own Key Vault, Managed Identity, NetworkPolicy, and resource quotas.

## Overview

| Component | Description |
|-----------|-------------|
| **Agent Warden Server** | MCP server exposing tenant lifecycle, identity, DLP, inventory, and health-check tools |
| **K8s Operator** | Watches `OpenClawTenant` CRD and reconciles tenant namespaces, StatefulSets, and NetworkPolicies |
| **Purview DLP Plugin** | OpenClaw plugin with 4-layer defense (L1 prompt guard, L2 output scanner, L2b response scanner, L3 input audit) via Microsoft Purview processContent API |
| **SaaS Auth Proxy** | Per-tenant sidecar proxy that injects OAuth tokens for external SaaS APIs (Google, GitHub, Salesforce) — agents never see raw credentials |
| **LiteLLM Proxy** | Per-tenant sidecar routing LLM requests with per-model configuration and Azure OpenAI support |
| **Sandbox Monitor** | PID 1 process inside Kata microVM that monitors tool execution for suspicious binaries, files, and network connections |
| **Helm Chart** | Per-tenant chart deploying StatefulSet, NetworkPolicy, ResourceQuota, SecretProviderClass, ServiceAccount, and HTTPRoute |

## Architecture

```
                        ┌──────────────────┐
                        │  Entra ID        │
                        │  Per-Agent App   │
                        │  Registration    │
                        └────────┬─────────┘
                                 │ OAuth2 / Workload Identity
┌────────────────────────────────▼─────────────────────────────────────────────┐
│  Application Gateway for Containers (AGC)                                    │
│  ─ Gateway API ─ WAF Policy (OWASP 3.2) ─ ALB Controller ─ Auto-scale      │
└────────────────────────┬─────────────────────────────────────────────────────┘
                         │ HTTPRoute per tenant
┌────────────────────────▼─────────────────────────────────────────────────────┐
│  AKS Private Cluster (Azure CNI + Calico + Workload Identity)                │
│                                                                              │
│  ┌─ Tenant Pool (runc) ──────────────────────────────────────────────┐       │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐  │       │
│  │  │ tenant-abc       │  │ tenant-def       │  │ tenant-xyz     │  │       │
│  │  │ ┌──────────────┐ │  │ ┌──────────────┐ │  │ ┌────────────┐ │  │       │
│  │  │ │OpenClaw :1878│ │  │ │OpenClaw :1878│ │  │ │OpenClaw    │ │  │       │
│  │  │ │DLP Plugin    │ │  │ │DLP Plugin    │ │  │ │DLP Plugin  │ │  │       │
│  │  │ │LiteLLM :8080 │ │  │ │LiteLLM :8080 │ │  │ │LiteLLM    │ │  │       │
│  │  │ │SaaS Prxy:9090│ │  │ │SaaS Prxy:9090│ │  │ │SaaS Proxy  │ │  │       │
│  │  │ └──────────────┘ │  │ └──────────────┘ │  │ └────────────┘ │  │       │
│  │  │  NetworkPolicy   │  │  NetworkPolicy   │  │  NetworkPolicy │  │       │
│  │  │  ResourceQuota   │  │  ResourceQuota   │  │  ResourceQuota │  │       │
│  │  └──────────────────┘  └──────────────────┘  └────────────────┘  │       │
│  └───────────────────────────────────────────────────────────────────┘       │
│                                                                              │
│  ┌─ Sandbox Pool (Kata Containers — Hyper-V microVM) ────────────────┐       │
│  │  Tool Exec Pod (ephemeral, Kata microVM) + sandbox-monitor PID 1  │       │
│  └───────────────────────────────────────────────────────────────────┘       │
│                                                                              │
│  agent-warden-system namespace                                               │
│  ┌─────────────────┐  ┌────────────────┐                                    │
│  │ Agent Warden    │  │ K8s Operator   │                                    │
│  │ Server (MCP)    │  │ (Reconciler)   │                                    │
│  └─────────────────┘  └────────────────┘                                    │
└──────────┬──────────────┬──────────────┬──────────────┬──────────────────────┘
           │              │              │              │
   ┌───────▼──────┐ ┌────▼─────────┐ ┌──▼───────────┐ │ ┌──────────────────┐
   │ Azure Key   │ │ Cosmos DB    │ │Log Analytics │ │ │Microsoft Purview │
   │ Vault (HSM) │ │ (Serverless) │ │+ Sentinel    │ │ │(E5 DLP Policies) │
   │ per-tenant  │ │ tenant reg.  │ │SIEM          │ │ │processContent API│
   │ + platform  │ │ audit log    │ │              │ │ │cross-tenant auth │
   └─────────────┘ └──────────────┘ └──────────────┘ │ └──────────────────┘
                                                      │
                                                ┌─────▼──────────┐
                                                │ SaaS Providers │
                                                │ Google / GitHub│
                                                │ Salesforce     │
                                                └────────────────┘
                                             SaaS Auth Proxy :9090
                                             OAuth2 delegated access
```

### 3-Pool Node Architecture

| Pool | Runtime | Purpose | Isolation |
|------|---------|---------|-----------|
| **System** | runc | Control plane (operator, Agent Warden Server) | System taint |
| **Tenant** | runc | Gateway pods (OpenClaw + sidecars per tenant) | Namespace + NetworkPolicy + ResourceQuota |
| **Sandbox** | Kata (Hyper-V microVM) | Ephemeral tool execution | Hardware VM boundary, no secrets, `automountServiceAccountToken: false` |

### DLP Defense-in-Depth (v0.4.0)

| Layer | Hook | Scope | Mode |
|-------|------|-------|------|
| **L0** | Azure OpenAI content filter | Model-level PII blocking | Always |
| **L1** | `before_agent_start` | Prompt guard — injects DLP policy into agent context | Enforce + Audit |
| **L2** | `tool_result_persist` | Output scanner — sync Purview scan, redacts tool output | Enforce: sync block / Audit: async log |
| **L2b** | `message_sending` | Response scanner — blocks PII in outbound messages (streaming OFF) | Enforce only |
| **L3** | `message_received` | Input audit — Purview scan of inbound user messages | Enforce + Audit |

## Prerequisites

### Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Azure CLI | ≥ 2.60 | Azure resource management |
| Terraform | ≥ 1.7 | Infrastructure as Code |
| kubectl | ≥ 1.30 | Kubernetes management |
| Helm | ≥ 3.14 | Chart deployment |
| Node.js | ≥ 22 | MCP Server, Operator, DLP Plugin |
| pnpm | ≥ 9 | Package management |
| Docker | latest | Image building |
| PowerShell | ≥ 7.4 | Purview DLP policy management (optional) |

### Azure Subscription

- Owner or Contributor + User Access Administrator on the subscription
- Resource providers registered: `Microsoft.ContainerService`, `Microsoft.KeyVault`, `Microsoft.DocumentDB`, `Microsoft.OperationalInsights`, `Microsoft.Network`, `Microsoft.ContainerRegistry`
- Entra ID permissions to create App Registrations and Security Groups

### Microsoft Purview (for DLP)

- Microsoft 365 E5 tenant (or E5 Compliance add-on) with DLP policies configured
- App Registration in the E5 tenant with `Content.Process.User` Graph API permission
- [DSPM for AI collection policy](https://learn.microsoft.com/purview/developer/configurepurview) with ingestion enabled
- Unified Audit Log enabled on the E5 tenant

## Getting Started

### 1. Clone and Configure

```bash
git clone <this-repo>
cd agent-warden
```

### 2. Bootstrap Azure Infrastructure

The bootstrap script handles everything from Terraform state backend to AKS cluster setup:

```bash
# Set required environment variables
export ENVIRONMENT=dev
export LOCATION=eastus2
export BASE_NAME=agentwarden

# Run the full bootstrap
./scripts/bootstrap-azure.sh
```

This script will:
1. Verify Azure CLI login
2. Create Terraform state storage account
3. Create the resource group
4. Create Entra ID admin security group
5. Run `terraform init` + `terraform apply`
6. Connect kubectl to the new AKS cluster
7. Apply K8s base resources (StorageClasses, CRD, RBAC)
8. Create the `agent-warden-system` namespace
9. Build and push container images to ACR

### 2b. Build Custom OpenClaw Image

The custom image extends the official OpenClaw image with Chrome dependencies and the `agent-browser` skill pre-installed:

```bash
# Build and push via ACR Tasks (no local Docker needed)
az acr build \
  --registry <acr-name> \
  --image openclaw-custom:2026.3.12 \
  agent-warden-openclaw/
```

This image includes:
- Chrome 146 system dependencies (libnspr4, libnss3, libatk, etc.)
- `agent-browser` CLI (headless browser control for OpenClaw skills)
- Pre-downloaded Chrome binary at `/opt/agent-browser`

### 3. Provision a Tenant

```bash
./scripts/provision-tenant.sh <tenant-id> <tier> <admin-email>
# Example:
./scripts/provision-tenant.sh acme-corp pro admin@acme.com
```

### 4. Set Tenant Secrets

```bash
./scripts/set-tenant-secrets.sh <tenant-id>
# Interactively prompts for API keys (OpenAI, Anthropic, etc.)
```

## Tenant Lifecycle Operations

| Operation | Script | Description |
|-----------|--------|-------------|
| **Provision** | `./scripts/provision-tenant.sh <id> <tier> <email>` | Create KV, identity, deploy OpenClaw |
| **Set Secrets** | `./scripts/set-tenant-secrets.sh <id>` | Set API keys in tenant Key Vault |
| **Suspend** | `./scripts/suspend-tenant.sh <id>` | Scale to 0 (data preserved) |
| **Delete** | `./scripts/delete-tenant.sh <id>` | Crypto-shred + full cleanup |

## Manual Steps (Cannot Be Scripted)

### Entra ID App Registration for OIDC (Workload Identity)

1. Go to **Azure Portal → Entra ID → App Registrations → New Registration**
2. Name: `agent-warden-{env}`
3. Supported account types: **Single tenant**
4. Note the **Application (client) ID** and **Directory (tenant) ID**
5. Create a **Federated Credential** for the GitHub Actions OIDC:
   - Issuer: `https://token.actions.githubusercontent.com`
   - Subject: `repo:<org>/<repo>:ref:refs/heads/main`
   - Audience: `api://AzureADTokenExchange`

### GitHub Actions Secrets

Configure these secrets in your GitHub repo (**Settings → Secrets → Actions**):

| Secret | Value |
|--------|-------|
| `AZURE_CLIENT_ID` | App Registration Client ID |
| `AZURE_TENANT_ID` | Entra ID Tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure Subscription ID |
| `AKS_ADMIN_GROUP_ID` | Entra Admin Group Object ID |
| `AZURE_RESOURCE_GROUP` | Resource Group name |
| `AKS_CLUSTER_NAME` | AKS cluster name |
| `ACR_NAME` | Container Registry name (without .azurecr.io) |

### DNS Configuration

1. Create a DNS A record or CNAME pointing to the App Gateway public IP
2. Configure the hostname in App Gateway listeners
3. Upload a TLS certificate (or use Key Vault reference)

### Channel Bot Registration (Per-Tenant, If Needed)

- **Telegram**: Message `@BotFather`, create bot, save token → `set-tenant-secrets.sh`
- **Discord**: Create application at https://discord.com/developers, add bot, save token
- **Slack**: Create app at https://api.slack.com/apps, install to workspace, save bot token

## Project Structure

```
agent-warden/
├── .github/workflows/          # CI/CD pipelines
│   ├── infra-terraform.yaml    #   Terraform plan/apply
│   ├── build-images.yaml       #   Docker build & push to ACR
│   ├── deploy-k8s.yaml         #   K8s resource deployment
│   └── security-scan.yaml      #   Trivy + Checkov scans
├── infra/terraform/            # Infrastructure as Code
│   ├── modules/                #   Reusable Terraform modules
│   │   ├── aks/                #     AKS cluster (3-pool, Calico, Workload Identity)
│   │   ├── vnet/               #     Virtual network + subnets + NSGs
│   │   ├── keyvault/           #     Platform Key Vault (HSM Premium)
│   │   ├── cosmos/             #     Cosmos DB (tenant registry + audit)
│   │   ├── acr/                #     Container Registry
│   │   ├── appgw/              #     App Gateway WAF (OWASP 3.2)
│   │   ├── log-analytics/      #     Logging + Sentinel SIEM
│   │   ├── managed-identity/   #     User-Assigned Managed Identity
│   │   └── purview/            #     Purview Data Map + governance
│   └── environments/           #   Environment configs (dev, prod)
├── k8s/
│   ├── base/                   # Cluster-wide resources
│   │   ├── storage/            #   StorageClasses (ZRS/LRS Premium)
│   │   ├── rbac/               #   Operator service account + ClusterRole
│   │   ├── gateway/            #   Gateway API + HTTPRoute
│   │   ├── monitoring/         #   Health check CronJob
│   │   └── sandbox/            #   RuntimeClass (Kata Containers)
│   ├── operator/               # K8s Operator (TypeScript)
│   │   ├── config/crd/         #   OpenClawTenant CRD
│   │   └── src/                #   Reconciler logic
│   └── helm/openclaw-tenant/   # Per-tenant Helm chart
│       └── templates/          #   StatefulSet, NetworkPolicy, ResourceQuota, etc.
├── agent-warden-server/        # MCP Server (TypeScript)
│   └── src/
│       ├── tools/              #   MCP tool implementations
│       ├── middleware/          #   Cosmos, K8s, Purview clients
│       └── config/             #   Types & env config
├── agent-warden-purview-dlp/   # Purview DLP Plugin (OpenClaw plugin, v0.4.0)
│   ├── Dockerfile              #   Multi-stage build (init container)
│   └── src/
│       ├── index.ts            #   Plugin entry: L1/L2/L2b/L3 DLP hooks
│       └── purview-client.ts   #   Graph API processContent client (cross-tenant)
├── agent-warden-llm-proxy/     # LiteLLM sidecar proxy
├── agent-warden-saas-proxy/    # SaaS Auth Proxy sidecar (OAuth2 token injection)
├── sandbox-monitor/            # Sandbox PID 1 monitor (process/file/network)
├── scripts/                    # Automation scripts
│   ├── bootstrap-azure.sh      #   Full infra bootstrap
│   ├── provision-tenant.sh     #   Tenant onboarding
│   ├── suspend-tenant.sh       #   Tenant suspension
│   ├── delete-tenant.sh        #   Tenant removal (crypto-shred)
│   ├── set-tenant-secrets.sh   #   API key management
│   └── verify-*.sh             #   Verification scripts (infra, k8s, security, DLP, etc.)
└── docs/design/                # Design documentation
    ├── secure-multi-tenant-openclaw.md   # Full architecture document (4400+ lines)
    ├── security.md                       # Security approaches overview
    ├── purview-dlp-plugin.md             # DLP plugin design (v0.4.0)
    └── data-governance.md                # Data governance framework
```

## CI/CD Pipelines

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **infra-terraform** | Push to `infra/terraform/` on main | Terraform plan (on PR) / apply (on merge) |
| **build-images** | Push to `agent-warden-server/`, `k8s/operator/`, `k8s/base/monitoring/` | Build & push Docker images to ACR |
| **deploy-k8s** | Push to `k8s/base/`, `k8s/helm/` | Apply K8s base resources, deploy operator |
| **security-scan** | Push, PR, weekly schedule | Trivy IaC scan, Checkov policy scan |

All workflows use **OIDC federated credentials** (no static Azure secrets).

## Security Model

Agent Warden implements **defense-in-depth** across 12 security domains. For full details, see [docs/design/security.md](docs/design/security.md).

| Domain | Key Features |
|--------|-------------|
| **Tenant Isolation** | Per-namespace, NetworkPolicy, ResourceQuota, Kata microVM sandbox |
| **Network Security** | Default-deny NetworkPolicy, Calico, VNet segmentation, private endpoints, WAF |
| **Identity & Access** | Workload Identity, Entra RBAC, PIM, Conditional Access, 5-role RBAC model |
| **Secrets** | HSM-backed Key Vault (Premium), 3-tier envelope encryption, CSI driver with auto-rotation |
| **DLP** | 4-layer Purview DLP (L1 prompt guard, L2 output scanner, L2b response blocker, L3 input audit) |
| **Sandbox** | Kata Containers (Hyper-V microVM), PID 1 monitor, suspicious binary/file/network detection |
| **Audit** | Cosmos DB audit log, Log Analytics, Sentinel SIEM, 11+ event types, WORM audit trail |
| **Data Governance** | SaaS activity ledger, data lineage tracking, access governance, compliance reporting |
| **Resource Governance** | Per-tier ResourceQuota/LimitRange, rate limiting, noisy-neighbor protection |
| **Supply Chain** | Skill allowlist, signature verification, CVE scanning, ACR image content trust |
| **Compliance** | GDPR right-to-erasure (crypto-shred), SOC 2, HIPAA, data residency pinning |
| **Runtime Security** | Microsoft Defender for Containers, Sentinel auto-response, binary drift detection |

> **Note on agent-browser/Chrome:** The gateway container uses `readOnlyRootFilesystem: false` and `seccompProfile: Unconfined` to support the agent-browser skill (headless Chrome). All sidecar containers (LiteLLM proxy, SaaS auth proxy, git-sync) still enforce `readOnlyRootFilesystem: true`. See the design doc §4.3 for details.

## Tiers

| Capability | Free | Pro | Enterprise |
|-----------|------|-----|-----------|
| CPU | 500m | 2 | 4 |
| Memory | 512Mi | 4Gi | 8Gi |
| State Storage | 5Gi (LRS) | 20Gi (ZRS) | 50Gi (ZRS) |
| Work Storage | 2Gi (LRS) | 10Gi (ZRS) | 25Gi (ZRS) |
| Pods | 1 | 3 | 5 |
| Storage Class | premium-lrs | premium-zrs | premium-zrs |

## Troubleshooting

### Pod not starting

```bash
kubectl describe pod -n tenant-<id> -l app.kubernetes.io/instance=<id>
kubectl logs -n tenant-<id> -l app.kubernetes.io/instance=<id> --previous
```

### Health check failing

```bash
# Run openclaw doctor inside the pod
kubectl exec -n tenant-<id> <pod-name> -- openclaw doctor

# Check health CronJob logs
kubectl logs -n agent-warden-system -l app=health-checker --tail=50
```

### Key Vault secrets not mounting

```bash
# Verify SecretProviderClass
kubectl describe secretproviderclass -n tenant-<id>

# Check CSI driver pod logs
kubectl logs -n kube-system -l app=secrets-store-csi-driver --tail=50

# Verify Workload Identity federation
az identity federated-credential list \
  --identity-name mi-<id> \
  --resource-group <rg>

# On public AKS clusters, Key Vault must have public network access enabled
az keyvault update --name kv-<id> --resource-group <rg> --public-network-access Enabled
```

### agent-browser / Chrome issues

```bash
# Verify Chrome is available in the pod
kubectl exec -n tenant-<id> <pod> -c openclaw-gateway -- \
  ls -la /home/node/.agent-browser/browsers/

# Test agent-browser directly
kubectl exec -n tenant-<id> <pod> -c openclaw-gateway -- \
  agent-browser open https://example.com

# If Chrome crashes with "Trace/breakpoint trap", ensure:
#   securityContext.readOnlyRootFilesystem: false
#   securityContext.seccompProfile.type: Unconfined
```

### Terraform state lock

```bash
# Force unlock (use with caution)
cd infra/terraform
terraform force-unlock <lock-id>
```

## Design Documents

| Document | Description |
|----------|-------------|
| [Architecture](docs/design/secure-multi-tenant-openclaw.md) | Full security architecture, threat model, and implementation plan (4400+ lines) |
| [Security Approaches](docs/design/security.md) | Overview of all security domains and techniques used |
| [Purview DLP Plugin](docs/design/purview-dlp-plugin.md) | DLP plugin design — 4-layer defense, dual-mode (enforce/audit), v0.4.0 |
| [Data Governance](docs/design/data-governance.md) | Data governance framework — activity ledger, lineage, access governance |
