#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Suspend a tenant — scale pods to 0, retain all PVC data
#
# Usage: ./scripts/suspend-tenant.sh <tenant-id>
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

TENANT_ID="${1:?Usage: $0 <tenant-id>}"
NAMESPACE="tenant-${TENANT_ID}"

echo "Suspending tenant $TENANT_ID..."

# Scale StatefulSet to 0
kubectl scale statefulset "openclaw-${TENANT_ID}" \
  --replicas=0 \
  --namespace "$NAMESPACE"

echo "  StatefulSet scaled to 0."

# Verify pods gone
kubectl wait --for=delete pod \
  -l "app.kubernetes.io/instance=${TENANT_ID}" \
  -n "$NAMESPACE" \
  --timeout=60s 2>/dev/null || true

echo "  PVCs retained:"
kubectl get pvc -n "$NAMESPACE"

echo ""
echo "Tenant $TENANT_ID suspended. Data is preserved."
echo "Resume with: kubectl scale statefulset openclaw-${TENANT_ID} --replicas=1 -n ${NAMESPACE}"
