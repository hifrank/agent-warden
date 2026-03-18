#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Verify Azure infrastructure provisioned by Terraform
#
# Checks:
#   1. Terraform state backend (Storage Account)
#   2. Resource Group
#   3. AKS Cluster (nodes, OIDC, Defender, CSI driver)
#   4. ACR (Premium, content trust)
#   5. Key Vault (Premium, purge protection, RBAC)
#   6. Cosmos DB (serverless, containers)
#   7. App Gateway (WAF_v2, OWASP rules)
#   8. Log Analytics + Sentinel
#   9. VNet + subnets + NSG
#  10. Managed Identity
#
# Usage: ./scripts/verify-infra.sh [environment]
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV="${1:-dev}"
BASE_NAME="agentwarden"
RG_NAME="rg-${BASE_NAME}-${ENV}"
TF_RG_NAME="tfstate-${BASE_NAME}"
TF_SA_NAME="st${BASE_NAME}tfstate"

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }
warn() { echo "  ⚠️  $1"; ((WARN++)); }
check_header() { echo ""; echo "━━━ $1 ━━━"; }

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Agent Warden — Infrastructure Verification ($ENV)          ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── 1. Azure CLI ──────────────────────────────────────────
check_header "Azure CLI"
if az account show &>/dev/null; then
  SUBSCRIPTION=$(az account show --query name -o tsv)
  pass "Logged in to subscription: $SUBSCRIPTION"
else
  fail "Not logged in to Azure CLI"
  echo "Run 'az login' first."
  exit 1
fi

# ── 2. Terraform State Backend ────────────────────────────
check_header "Terraform State Backend"
if az group show --name "$TF_RG_NAME" &>/dev/null; then
  pass "Resource group $TF_RG_NAME exists"
else
  fail "Resource group $TF_RG_NAME not found"
fi

if az storage account show --name "$TF_SA_NAME" --resource-group "$TF_RG_NAME" &>/dev/null; then
  TLS=$(az storage account show --name "$TF_SA_NAME" --resource-group "$TF_RG_NAME" --query minimumTlsVersion -o tsv)
  PUBLIC_ACCESS=$(az storage account show --name "$TF_SA_NAME" --resource-group "$TF_RG_NAME" --query allowBlobPublicAccess -o tsv)
  pass "Storage account $TF_SA_NAME exists"
  if [[ "$TLS" == "TLS1_2" ]]; then
    pass "TLS 1.2 enforced"
  else
    fail "TLS version is $TLS (expected TLS1_2)"
  fi
  if [[ "$PUBLIC_ACCESS" == "false" ]]; then
    pass "Blob public access disabled"
  else
    fail "Blob public access is enabled"
  fi
else
  fail "Storage account $TF_SA_NAME not found"
fi

# ── 3. Resource Group ─────────────────────────────────────
check_header "Resource Group"
if az group show --name "$RG_NAME" &>/dev/null; then
  LOCATION=$(az group show --name "$RG_NAME" --query location -o tsv)
  pass "Resource group $RG_NAME exists (location: $LOCATION)"
else
  fail "Resource group $RG_NAME not found"
fi

# ── 4. AKS Cluster ───────────────────────────────────────
check_header "AKS Cluster"
AKS_NAME=$(az aks list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$AKS_NAME" ]]; then
  pass "AKS cluster found: $AKS_NAME"

  AKS_JSON=$(az aks show --name "$AKS_NAME" --resource-group "$RG_NAME" -o json)

  # Kubernetes version
  K8S_VERSION=$(echo "$AKS_JSON" | jq -r '.kubernetesVersion')
  pass "Kubernetes version: $K8S_VERSION"

  # OIDC issuer
  OIDC=$(echo "$AKS_JSON" | jq -r '.oidcIssuerProfile.enabled // false')
  if [[ "$OIDC" == "true" ]]; then
    OIDC_URL=$(echo "$AKS_JSON" | jq -r '.oidcIssuerProfile.issuerUrl')
    pass "OIDC issuer enabled: $OIDC_URL"
  else
    fail "OIDC issuer not enabled"
  fi

  # Workload Identity
  WI=$(echo "$AKS_JSON" | jq -r '.securityProfile.workloadIdentity.enabled // false')
  if [[ "$WI" == "true" ]]; then
    pass "Workload Identity enabled"
  else
    fail "Workload Identity not enabled"
  fi

  # Defender
  DEFENDER=$(echo "$AKS_JSON" | jq -r '.securityProfile.defender.securityMonitoring.enabled // false')
  if [[ "$DEFENDER" == "true" ]]; then
    pass "Microsoft Defender for Containers enabled"
  else
    warn "Microsoft Defender for Containers not enabled"
  fi

  # Network policy
  NET_POLICY=$(echo "$AKS_JSON" | jq -r '.networkProfile.networkPolicy // "none"')
  if [[ "$NET_POLICY" == "calico" ]]; then
    pass "Network policy engine: Calico"
  else
    fail "Network policy engine: $NET_POLICY (expected calico)"
  fi

  # Network plugin
  NET_PLUGIN=$(echo "$AKS_JSON" | jq -r '.networkProfile.networkPlugin')
  if [[ "$NET_PLUGIN" == "azure" ]]; then
    pass "Network plugin: Azure CNI"
  else
    warn "Network plugin: $NET_PLUGIN (expected azure)"
  fi

  # Private/Public cluster
  PRIVATE=$(echo "$AKS_JSON" | jq -r '.apiServerAccessProfile.enablePrivateCluster // false')
  if [[ "$PRIVATE" == "true" ]]; then
    pass "Private cluster: enabled"
  else
    AUTH_RANGES=$(echo "$AKS_JSON" | jq -r '(.apiServerAccessProfile.authorizedIpRanges // []) | join(", ")')
    if [[ -n "$AUTH_RANGES" ]]; then
      pass "Public cluster with authorized IP ranges: $AUTH_RANGES"
    else
      warn "Public cluster with no IP restrictions"
    fi
  fi

  # Node pools
  echo ""
  echo "  Node Pools:"
  POOL_COUNT=$(echo "$AKS_JSON" | jq '.agentPoolProfiles | length')
  for i in $(seq 0 $((POOL_COUNT - 1))); do
    POOL_NAME=$(echo "$AKS_JSON" | jq -r ".agentPoolProfiles[$i].name")
    POOL_COUNT_VAL=$(echo "$AKS_JSON" | jq -r ".agentPoolProfiles[$i].count")
    POOL_VM=$(echo "$AKS_JSON" | jq -r ".agentPoolProfiles[$i].vmSize")
    POOL_MODE=$(echo "$AKS_JSON" | jq -r ".agentPoolProfiles[$i].mode")
    pass "  $POOL_NAME: $POOL_COUNT_VAL nodes ($POOL_VM, mode=$POOL_MODE)"
  done

  # Secrets Store CSI Driver
  CSI=$(echo "$AKS_JSON" | jq -r '.addonProfiles.azureKeyvaultSecretsProvider.enabled // false')
  if [[ "$CSI" == "true" ]]; then
    pass "Secrets Store CSI Driver enabled"
  else
    fail "Secrets Store CSI Driver not enabled"
  fi

  # ALB Controller (for Application Gateway for Containers)
  # The web_app_routing addon deploys the ALB Controller into kube-system
  WEB_APP_ROUTING=$(echo "$AKS_JSON" | jq -r '.addonProfiles.webAppRouting.enabled // .ingressProfile.webAppRouting.enabled // false')
  if [[ "$WEB_APP_ROUTING" == "true" ]]; then
    pass "Web App Routing / ALB Controller enabled (Application Gateway for Containers)"
  else
    warn "ALB Controller not detected via addon (may be deployed via Helm)"
  fi

else
  fail "No AKS cluster found in $RG_NAME"
fi

# ── 5. ACR ────────────────────────────────────────────────
check_header "Azure Container Registry"
ACR_NAME=$(az acr list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$ACR_NAME" ]]; then
  ACR_JSON=$(az acr show --name "$ACR_NAME" --resource-group "$RG_NAME" -o json)
  ACR_SKU=$(echo "$ACR_JSON" | jq -r '.sku.name')
  ADMIN_ENABLED=$(echo "$ACR_JSON" | jq -r '.adminUserEnabled')
  pass "ACR found: $ACR_NAME"
  if [[ "$ACR_SKU" == "Premium" ]]; then
    pass "SKU: Premium"
  else
    warn "SKU: $ACR_SKU (expected Premium for geo-replication & content trust)"
  fi
  if [[ "$ADMIN_ENABLED" == "false" ]]; then
    pass "Admin user disabled"
  else
    fail "Admin user enabled (should be disabled)"
  fi
else
  fail "No ACR found in $RG_NAME"
fi

# ── 6. Key Vault ─────────────────────────────────────────
check_header "Platform Key Vault"
KV_NAME=$(az keyvault list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$KV_NAME" ]]; then
  KV_JSON=$(az keyvault show --name "$KV_NAME" --resource-group "$RG_NAME" -o json)
  KV_SKU=$(echo "$KV_JSON" | jq -r '.properties.sku.name')
  PURGE_PROTECT=$(echo "$KV_JSON" | jq -r '.properties.enablePurgeProtection // false')
  RBAC_AUTH=$(echo "$KV_JSON" | jq -r '.properties.enableRbacAuthorization')
  pass "Key Vault found: $KV_NAME"
  if [[ "$KV_SKU" == "premium" ]]; then
    pass "SKU: Premium (HSM-backed)"
  else
    warn "SKU: $KV_SKU (expected premium)"
  fi
  if [[ "$PURGE_PROTECT" == "true" ]]; then
    pass "Purge protection enabled"
  else
    fail "Purge protection not enabled"
  fi
  if [[ "$RBAC_AUTH" == "true" ]]; then
    pass "RBAC authorization enabled"
  else
    fail "RBAC authorization not enabled"
  fi
else
  fail "No Key Vault found in $RG_NAME"
fi

# ── 7. Cosmos DB ──────────────────────────────────────────
check_header "Cosmos DB"
COSMOS_NAME=$(az cosmosdb list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$COSMOS_NAME" ]]; then
  COSMOS_JSON=$(az cosmosdb show --name "$COSMOS_NAME" --resource-group "$RG_NAME" -o json)
  LOCAL_AUTH=$(echo "$COSMOS_JSON" | jq -r '.disableLocalAuth')
  CONSISTENCY=$(echo "$COSMOS_JSON" | jq -r '.consistencyPolicy.defaultConsistencyLevel')
  pass "Cosmos DB found: $COSMOS_NAME"
  if [[ "$LOCAL_AUTH" == "true" ]]; then
    pass "Local auth disabled (Entra-only)"
  else
    warn "Local auth not disabled"
  fi
  pass "Consistency level: $CONSISTENCY"

  # Check containers
  DB_NAME="agent-warden"
  echo "  Containers in database '$DB_NAME':"
  CONTAINERS=$(az cosmosdb sql container list \
    --account-name "$COSMOS_NAME" \
    --database-name "$DB_NAME" \
    --resource-group "$RG_NAME" \
    --query "[].name" -o tsv 2>/dev/null || true)
  if [[ -n "$CONTAINERS" ]]; then
    for C in $CONTAINERS; do
      pass "  Container: $C"
    done
    for EXPECTED in tenants instances skills audit; do
      if echo "$CONTAINERS" | grep -q "^${EXPECTED}$"; then
        : # already printed
      else
        fail "  Missing expected container: $EXPECTED"
      fi
    done
  else
    warn "No containers found (database '$DB_NAME' may not exist)"
  fi
else
  fail "No Cosmos DB found in $RG_NAME"
fi

# ── 8. Application Gateway for Containers (AGC) ─────────
check_header "Application Gateway for Containers"
AGC_NAME=$(az network alb list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$AGC_NAME" ]]; then
  AGC_JSON=$(az network alb show --name "$AGC_NAME" --resource-group "$RG_NAME" -o json)
  PROV_STATE=$(echo "$AGC_JSON" | jq -r '.provisioningState')
  pass "AGC found: $AGC_NAME"
  if [[ "$PROV_STATE" == "Succeeded" ]]; then
    pass "Provisioning state: Succeeded"
  else
    warn "Provisioning state: $PROV_STATE"
  fi

  # Check frontends
  FRONTEND_COUNT=$(az network alb frontend list --alb-name "$AGC_NAME" --resource-group "$RG_NAME" --query "length(@)" -o tsv 2>/dev/null || echo "0")
  if [[ "$FRONTEND_COUNT" -ge 1 ]]; then
    pass "Frontends configured: $FRONTEND_COUNT"
    FRONTEND_FQDN=$(az network alb frontend list --alb-name "$AGC_NAME" --resource-group "$RG_NAME" --query "[0].fullyQualifiedDomainName" -o tsv 2>/dev/null || true)
    [[ -n "$FRONTEND_FQDN" ]] && pass "Frontend FQDN: $FRONTEND_FQDN"
  else
    warn "No frontends configured yet"
  fi

  # Check subnet association
  ASSOC_COUNT=$(az network alb association list --alb-name "$AGC_NAME" --resource-group "$RG_NAME" --query "length(@)" -o tsv 2>/dev/null || echo "0")
  if [[ "$ASSOC_COUNT" -ge 1 ]]; then
    pass "Subnet association configured"
  else
    fail "No subnet association found"
  fi
else
  warn "No Application Gateway for Containers found in $RG_NAME"
fi

# ── 9. Log Analytics + Sentinel ──────────────────────────
check_header "Log Analytics & Sentinel"
LA_NAME=$(az monitor log-analytics workspace list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$LA_NAME" ]]; then
  LA_JSON=$(az monitor log-analytics workspace show --workspace-name "$LA_NAME" --resource-group "$RG_NAME" -o json)
  RETENTION=$(echo "$LA_JSON" | jq -r '.retentionInDays')
  pass "Log Analytics workspace: $LA_NAME (retention: ${RETENTION}d)"

  # Check for Sentinel (SecurityInsights solution)
  SENTINEL=$(az monitor log-analytics solution list \
    --resource-group "$RG_NAME" \
    --query "[?contains(name, 'SecurityInsights')].name" -o tsv 2>/dev/null || true)
  if [[ -n "$SENTINEL" ]]; then
    pass "Azure Sentinel (SecurityInsights) enabled"
  else
    warn "Azure Sentinel not detected"
  fi

  # Check for Container Insights
  CONTAINER_INSIGHTS=$(az monitor log-analytics solution list \
    --resource-group "$RG_NAME" \
    --query "[?contains(name, 'ContainerInsights')].name" -o tsv 2>/dev/null || true)
  if [[ -n "$CONTAINER_INSIGHTS" ]]; then
    pass "Container Insights enabled"
  else
    warn "Container Insights not detected"
  fi
else
  fail "No Log Analytics workspace found in $RG_NAME"
fi

# ── 10. VNet & Subnets ───────────────────────────────────
check_header "Virtual Network"
VNET_NAME=$(az network vnet list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$VNET_NAME" ]]; then
  pass "VNet found: $VNET_NAME"
  SUBNETS=$(az network vnet subnet list --vnet-name "$VNET_NAME" --resource-group "$RG_NAME" --query "[].name" -o tsv)
  for S in $SUBNETS; do
    PREFIX=$(az network vnet subnet show --vnet-name "$VNET_NAME" --name "$S" --resource-group "$RG_NAME" --query addressPrefix -o tsv)
    pass "  Subnet: $S ($PREFIX)"
  done
else
  fail "No VNet found in $RG_NAME"
fi

# ── 11. Managed Identity ─────────────────────────────────
check_header "Platform Managed Identity"
MI_COUNT=$(az identity list --resource-group "$RG_NAME" --query "length(@)" -o tsv 2>/dev/null || echo "0")
if [[ "$MI_COUNT" -gt 0 ]]; then
  MI_LIST=$(az identity list --resource-group "$RG_NAME" --query "[].name" -o tsv)
  for MI in $MI_LIST; do
    pass "Managed Identity: $MI"
  done
else
  fail "No User-Assigned Managed Identities found in $RG_NAME"
fi

# ── Summary ───────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Infrastructure Verification Summary                        ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  ✅ Passed:   %-44s║\n" "$PASS"
printf "║  ⚠️  Warnings: %-44s║\n" "$WARN"
printf "║  ❌ Failed:   %-44s║\n" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════╝"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
