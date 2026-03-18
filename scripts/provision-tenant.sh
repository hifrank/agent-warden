#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Provision a single OpenClaw tenant
#
# This script creates:
#   1. Per-tenant Key Vault (Premium HSM-backed)
#   2. Per-tenant User-Assigned Managed Identity
#   3. Workload Identity federation (K8s SA → Entra ID MI)
#   4. Key Vault RBAC grants
#   5. Helm release (StatefulSet + PVCs + NetworkPolicy + ResourceQuota)
#
# Prerequisites:
#   - AKS cluster running with kubectl context set
#   - Helm 3
#   - Azure CLI logged in
#   - Terraform outputs available (or env vars set)
#
# Usage:
#   ./scripts/provision-tenant.sh <tenant-id> <tier> <admin-email> [region]
#   Example: ./scripts/provision-tenant.sh acme-corp pro admin@acme.com eastus2
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

TENANT_ID="${1:?Usage: $0 <tenant-id> <tier> <admin-email> [region]}"
TIER="${2:?Usage: $0 <tenant-id> <tier> <admin-email> [region]}"
ADMIN_EMAIL="${3:?Usage: $0 <tenant-id> <tier> <admin-email> [region]}"
REGION="${4:-eastus2}"

# Validate tier
if [[ ! "$TIER" =~ ^(free|pro|enterprise)$ ]]; then
  echo "ERROR: tier must be 'free', 'pro', or 'enterprise'. Got: $TIER"
  exit 1
fi

# Validate tenant ID format
if [[ ! "$TENANT_ID" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]]; then
  echo "ERROR: tenant-id must be lowercase alphanumeric with hyphens, 3-63 chars."
  exit 1
fi

# Auto-detect from environment or Terraform output
ENV="${ENV:-dev}"
BASE_NAME="${BASE_NAME:-agentwarden}"
RG_NAME="rg-${BASE_NAME}-${ENV}"
AKS_NAME="${AKS_CLUSTER_NAME:-$(cd infra/terraform && terraform output -raw aks_cluster_name 2>/dev/null || echo "")}"
ACR_SERVER="${ACR_LOGIN_SERVER:-$(cd infra/terraform && terraform output -raw acr_login_server 2>/dev/null || echo "")}"
OIDC_ISSUER="${AKS_OIDC_ISSUER:-$(cd infra/terraform && terraform output -raw aks_oidc_issuer_url 2>/dev/null || echo "")}"

# Fallback: query AKS directly for OIDC issuer if not found via terraform
if [[ -z "$OIDC_ISSUER" && -n "$AKS_NAME" ]]; then
  OIDC_ISSUER=$(az aks show -g "$RG_NAME" -n "$AKS_NAME" --query oidcIssuerProfile.issuerUrl -o tsv 2>/dev/null || true)
fi
if [[ -z "$OIDC_ISSUER" ]]; then
  # Last resort: try to detect AKS name from resource group
  DETECTED_AKS=$(az aks list -g "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
  if [[ -n "$DETECTED_AKS" ]]; then
    AKS_NAME="$DETECTED_AKS"
    OIDC_ISSUER=$(az aks show -g "$RG_NAME" -n "$AKS_NAME" --query oidcIssuerProfile.issuerUrl -o tsv 2>/dev/null || true)
  fi
fi

NAMESPACE="tenant-${TENANT_ID}"
KV_NAME="kv-${TENANT_ID}"
# Key Vault names max 24 chars
KV_NAME="${KV_NAME:0:24}"
MI_NAME="mi-${TENANT_ID}"
HELM_RELEASE="oc-${TENANT_ID}"
CHART_PATH="k8s/helm/openclaw-tenant"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Provision Tenant: $TENANT_ID"
echo "║  Tier: $TIER | Region: $REGION"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Create per-tenant Key Vault ────────────────────────
echo "▶ Step 1: Create per-tenant Key Vault ($KV_NAME)"
if az keyvault show --name "$KV_NAME" &>/dev/null; then
  echo "  Key Vault $KV_NAME already exists."
else
  az keyvault create \
    --name "$KV_NAME" \
    --resource-group "$RG_NAME" \
    --location "$REGION" \
    --sku premium \
    --enable-purge-protection true \
    --retention-days 90 \
    --enable-rbac-authorization true \
    --no-wait \
    -o none
  echo "  Created Key Vault $KV_NAME (premium HSM-backed)."
fi

# Ensure Key Vault has public network access (required for CSI driver on public AKS)
KV_PUBLIC_NET=$(az keyvault show --name "$KV_NAME" --query "properties.publicNetworkAccess" -o tsv 2>/dev/null || true)
if [[ "$KV_PUBLIC_NET" == "Disabled" ]]; then
  echo "  Enabling public network access on Key Vault..."
  az keyvault update --name "$KV_NAME" --resource-group "$RG_NAME" --public-network-access Enabled -o none
fi

# ── 2. Create per-tenant Managed Identity ──────────────────
echo ""
echo "▶ Step 2: Create Managed Identity ($MI_NAME)"
MI_OUTPUT=$(az identity create \
  --name "$MI_NAME" \
  --resource-group "$RG_NAME" \
  --location "$REGION" \
  -o json 2>/dev/null || az identity show --name "$MI_NAME" --resource-group "$RG_NAME" -o json)

MI_CLIENT_ID=$(echo "$MI_OUTPUT" | jq -r '.clientId')
MI_PRINCIPAL_ID=$(echo "$MI_OUTPUT" | jq -r '.principalId')
echo "  Client ID:    $MI_CLIENT_ID"
echo "  Principal ID: $MI_PRINCIPAL_ID"

# ── 3. Grant MI → Key Vault Secrets User ───────────────────
echo ""
echo "▶ Step 3: Grant Key Vault access to Managed Identity"
# Wait for Key Vault to be ready (it was created with --no-wait)
for i in {1..30}; do
  KV_ID=$(az keyvault show --name "$KV_NAME" --query id -o tsv 2>/dev/null || true)
  [[ -n "$KV_ID" ]] && break
  echo "  Waiting for Key Vault... ($i/30)"
  sleep 5
done

if [[ -z "$KV_ID" ]]; then
  echo "ERROR: Key Vault $KV_NAME not ready after 150s."
  exit 1
fi

az role assignment create \
  --assignee "$MI_PRINCIPAL_ID" \
  --role "Key Vault Secrets User" \
  --scope "$KV_ID" \
  -o none 2>/dev/null || true
echo "  Granted 'Key Vault Secrets User' on $KV_NAME."

# ── 4. Create Workload Identity Federation ─────────────────
echo ""
echo "▶ Step 4: Create Workload Identity federation"
if [[ -z "$OIDC_ISSUER" ]]; then
  echo "ERROR: AKS OIDC issuer URL not available. Set AKS_OIDC_ISSUER or run from infra/terraform dir."
  exit 1
fi

az identity federated-credential create \
  --name "fed-${TENANT_ID}" \
  --identity-name "$MI_NAME" \
  --resource-group "$RG_NAME" \
  --issuer "$OIDC_ISSUER" \
  --subject "system:serviceaccount:${NAMESPACE}:openclaw-${TENANT_ID}" \
  --audiences "api://AzureADTokenExchange" \
  -o none 2>/dev/null || true
echo "  Federated credential linked: K8s SA → Entra MI."

# ── 4b. Grant MI → Azure OpenAI (if resource exists) ───────
AOAI_NAME=$(az cognitiveservices account list --resource-group "$RG_NAME" --query "[?kind=='OpenAI'].name | [0]" -o tsv 2>/dev/null || true)
if [[ -n "$AOAI_NAME" ]]; then
  echo ""
  echo "▶ Step 4b: Grant MI → Azure OpenAI access"
  AOAI_ID=$(az cognitiveservices account show --name "$AOAI_NAME" --resource-group "$RG_NAME" --query id -o tsv)
  az role assignment create \
    --assignee "$MI_PRINCIPAL_ID" \
    --role "Cognitive Services OpenAI User" \
    --scope "$AOAI_ID" \
    -o none 2>/dev/null || true
  echo "  Granted 'Cognitive Services OpenAI User' on $AOAI_NAME."
fi

# ── 5. Get Entra tenant ID ────────────────────────────────
ENTRA_TENANT_ID=$(az account show --query tenantId -o tsv)

# ── 6. Deploy via Helm ─────────────────────────────────────
echo ""
echo "▶ Step 5: Deploy OpenClaw tenant via Helm"
# Use custom OpenClaw image with agent-browser/Chrome pre-installed (built from agent-warden-openclaw/Dockerfile)
OPENCLAW_IMAGE="${ACR_SERVER:+${ACR_SERVER}/openclaw-custom}"
helm upgrade --install "$HELM_RELEASE" "$CHART_PATH" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --set "tenantId=${TENANT_ID}" \
  --set "tier=${TIER}" \
  --set "keyVault.name=${KV_NAME}" \
  --set "keyVault.clientId=${MI_CLIENT_ID}" \
  --set "keyVault.tenantIdEntra=${ENTRA_TENANT_ID}" \
  ${OPENCLAW_IMAGE:+--set "image.repository=${OPENCLAW_IMAGE}"} \
  --wait \
  --timeout 5m

echo ""
echo "  Verifying deployment:"
kubectl get statefulset -n "$NAMESPACE"
kubectl get pods -n "$NAMESPACE"
kubectl get pvc -n "$NAMESPACE"

# ── 7. Verify health ──────────────────────────────────────
echo ""
echo "▶ Step 6: Wait for pod ready and verify health"
kubectl wait --for=condition=ready pod \
  -l "app.kubernetes.io/instance=${TENANT_ID}" \
  -n "$NAMESPACE" \
  --timeout=120s

echo ""
echo "  Running openclaw doctor inside pod..."
POD_NAME=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/instance=${TENANT_ID}" -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n "$NAMESPACE" "$POD_NAME" -c openclaw-gateway -- openclaw doctor 2>/dev/null || echo "  (openclaw doctor not available or returned error — check manually)"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Tenant $TENANT_ID provisioned successfully!                ║"
echo "║                                                             ║"
echo "║  Namespace:  $NAMESPACE                                     ║"
echo "║  Key Vault:  $KV_NAME                                      ║"
echo "║  Identity:   $MI_NAME ($MI_CLIENT_ID)                      ║"
echo "║  Tier:       $TIER                                          ║"
echo "║                                                             ║"
echo "║  Next: Add secrets to Key Vault:                            ║"
echo "║    az keyvault secret set --vault-name $KV_NAME \\          ║"
echo "║      --name openai-api-key --value 'sk-...'                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
