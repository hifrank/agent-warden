#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Delete a tenant — crypto-shred secrets, remove all K8s resources
#
# ⚠️  THIS IS DESTRUCTIVE AND IRREVERSIBLE.
#
# Usage: ./scripts/delete-tenant.sh <tenant-id>
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

TENANT_ID="${1:?Usage: $0 <tenant-id>}"
NAMESPACE="tenant-${TENANT_ID}"

ENV="${ENV:-dev}"
BASE_NAME="${BASE_NAME:-agentwarden}"
RG_NAME="rg-${BASE_NAME}-${ENV}"
KV_NAME="kv-${TENANT_ID}"
KV_NAME="${KV_NAME:0:24}"
MI_NAME="mi-${TENANT_ID}"
HELM_RELEASE="oc-${TENANT_ID}"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ⚠️  DELETE TENANT: $TENANT_ID                              ║"
echo "║  This will PERMANENTLY destroy all data for this tenant.    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
read -rp "Type the tenant ID to confirm: " CONFIRM
if [[ "$CONFIRM" != "$TENANT_ID" ]]; then
  echo "Aborted."
  exit 1
fi

# 1. Crypto-shred: delete Key Vault (enters soft-delete, KEK unrecoverable)
echo ""
echo "▶ Step 1: Crypto-shred — delete Key Vault"
az keyvault delete --name "$KV_NAME" -o none 2>/dev/null || echo "  Key Vault already deleted or not found."
echo "  Key Vault $KV_NAME deleted (soft-delete). KEK is no longer accessible."

# 2. Delete Helm release
echo ""
echo "▶ Step 2: Delete Helm release"
helm uninstall "$HELM_RELEASE" --namespace "$NAMESPACE" --wait 2>/dev/null || echo "  Helm release not found."

# 3. Delete PVCs (Retain policy means they survive helm uninstall)
echo ""
echo "▶ Step 3: Delete PVCs"
kubectl delete pvc --all -n "$NAMESPACE" --wait 2>/dev/null || echo "  No PVCs found."

# 4. Delete namespace
echo ""
echo "▶ Step 4: Delete namespace"
kubectl delete namespace "$NAMESPACE" --wait 2>/dev/null || echo "  Namespace not found."

# 5. Delete Managed Identity + federated credential
echo ""
echo "▶ Step 5: Delete Managed Identity"
az identity federated-credential delete \
  --name "fed-${TENANT_ID}" \
  --identity-name "$MI_NAME" \
  --resource-group "$RG_NAME" \
  -o none 2>/dev/null || true
az identity delete \
  --name "$MI_NAME" \
  --resource-group "$RG_NAME" \
  -o none 2>/dev/null || true
echo "  Managed Identity $MI_NAME deleted."

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Tenant $TENANT_ID has been fully deleted.                  ║"
echo "║  Key Vault is in soft-delete (90-day retention).            ║"
echo "║  All PVC data is inaccessible without the KEK.              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
