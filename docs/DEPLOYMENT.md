# Agent Warden — Deployment Guide (Dev Environment)

> Last updated: 2026-03-14

## Deployment Summary

### Infrastructure (Terraform)

All infrastructure deployed via 7 Terraform apply iterations:

| Resource | Name | Details |
|----------|------|---------|
| Resource Group | `rg-agentwarden-dev` | East US 2 |
| AKS | `aks-agentwarden-dev` | K8s 1.32.11, public cluster (IP whitelist: `118.160.24.57/32`), 6 nodes (Standard_D4s_v5), zones [1,3] |
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
- **RuntimeClass**: Kata containers for sandbox pool
- **Operator**: Running in `agent-warden-system` namespace

### Container Images in ACR (`acragentwardendev.azurecr.io`)

| Image | Tag | Source |
|-------|-----|--------|
| `openclaw` | `2026.3.12` | Imported from `alpine/openclaw:2026.3.12` |
| `agent-warden-saas-proxy` | `latest` | Built from `agent-warden-saas-proxy/` |
| `purview-dlp-plugin` | `0.3.0` | Built from `agent-warden-purview-dlp/` |
| `sandbox-monitor` | `latest` | Built from `sandbox-monitor/` |
| `agent-warden-operator` | `latest` | Built from `k8s/operator/` |

### Demo Tenant

- **Namespace**: `tenant-demo-tenant`
- **Helm Chart**: `openclaw-tenant` (revision ~8)
- **Pod**: `openclaw-demo-tenant-0` — StatefulSet, 3/3 containers Running
  - `openclaw-gateway` — OpenClaw 2026.3.12
  - `litellm-proxy` — LiteLLM Azure OpenAI adapter
  - `saas-auth-proxy` — SaaS OAuth proxy
- **Workload Identity**: Federated credential on `mi-demo-tenant`
- **Key Vault**: `kv-demo-tenant` with `azure-openai-api-key` secret
- **RBAC**: MI has `Cognitive Services OpenAI User` on the AOAI resource

### OpenClaw Configuration (`/data/state/openclaw.json`)

```json
{
  "agents": {
    "defaults": {
      "model": "openai/gpt-4o"
    }
  },
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "http://127.0.0.1:8080/aoai-agentwarden-dev.openai.azure.com/openai/deployments/gpt-4o",
        "api": "openai-completions",
        "models": [
          {
            "id": "gpt-4o",
            "name": "GPT-4o (Azure)",
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
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "<gateway-token>"
    }
  }
}
```

Key docs reference: https://docs.openclaw.ai/gateway/configuration-reference (`agents.defaults.model`, `models.providers`)

---

## Current Status

### Working

- [x] All Azure infrastructure provisioned and healthy
- [x] AKS cluster running with 6 nodes
- [x] K8s base resources (StorageClasses, CRD, RBAC, Gateway, RuntimeClass)
- [x] Operator deployed and running
- [x] 5 container images built and pushed to ACR
- [x] Demo tenant provisioned (namespace, KV, MI, Workload Identity, Helm)
- [x] OpenClaw 2026.3.12 running as gateway (3/3 pods Ready)
- [x] OpenClaw configured to use `openai/gpt-4o` as default model (via `agents.defaults.model`)
- [x] OpenClaw provider config routes to Azure OpenAI via LiteLLM proxy (via `models.providers.openai.baseUrl`)
- [x] LiteLLM proxy handles Azure OpenAI translation + Managed Identity token refresh
- [x] MI has `Cognitive Services OpenAI User` RBAC on AOAI resource
- [x] Liveness/readiness probes working (exec-based `wget` to loopback)
- [x] Config hot-reload: `openclaw.json` changes auto-apply for agent/model changes

### Blocked

- [ ] **End-to-end LLM call fails** — see "Blocking Issue" below
- [ ] `agent-warden-server` not yet deployed (MCP control plane)
- [ ] Gateway API not yet exposing tenant externally (no TLS, no DNS, ADDRESS=Unknown)
- [ ] `openclaw.json` config is ephemeral (manually written to PVC, not Helm-managed)

### Blocking Issue: Azure OpenAI Authentication

**Problem**: The subscription enforces `disableLocalAuth=true` on the Azure OpenAI resource (cannot be changed — tried `az resource update`, REST API PATCH, `az cognitiveservices account update`; the setting reverts to `true`). This means API key authentication is rejected with `403 Key based authentication is disabled`.

**Current architecture**:
```
OpenClaw Gateway  →  DLP Proxy (:8080)  →  Azure OpenAI (HTTPS)
                     (MI bearer token)
```

The DLP proxy has been updated to acquire a bearer token via `DefaultAzureCredential` (Managed Identity) and inject it as `Authorization: Bearer <token>` for Azure OpenAI requests. However, OpenClaw's embedded agent CLI mode bypasses the gateway and calls the provider directly using the API key from `OPENAI_API_KEY` env var — it does NOT go through the DLP proxy.

**Solution options for tomorrow**:

1. **Ensure gateway mode (not embedded CLI)** — The agent calls via the running gateway process (which reads `models.providers.openai.baseUrl` and routes through the proxy). Test via Control UI or channel rather than `openclaw agent` CLI.

2. **Set `OPENAI_BASE_URL` in OpenClaw env** — OpenClaw should respect `OPENAI_BASE_URL` for the OpenAI provider. The env var is already set to `http://127.0.0.1:8080/aoai-agentwarden-dev.openai.azure.com/openai/deployments/gpt-4o`. The gateway process should use it.

3. **Remove `OPENAI_API_KEY` env var** — Since the DLP proxy handles auth via MI, OpenClaw doesn't need the API key. But OpenClaw may refuse to start without a key for the configured provider. Test with a dummy value.

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
Your public IP must be in the authorized IP ranges. Current whitelist: `118.160.24.57/32`.

To add a new IP:
```bash
# Update Terraform variable
# In infra/terraform/environments/dev/terraform.tfvars:
#   aks_authorized_ip_ranges = ["118.160.24.57/32", "<new-ip>/32"]

# Or directly via Azure CLI (non-persistent):
az aks update -g rg-agentwarden-dev -n aks-agentwarden-dev \
  --api-server-authorized-ip-ranges "118.160.24.57/32,<new-ip>/32"
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
  --namespace tenant-demo-tenant \
  --create-namespace
```

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
