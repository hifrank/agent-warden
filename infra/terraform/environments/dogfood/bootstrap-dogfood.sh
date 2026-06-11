#!/usr/bin/env bash
# bootstrap-dogfood.sh — Bootstrap infrastructure prerequisites in the new tenant/subscription
#
# Creates:
#   1. Resource group for Terraform state (tfstate-agentwarden)
#   2. Storage account + container for state backend
#   3. Resource group for compute resources (rg-agentwarden-dev)
#
# Prerequisites:
#   - az login --tenant dab94ed2-4cee-4b36-b007-6618f570b4a3
#   - Owner or Contributor role on subscription 528423b5-a9b1-413b-a582-27dc93b0fc78

set -euo pipefail

TENANT_ID="dab94ed2-4cee-4b36-b007-6618f570b4a3"
SUBSCRIPTION_ID="528423b5-a9b1-413b-a582-27dc93b0fc78"
LOCATION="eastus2"

TFSTATE_RG="tfstate-agentwarden"
TFSTATE_SA="stawardendogfoodtfst"
TFSTATE_CONTAINER="tfstate"

COMPUTE_RG="rg-agentwarden-dev"

echo "═══════════════════════════════════════════════════════════"
echo "  Agent Warden — Bootstrap dogfood (tenant ${TENANT_ID:0:8}...)"
echo "═══════════════════════════════════════════════════════════"

# Verify correct tenant context
CURRENT_TENANT=$(az account show --query tenantId -o tsv 2>/dev/null || true)
if [[ "$CURRENT_TENANT" != "$TENANT_ID" ]]; then
  echo "⚠ Current tenant is $CURRENT_TENANT, expected $TENANT_ID"
  echo "  Run: az login --tenant $TENANT_ID"
  exit 1
fi

# Set subscription
echo "→ Setting subscription to $SUBSCRIPTION_ID"
az account set --subscription "$SUBSCRIPTION_ID"

# 1. Terraform state resource group
echo "→ Creating Terraform state RG: $TFSTATE_RG"
az group create \
  --name "$TFSTATE_RG" \
  --location "$LOCATION" \
  --tags project=agent-warden managed_by=bootstrap \
  --output none

# 2. Storage account for Terraform state
echo "→ Creating storage account: $TFSTATE_SA"
az storage account create \
  --name "$TFSTATE_SA" \
  --resource-group "$TFSTATE_RG" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false \
  --https-only true \
  --tags project=agent-warden managed_by=bootstrap \
  --output none

echo "→ Creating blob container: $TFSTATE_CONTAINER"
az storage container create \
  --name "$TFSTATE_CONTAINER" \
  --account-name "$TFSTATE_SA" \
  --auth-mode login \
  --output none

# Assign Storage Blob Data Contributor to current user
CURRENT_USER=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
if [[ -n "$CURRENT_USER" ]]; then
  echo "→ Assigning Storage Blob Data Contributor to current user"
  az role assignment create \
    --role "Storage Blob Data Contributor" \
    --assignee "$CURRENT_USER" \
    --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$TFSTATE_RG/providers/Microsoft.Storage/storageAccounts/$TFSTATE_SA" \
    --output none 2>/dev/null || echo "  (role assignment may already exist)"
fi

# 3. Compute resource group
echo "→ Creating compute RG: $COMPUTE_RG"
az group create \
  --name "$COMPUTE_RG" \
  --location "$LOCATION" \
  --tags project=agent-warden environment=dev managed_by=terraform \
  --output none

# 4. Register required resource providers
echo "→ Registering resource providers..."
for PROVIDER in \
  Microsoft.ContainerService \
  Microsoft.ContainerRegistry \
  Microsoft.DocumentDB \
  Microsoft.KeyVault \
  Microsoft.Network \
  Microsoft.OperationalInsights \
  Microsoft.Insights \
  Microsoft.ManagedIdentity \
  Microsoft.ServiceLinker \
  Microsoft.ServiceNetworking; do
  az provider register --namespace "$PROVIDER" --output none 2>/dev/null &
done
wait
echo "  Resource providers registration initiated"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Bootstrap complete!"
echo ""
echo "  Next steps:"
echo "    1. Create an Entra ID group for AKS admin RBAC"
echo "       az ad group create --display-name 'AKS-Admins-AgentWarden' \\"
echo "         --mail-nickname 'aks-admins-agentwarden'"
echo "       export TF_VAR_aks_admin_group_object_id=<group-object-id>"
echo ""
echo "    2. Initialize Terraform:"
echo "       cd infra/terraform"
echo "       terraform init -backend-config=environments/dogfood/backend.tfvars -reconfigure"
echo ""
echo "    3. Plan & apply:"
echo "       terraform plan -var-file=environments/dogfood/terraform.tfvars -out=tfplan-dogfood"
echo "       terraform apply tfplan-dogfood"
echo "═══════════════════════════════════════════════════════════"
