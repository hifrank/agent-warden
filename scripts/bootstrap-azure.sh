#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Phase 0 / Phase 1: Bootstrap Azure infrastructure for agent-warden
#
# Prerequisites:
#   - Azure CLI (az) >= 2.60 logged in
#   - Terraform >= 1.7
#   - Helm >= 3.14
#   - kubectl >= 1.30
#   - kubelogin (brew install Azure/kubelogin/kubelogin)
#   - jq
#
# Usage:
#   ./scripts/bootstrap-azure.sh <environment> [location]
#   Example: ./scripts/bootstrap-azure.sh dev eastus2
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV="${1:?Usage: $0 <environment> [location]}"
LOCATION="${2:-eastus2}"
BASE_NAME="agentwarden"
RG_NAME="rg-${BASE_NAME}-${ENV}"
TF_RG_NAME="tfstate-${BASE_NAME}"
TF_SA_NAME="st${BASE_NAME}tfstate"
TF_CONTAINER="tfstate"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Agent Warden — Azure Bootstrap ($ENV / $LOCATION)         ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── 0. Check prerequisites ────────────────────────────────
echo ""
echo "▶ Step 0: Check prerequisites"
for CMD in az terraform helm kubectl kubelogin jq; do
  if command -v "$CMD" &>/dev/null; then
    echo "  ✓ $CMD found"
  else
    echo "  ✗ $CMD not found. Please install it first."
    [[ "$CMD" == "kubelogin" ]] && echo "    brew install Azure/kubelogin/kubelogin"
    exit 1
  fi
done

# ── 1. Verify Azure login ─────────────────────────────────
echo ""
echo "▶ Step 1: Verify Azure CLI login"
az account show -o table || { echo "ERROR: Not logged in. Run 'az login' first."; exit 1; }
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "  Subscription: $SUBSCRIPTION_ID"
echo "  Tenant:       $TENANT_ID"

# ── 2. Create Terraform state backend ─────────────────────
echo ""
echo "▶ Step 2: Create Terraform state backend (Storage Account)"
if az group show --name "$TF_RG_NAME" &>/dev/null; then
  echo "  Resource group $TF_RG_NAME already exists."
else
  az group create --name "$TF_RG_NAME" --location "$LOCATION" -o none
  echo "  Created resource group $TF_RG_NAME."
fi

if az storage account show --name "$TF_SA_NAME" --resource-group "$TF_RG_NAME" &>/dev/null; then
  echo "  Storage account $TF_SA_NAME already exists."
else
  az storage account create \
    --name "$TF_SA_NAME" \
    --resource-group "$TF_RG_NAME" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --min-tls-version TLS1_2 \
    --allow-blob-public-access false \
    --public-network-access Enabled \
    -o none
  echo "  Created storage account $TF_SA_NAME."
fi

# Ensure public network access is enabled (subscription policies may disable it)
PUBLIC_NET=$(az storage account show --name "$TF_SA_NAME" --resource-group "$TF_RG_NAME" --query publicNetworkAccess -o tsv 2>/dev/null || true)
if [[ "$PUBLIC_NET" == "Disabled" ]]; then
  echo "  Enabling public network access on state storage..."
  az storage account update --name "$TF_SA_NAME" --resource-group "$TF_RG_NAME" --public-network-access Enabled -o none
fi

az storage container create \
  --name "$TF_CONTAINER" \
  --account-name "$TF_SA_NAME" \
  --auth-mode login \
  -o none 2>/dev/null || true
echo "  Blob container '$TF_CONTAINER' ready."

# ── 3. Create main resource group ─────────────────────────
echo ""
echo "▶ Step 3: Create main resource group"
if az group show --name "$RG_NAME" &>/dev/null; then
  echo "  Resource group $RG_NAME already exists."
else
  az group create --name "$RG_NAME" --location "$LOCATION" -o none
  echo "  Created resource group $RG_NAME."
fi

# ── 4. Create Entra ID admin group for AKS ────────────────
echo ""
echo "▶ Step 4: Create Entra ID admin group for AKS RBAC"
AKS_ADMIN_GROUP="sg-${BASE_NAME}-${ENV}-aks-admins"
EXISTING_GROUP=$(az ad group show --group "$AKS_ADMIN_GROUP" --query id -o tsv 2>/dev/null || true)
if [[ -n "$EXISTING_GROUP" ]]; then
  echo "  Group $AKS_ADMIN_GROUP already exists: $EXISTING_GROUP"
  GROUP_ID="$EXISTING_GROUP"
else
  GROUP_ID=$(az ad group create \
    --display-name "$AKS_ADMIN_GROUP" \
    --mail-nickname "$AKS_ADMIN_GROUP" \
    --query id -o tsv)
  echo "  Created group $AKS_ADMIN_GROUP: $GROUP_ID"
fi

# Add current user to admin group
CURRENT_USER_ID=$(az ad signed-in-user show --query id -o tsv)
az ad group member add --group "$GROUP_ID" --member-id "$CURRENT_USER_ID" 2>/dev/null || true
echo "  Current user added to AKS admin group."

# ── 5. Run Terraform ──────────────────────────────────────
echo ""
echo "▶ Step 5: Run Terraform (infra/terraform)"
cd "$(dirname "$0")/../infra/terraform"

terraform init \
  -backend-config="environments/${ENV}/backend.tfvars" \
  -reconfigure

terraform plan \
  -var-file="environments/${ENV}/terraform.tfvars" \
  -var="aks_admin_group_object_id=${GROUP_ID}" \
  -out="tfplan-${ENV}"

echo ""
echo "  ╔════════════════════════════════════════════════════════╗"
echo "  ║  Review the plan above. Apply with:                    ║"
echo "  ║  terraform apply \"tfplan-${ENV}\"                       ║"
echo "  ╚════════════════════════════════════════════════════════╝"
echo ""
read -rp "  Apply now? (y/N) " APPLY
if [[ "$APPLY" =~ ^[Yy]$ ]]; then
  terraform apply "tfplan-${ENV}"
  echo ""
  echo "  ✓ Terraform apply complete."

  # Capture outputs
  AKS_NAME=$(terraform output -raw aks_cluster_name)
  ACR_SERVER=$(terraform output -raw acr_login_server)
  COSMOS_ENDPOINT=$(terraform output -raw cosmos_endpoint)
  KV_URI=$(terraform output -raw keyvault_uri)
  OIDC_ISSUER=$(terraform output -raw aks_oidc_issuer_url)

  echo ""
  echo "  Outputs:"
  echo "    AKS Cluster:     $AKS_NAME"
  echo "    ACR Server:      $ACR_SERVER"
  echo "    Cosmos Endpoint: $COSMOS_ENDPOINT"
  echo "    Key Vault URI:   $KV_URI"
  echo "    OIDC Issuer:     $OIDC_ISSUER"
else
  echo "  Skipped. Run 'terraform apply tfplan-${ENV}' when ready."
  exit 0
fi

cd - >/dev/null

# ── 6. Connect to AKS ─────────────────────────────────────
echo ""
echo "▶ Step 6: Connect to AKS cluster"
az aks get-credentials --name "$AKS_NAME" --resource-group "$RG_NAME" --overwrite-existing
kubelogin convert-kubeconfig -l azurecli
echo "  kubeconfig converted for Azure CLI auth via kubelogin."
kubectl get nodes -o wide

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── 7. Apply cluster-level K8s resources ───────────────────
echo ""
echo "▶ Step 7: Apply StorageClasses, RBAC, CRD, Gateway API, RuntimeClass"

# Gateway API CRDs (must be installed before Gateway resources)
echo "  Installing Gateway API CRDs..."
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml 2>&1 | tail -5

kubectl apply -f "$REPO_ROOT/k8s/base/storage/"
kubectl apply -f "$REPO_ROOT/k8s/base/rbac/"
kubectl apply -f "$REPO_ROOT/k8s/operator/config/crd/"
kubectl apply -f "$REPO_ROOT/k8s/base/sandbox/runtime-class.yaml"

echo ""
echo "  Verifying StorageClasses:"
kubectl get storageclass | grep managed-

echo ""
echo "  Verifying CRD:"
kubectl get crd openclawtenants.openclaw.io

# ── 8. Create system namespace + ServiceAccount + operator ─
echo ""
echo "▶ Step 8: Create agent-warden-system namespace & operator"
kubectl create namespace agent-warden-system 2>/dev/null || true
kubectl label namespace agent-warden-system app.kubernetes.io/part-of=agent-warden 2>/dev/null || true

# Gateway resource (depends on namespace)
kubectl apply -f "$REPO_ROOT/k8s/base/gateway/gateway.yaml"

# Monitoring CronJob
kubectl apply -f "$REPO_ROOT/k8s/base/monitoring/health-check-cronjob.yaml" 2>/dev/null || true

# ServiceAccount for operator (referenced by deployment)
kubectl create serviceaccount agent-warden-operator -n agent-warden-system 2>/dev/null || true
echo "  ServiceAccount agent-warden-operator created."

# ── 9. Build & push operator + MCP server images ──────────
echo ""
echo "▶ Step 9: Build and push container images"
echo "  Logging in to ACR..."
az acr login --name "${ACR_SERVER%%.*}"

echo ""
echo "  Building agent-warden-server..."
cd "$REPO_ROOT/agent-warden-server"
npm ci
npm run build
cd "$REPO_ROOT"

echo ""
echo "  Building operator..."
cd "$REPO_ROOT/k8s/operator"
npm ci
npm run build
cd "$REPO_ROOT"

# ── 10. Build & push Docker images to ACR ──────────────────
echo ""
echo "▶ Step 10: Build and push Docker images to ACR"
ACR_SHORT="${ACR_SERVER%%.*}"

IMAGES=(
  "agent-warden-saas-proxy:agent-warden-saas-proxy"
  "agent-warden-operator:k8s/operator"
  "sandbox-monitor:sandbox-monitor"
)

for IMG_ENTRY in "${IMAGES[@]}"; do
  IMG_NAME="${IMG_ENTRY%%:*}"
  IMG_DIR="${IMG_ENTRY##*:}"
  if [[ -f "$REPO_ROOT/$IMG_DIR/Dockerfile" ]]; then
    echo "  Building $IMG_NAME from $IMG_DIR/..."
    az acr build --registry "$ACR_SHORT" --image "$IMG_NAME:latest" --file "$REPO_ROOT/$IMG_DIR/Dockerfile" "$REPO_ROOT/$IMG_DIR" 2>&1 | tail -3
  else
    echo "  ⚠  Skipping $IMG_NAME — no Dockerfile at $IMG_DIR/"
  fi
done

echo ""
echo "  Importing OpenClaw image (if not already in ACR)..."
az acr import --name "$ACR_SHORT" --source docker.io/alpine/openclaw:2026.3.12 --image openclaw:2026.3.12 2>/dev/null || echo "  (already imported or unavailable)"

# ── 11. Deploy operator ───────────────────────────────────
echo ""
echo "▶ Step 11: Deploy operator"
if [[ -f "$REPO_ROOT/k8s/operator/deploy/operator-deployment.yaml" ]]; then
  kubectl apply -f "$REPO_ROOT/k8s/operator/deploy/operator-deployment.yaml"
  kubectl rollout status deployment/agent-warden-operator -n agent-warden-system --timeout=60s 2>/dev/null || true
  echo "  Operator deployed."
else
  echo "  ⚠  Operator deployment manifest not found. Deploy manually."
fi

# ── 12. Purview Data Map Bootstrap (cross-tenant) ─────────
echo ""
echo "▶ Step 12: Purview Data Map bootstrap (E5 tenant ecardpoc4ecv)"
echo ""
echo "  PRE-REQUISITE: In the ecardpoc4ecv Purview portal, grant these roles"
echo "  to app registration d94c93dd-3c80-4f3d-9671-8b71a7dccafa:"
echo "    - Data Curator"
echo "    - Data Reader"
echo "    - Data Source Administrator"
echo ""

PURVIEW_ACCOUNT=$(cd "$REPO_ROOT/infra/terraform" && terraform output -raw purview_catalog_endpoint 2>/dev/null || echo "")

if [[ -z "$PURVIEW_ACCOUNT" ]]; then
  echo "  ⚠  Could not read purview_catalog_endpoint from Terraform. Skipping."
else
  # Acquire token for Purview Data Map API (cross-tenant)
  PURVIEW_TOKEN=""
  if [[ -n "${PURVIEW_DLP_CLIENT_ID:-}" && -n "${PURVIEW_DLP_CLIENT_SECRET:-}" && -n "${PURVIEW_DLP_TENANT_ID:-}" ]]; then
    echo "  Acquiring cross-tenant token for Purview Data Map..."
    PURVIEW_TOKEN=$(curl -s -X POST \
      "https://login.microsoftonline.com/${PURVIEW_DLP_TENANT_ID}/oauth2/v2.0/token" \
      -d "client_id=${PURVIEW_DLP_CLIENT_ID}" \
      -d "client_secret=${PURVIEW_DLP_CLIENT_SECRET}" \
      -d "scope=https://purview.azure.net/.default" \
      -d "grant_type=client_credentials" | jq -r '.access_token // empty')
  fi

  if [[ -z "$PURVIEW_TOKEN" ]]; then
    echo "  ⚠  Could not acquire Purview token. Set PURVIEW_DLP_CLIENT_ID,"
    echo "     PURVIEW_DLP_CLIENT_SECRET, PURVIEW_DLP_TENANT_ID and re-run."
  else
    # 12a. Register custom entity types
    echo "  Registering custom entity types (openclaw_tenant, saas_resource, etc.)..."
    TYPE_RESULT=$(curl -s -w "\n%{http_code}" -X POST \
      "${PURVIEW_ACCOUNT}/datamap/api/atlas/v2/types/typedefs?api-version=2023-09-01" \
      -H "Authorization: Bearer ${PURVIEW_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{
        "entityDefs": [
          {
            "name": "openclaw_tenant",
            "superTypes": ["DataSet"],
            "serviceType": "Agent Warden",
            "typeVersion": "1.0",
            "description": "An OpenClaw tenant agent instance managed by Agent Warden",
            "attributeDefs": [
              {"name":"tier","typeName":"string","isOptional":true},
              {"name":"region","typeName":"string","isOptional":true},
              {"name":"activeChannels","typeName":"array<string>","isOptional":true}
            ]
          },
          {
            "name": "openclaw_conversation",
            "superTypes": ["DataSet"],
            "serviceType": "Agent Warden",
            "typeVersion": "1.0",
            "description": "A user conversation session with an OpenClaw agent",
            "attributeDefs": [
              {"name":"channel","typeName":"string","isOptional":true},
              {"name":"messageCount","typeName":"int","isOptional":true},
              {"name":"startedAt","typeName":"string","isOptional":true}
            ]
          },
          {
            "name": "openclaw_agent_process",
            "superTypes": ["Process"],
            "serviceType": "Agent Warden",
            "typeVersion": "1.0",
            "description": "Agent processing a user request",
            "attributeDefs": [
              {"name":"traceId","typeName":"string","isOptional":false},
              {"name":"toolsUsed","typeName":"array<string>","isOptional":true},
              {"name":"durationMs","typeName":"long","isOptional":true},
              {"name":"dlpViolations","typeName":"int","isOptional":true}
            ]
          },
          {
            "name": "llm_invocation",
            "superTypes": ["Process"],
            "serviceType": "Agent Warden",
            "typeVersion": "1.0",
            "description": "An LLM call that transforms data during agent processing",
            "attributeDefs": [
              {"name":"model","typeName":"string","isOptional":true},
              {"name":"promptTokens","typeName":"long","isOptional":true},
              {"name":"completionTokens","typeName":"long","isOptional":true},
              {"name":"provider","typeName":"string","isOptional":true}
            ]
          },
          {
            "name": "saas_resource",
            "superTypes": ["DataSet"],
            "serviceType": "Agent Warden",
            "typeVersion": "1.0",
            "description": "A SaaS resource accessed by an OpenClaw agent",
            "attributeDefs": [
              {"name":"provider","typeName":"string","isOptional":false},
              {"name":"resourceType","typeName":"string","isOptional":false},
              {"name":"resourceId","typeName":"string","isOptional":true},
              {"name":"lastAccessedAt","typeName":"string","isOptional":true},
              {"name":"accessCount","typeName":"int","isOptional":true}
            ]
          }
        ]
      }')

    TYPE_HTTP=$(echo "$TYPE_RESULT" | tail -1)
    if [[ "$TYPE_HTTP" =~ ^2 ]]; then
      echo "  ✓ Custom types registered (HTTP $TYPE_HTTP)"
    else
      echo "  ⚠  Type registration returned HTTP $TYPE_HTTP (may already exist — that's OK)"
    fi

    # 12b. Create root collection
    ROOT_COLLECTION="agent-warden-platform"
    echo "  Creating root collection '${ROOT_COLLECTION}'..."
    COLL_RESULT=$(curl -s -w "\n%{http_code}" -X PUT \
      "${PURVIEW_ACCOUNT}/collections/${ROOT_COLLECTION}?api-version=2019-11-01-preview" \
      -H "Authorization: Bearer ${PURVIEW_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"friendlyName\": \"Agent Warden Platform\", \"description\": \"Root collection for Agent Warden tenant governance\"}")

    COLL_HTTP=$(echo "$COLL_RESULT" | tail -1)
    if [[ "$COLL_HTTP" =~ ^2 ]]; then
      echo "  ✓ Root collection created (HTTP $COLL_HTTP)"
    else
      echo "  ⚠  Collection creation returned HTTP $COLL_HTTP"
    fi
  fi
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Bootstrap complete!                                        ║"
echo "║                                                             ║"
echo "║  Next steps:                                                ║"
echo "║  1. Provision your first tenant:                            ║"
echo "║     ./scripts/provision-tenant.sh <tenant-id> <tier> <email>║"
echo "║                                                             ║"
echo "║  2. Set tenant secrets (API keys, etc.):                    ║"
echo "║     ./scripts/set-tenant-secrets.sh <tenant-id>             ║"
echo "║                                                             ║"
echo "║  See docs/DEPLOYMENT.md for full instructions.              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
