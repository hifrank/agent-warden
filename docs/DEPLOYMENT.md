# Agent Warden — Deployment Guide (Dev Environment)

> Last updated: 2026-03-14

## Deployment Summary

### Infrastructure (Terraform)

All infrastructure deployed via 7 Terraform apply iterations:

| Resource | Name | Details |
|----------|------|---------|
| Resource Group | `rg-agentwarden-dev` | East US 2 |
| AKS | `aks-agentwarden-dev` | K8s 1.32.11, public cluster (IP whitelist — use `az aks update` to add current IP), 6 nodes (Standard_D4s_v5), zones [1,3] |
| ACR | `acragentwardendev` | Premium, admin disabled |
| Azure OpenAI | `aoai-agentwarden-dev` | gpt-4o (2024-11-20), GlobalStandard 10K TPM |
| Cosmos DB | `cosmos-agentwarden-dev` | Serverless, containers: tenants, instances, skills, audit |
| Key Vault (platform) | `kv-plat-agentwarden-dev` | RBAC authorization |
| Key Vault (tenant) | `kv-demo-tenant` | Per-tenant secrets |
| Purview | `pview-agentwarden-dev` | DLP scanning |
| Log Analytics | `law-agentwarden-dev` | Monitoring + Sentinel |
| Managed Identity (platform) | `mi-platform-agentwarden-dev` | Client: `dea0aebd-5099-4ebb-a3ce-a67f2823e40d` |
| Managed Identity (tenant) | `mi-demo-tenant` | Client: `a93104bc-6251-461f-93af-67a7ac26205f` |
| VNet | `vnet-agentwarden-dev` | CNI + Calico |
| App Gateway | `agw-agentwarden-dev` | Gateway API integration |

### Kubernetes Resources

Applied via `kubectl` and Helm:

- **StorageClasses**: `managed-premium-lrs`, `managed-premium-zrs`
- **CRD**: `openclawtenant-crd.yaml`
- **RBAC**: Operator service account + ClusterRole
- **Gateway**: Gateway API resource in `agent-warden-system`
- **Operator**: Running in `agent-warden-system` namespace
- **Shared LiteLLM Proxy**: 2-replica Deployment + Service + PDB in `agent-warden-system` (see `k8s/base/litellm/`)

### Container Images in ACR (`acragentwardendev.azurecr.io`)

| Image | Tag | Source |
|-------|-----|--------|
| `openclaw` | `2026.3.12` | Imported from `alpine/openclaw:2026.3.12` |
| `agent-warden-saas-proxy` | `latest` | Built from `agent-warden-saas-proxy/` |
| `purview-dlp-plugin` | `0.4.0` | Built from `agent-warden-purview-dlp/` |
| `agent-warden-operator` | `latest` | Built from `k8s/operator/` |

### Demo Tenant

- **Namespace**: `tenant-demo-tenant`
- **Helm Chart**: `openclaw-tenant` (revision 101)
- **Pod**: `openclaw-demo-tenant-0` — StatefulSet, 3/3 containers Running
  - `openclaw-gateway` — OpenClaw 2026.3.12
  - `saas-auth-proxy` — SaaS OAuth proxy
  - `heartbeat` — Gateway health monitoring
- **LiteLLM**: Shared Deployment in `agent-warden-system` (not per-tenant sidecar)
  - Set `litellmProxy.shared: true` in values file
  - Tenant NetworkPolicy allows egress to `litellm-proxy.agent-warden-system:4000`
- **Workload Identity**: Federated credential on `mi-demo-tenant`
- **Key Vault**: `kv-demo-tenant` with tenant secrets
- **Platform MI RBAC**: `Cognitive Services OpenAI User` on AOAI resource
- **Channels**: Telegram (@hifrankBot) — config stored in `openclaw.json` runtime state

### OpenClaw Configuration (`/data/state/openclaw.json`)

```json
{
  "agents": {
    "defaults": {
      "model": "litellm/gpt-5.4"
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "litellm": {
        "baseUrl": "http://litellm-proxy.agent-warden-system.svc.cluster.local:4000/v1",
        "apiKey": "<master-key>",
        "api": "openai-completions",
        "models": [
          {
            "id": "gpt-5.4",
            "name": "gpt-5.4 (Azure)",
            "reasoning": false,
            "input": ["text", "image"],
            "contextWindow": 128000,
            "maxTokens": 16384
          }
        ]
      }
    }
  },
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "<gateway-token>"
    }
  }
}
```

> **Important**: `openclaw.json` contains runtime state including channel configs (Telegram, Discord, etc.) that are NOT managed by Helm. Back up the file before deleting or re-seeding.

Key docs reference: https://docs.openclaw.ai/gateway/configuration-reference (`agents.defaults.model`, `models.providers`)

---

## Current Status

### Working

- [x] All Azure infrastructure provisioned and healthy
- [x] AKS cluster running with 6 nodes
- [x] K8s base resources (StorageClasses, CRD, RBAC, Gateway, RuntimeClass)
- [x] Operator deployed and running
- [x] 5 container images built and pushed to ACR
- [x] Demo tenant provisioned (namespace, KV, MI, Workload Identity, Helm rev 101)
- [x] OpenClaw 2026.3.12 running as gateway (3/3 pods Ready)
- [x] Shared LiteLLM Proxy (2 replicas) in `agent-warden-system` with Workload Identity
- [x] OpenClaw routes to shared LiteLLM via cross-namespace endpoint (`litellm/gpt-5.4`)
- [x] Platform MI has `Cognitive Services OpenAI User` RBAC on AOAI resource
- [x] Azure OpenAI MI auth working (subscription enforces `disableLocalAuth=true`)
- [x] End-to-end LLM calls working via shared LiteLLM + Workload Identity
- [x] Liveness/readiness probes working (exec-based `wget` to loopback)
- [x] Config hot-reload: `openclaw.json` changes auto-apply for agent/model changes
- [x] Telegram channel connected (@hifrankBot, long-polling)
- [x] OTel observability (Collector DaemonSet → App Insights, agents-view plugin)

### Not Yet Deployed

- [ ] `agent-warden-server` not yet deployed (MCP control plane)
- [ ] Gateway API not yet exposing tenant externally (no TLS, no DNS, ADDRESS=Unknown)

---

## Accessing the Cluster

The AKS cluster is public with an IP whitelist. Direct `kubectl` access requires:

### Prerequisites
- **kubelogin**: Required for Azure AD authentication with managed AAD clusters
  ```bash
  # Install on macOS
  brew install Azure/kubelogin/kubelogin
  ```

### Connect
```bash
# Get credentials and convert for Azure CLI auth
az aks get-credentials --resource-group rg-agentwarden-dev --name aks-agentwarden-dev --overwrite-existing
kubelogin convert-kubeconfig -l azurecli

# Verify
kubectl get nodes
```

### IP Whitelist
Your public IP must be in the authorized IP ranges. IP changes frequently — update as needed.

To add a new IP:
```bash
# Get your current public IP
MY_IP=$(curl -s ifconfig.me)

# Update via Azure CLI (non-persistent across Terraform applies):
az aks update -g rg-agentwarden-dev -n aks-agentwarden-dev \
  --api-server-authorized-ip-ranges "$MY_IP/32"
```

> **Note**: If you see a device code login prompt (`https://login.microsoft.com/device`),
> you need `kubelogin`. Run `kubelogin convert-kubeconfig -l azurecli` after getting credentials.

## Building and Deploying Images

```bash
# Build and push to ACR (from component directory)
az acr build --registry acragentwardendev --image purview-dlp-plugin:0.3.0 agent-warden-purview-dlp/

# Restart pods to pull new image (pullPolicy: Always)
kubectl rollout restart statefulset/openclaw-demo-tenant -n tenant-demo-tenant
```

## Helm Deployment

```bash
# Deploy directly via Helm
helm upgrade --install demo-tenant k8s/helm/openclaw-tenant \
  -f k8s/helm/openclaw-tenant/values-demo-tenant.yaml \
  --set litellmProxy.masterKey="<real-key>" \
  --namespace tenant-demo-tenant \
  --create-namespace
```

## Shared LiteLLM Proxy

The shared LiteLLM Proxy runs in `agent-warden-system` and serves all tenants, replacing per-tenant sidecars.

### Pre-requisites

1. **K8s Secret** — Create `litellm-proxy-secret` in `agent-warden-system` with `master-key` and `cosmos-endpoint`
2. **Federated Credential** — Create `fed-litellm-proxy` on the platform MI for Workload Identity
3. **RBAC** — Platform MI needs `Cognitive Services OpenAI User` on the AOAI resource

### Deploy

```bash
kubectl apply -f k8s/base/litellm/
```

### Toggle shared mode for a tenant

In the tenant values file:
```yaml
litellmProxy:
  enabled: true
  shared: true
  sharedEndpoint: "http://litellm-proxy.agent-warden-system.svc.cluster.local:4000/v1"
  masterKey: "CHANGE-ME"  # Override via --set
```

When `shared: true`:
- The LiteLLM sidecar container is **not** injected into the tenant pod
- The per-tenant `litellm-config` and `litellm-callback` ConfigMaps are **not** created
- A NetworkPolicy egress rule allows traffic to `litellm-proxy:4000` in `agent-warden-system`
- OpenClaw's `baseUrl` points to the shared endpoint instead of `localhost`

## Key Learnings

1. **OpenClaw model config**: Set via `agents.defaults.model` in `openclaw.json`, NOT via `OPENCLAW_MODEL` env var.
2. **Provider routing**: Custom base URLs go in `models.providers.<provider>.baseUrl` in config.
3. **Probes**: OpenClaw binds to `127.0.0.1` — use `exec` probes with `wget --spider http://127.0.0.1:18789/health`.
4. **Config location**: `OPENCLAW_CONFIG_PATH=/data/state/openclaw.json` and `OPENCLAW_STATE_DIR=/data/state`.
5. **Gateway mode**: `gateway.mode=local` required for Docker/K8s (set via `openclaw config set gateway.mode local`).
6. **Hot reload**: Agent/model config changes hot-apply; gateway server changes need restart.
7. **Main agent**: Cannot be deleted (`openclaw agents delete main` is rejected).
8. **Embedded CLI**: `openclaw agent --agent main -m "..."` uses embedded mode, which may bypass gateway provider config. Use the gateway API or Control UI for production tests.
9. **kubelogin**: Required for managed AAD AKS clusters. Run `kubelogin convert-kubeconfig -l azurecli` after `az aks get-credentials`.
10. **OIDC issuer changes**: When AKS is recreated, the OIDC issuer URL changes. All federated identity credentials must be updated to match the new URL.
11. **Storage account access**: Subscription policies may disable public network access on storage accounts. Bootstrap script checks and re-enables for Terraform state.
12. **Key Vault network access**: When using a public AKS cluster, per-tenant Key Vaults need public network access enabled for the CSI driver to reach them.
13. **Shared LiteLLM**: Set `litellmProxy.shared: true` to use the shared Deployment instead of per-tenant sidecar. The master key must match the K8s secret `litellm-proxy-secret` in `agent-warden-system`.
14. **LiteLLM image**: Requires `runAsUser: 1000` for `runAsNonRoot` — the default image runs as root.
15. **Model name matching**: `model_name` in LiteLLM config must match what OpenClaw sends (i.e. `baseModel`), not the Azure deployment name.
16. **Telegram channel config**: Stored in `openclaw.json` as `channels.telegram.accounts.default.botToken` — this is runtime state NOT managed by Helm. Back up before re-seeding.
17. **stream_options**: Do NOT set `stream_options.include_usage: true` in LiteLLM model params — causes 400 on non-streaming requests.

## Manual Steps (Cannot Be Automated)

The following steps require manual intervention and are **not** covered by `bootstrap-azure.sh` or `provision-tenant.sh`:

### 1. OpenClaw Configuration (`openclaw.json`)

The model/provider configuration inside the OpenClaw pod must be set manually after first deploy:

```bash
# Exec into the pod
kubectl exec -it openclaw-demo-tenant-0 -n tenant-demo-tenant -c openclaw-gateway -- sh

# Set model
openclaw config set agents.defaults.model openai/gpt-4o
openclaw config set gateway.mode local

# Write full provider config
cat > /data/state/openclaw.json << 'EOF'
{
  "agents": { "defaults": { "model": "openai/gpt-4o" } },
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "http://127.0.0.1:8080/aoai-agentwarden-dev.openai.azure.com/openai/deployments/gpt-4o",
        "api": "openai-completions",
        "models": [{
          "id": "gpt-4o", "name": "GPT-4o (Azure)", "reasoning": false,
          "input": ["text", "image"], "contextWindow": 128000, "maxTokens": 16384
        }]
      }
    }
  },
  "gateway": { "mode": "local", "auth": { "mode": "token", "token": "<gateway-token>" } }
}
EOF
```

**TODO**: Automate via Helm ConfigMap + init-container (see [TODO-2026-03-14.md](TODO-2026-03-14.md)).

### 2. Azure OpenAI Resource

The Azure OpenAI resource and model deployment must be created manually (not in Terraform):

```bash
# Create AOAI resource
az cognitiveservices account create --name aoai-agentwarden-dev \
  --resource-group rg-agentwarden-dev --kind OpenAI --sku S0 \
  --location eastus2

# Deploy a model
az cognitiveservices account deployment create \
  --name aoai-agentwarden-dev --resource-group rg-agentwarden-dev \
  --deployment-name gpt-4o --model-name gpt-4o --model-version 2024-11-20 \
  --model-format OpenAI --sku-capacity 10 --sku-name GlobalStandard
```

### 3. Key Vault Secrets

Per-tenant secrets must be set interactively (to avoid storing credentials in scripts):

```bash
./scripts/set-tenant-secrets.sh demo-tenant
```

### 4. IP Whitelist Updates

When your public IP changes, update the AKS authorized IP ranges:

```bash
# Quick update (does not persist in Terraform)
az aks update -g rg-agentwarden-dev -n aks-agentwarden-dev \
  --api-server-authorized-ip-ranges "<new-ip>/32"

# Persistent update: edit infra/terraform/environments/dev/terraform.tfvars
# then: terraform apply
```

### 5. OIDC Issuer Update After AKS Recreation

When AKS is recreated (e.g., switching private→public), the OIDC issuer URL changes.
Update all federated identity credentials:

```bash
NEW_OIDC=$(az aks show -g rg-agentwarden-dev -n aks-agentwarden-dev \
  --query oidcIssuerProfile.issuerUrl -o tsv)

az identity federated-credential update \
  --identity-name mi-demo-tenant \
  --resource-group rg-agentwarden-dev \
  --name fed-demo-tenant \
  --issuer "$NEW_OIDC" \
  --subject "system:serviceaccount:tenant-demo-tenant:openclaw-demo-tenant"
```

The `verify-tenant.sh` script will detect and report OIDC issuer mismatches.
