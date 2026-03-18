#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Verify Kubernetes base resources (cluster-wide)
#
# Checks:
#   1. kubectl connectivity
#   2. StorageClasses (premium-zrs, premium-lrs, standard-zrs)
#   3. CRD (openclawtenants.openclaw.io)
#   4. Operator RBAC (ServiceAccount, ClusterRole, ClusterRoleBinding)
#   5. System namespace (agent-agent-warden-system)
#   6. Secrets Store CSI Driver pods
#   7. Calico / Network Policy controller
#   8. Health-check CronJob
#   9. Node readiness & taints
#  10. Cluster DNS resolution
#
# Usage: ./scripts/verify-k8s-base.sh
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }
warn() { echo "  ⚠️  $1"; ((WARN++)); }
check_header() { echo ""; echo "━━━ $1 ━━━"; }

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Agent Warden — Kubernetes Base Verification                ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── 1. kubectl connectivity ──────────────────────────────
check_header "Cluster Connectivity"
if kubectl cluster-info &>/dev/null; then
  SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
  pass "Connected to cluster: $SERVER"
else
  fail "Cannot connect to Kubernetes cluster"
  echo "Run 'az aks get-credentials ...' first."
  exit 1
fi

CLUSTER_VERSION=$(kubectl version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion // "unknown"')
pass "Cluster version: $CLUSTER_VERSION"

# ── 2. Nodes ─────────────────────────────────────────────
check_header "Nodes"
TOTAL_NODES=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')
READY_NODES=$(kubectl get nodes --no-headers 2>/dev/null | grep -c " Ready" || true)
if [[ "$READY_NODES" -gt 0 ]]; then
  pass "$READY_NODES / $TOTAL_NODES nodes Ready"
else
  fail "No nodes in Ready state"
fi

# Check system pool
SYSTEM_NODES=$(kubectl get nodes -l "kubernetes.azure.com/mode=system" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [[ "$SYSTEM_NODES" -gt 0 ]]; then
  pass "System node pool: $SYSTEM_NODES node(s)"
else
  warn "No system pool nodes found (label: kubernetes.azure.com/mode=system)"
fi

# Check tenant pool with taints
TENANT_NODES=$(kubectl get nodes -l "agentpool=tenant" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [[ "$TENANT_NODES" -gt 0 ]]; then
  pass "Tenant node pool: $TENANT_NODES node(s)"
  # Verify taint
  TAINTED=$(kubectl get nodes -l "agentpool=tenant" -o json | jq '[.items[].spec.taints[]? | select(.key=="workload" and .value=="tenant")] | length')
  if [[ "$TAINTED" -gt 0 ]]; then
    pass "Tenant nodes have workload=tenant taint"
  else
    warn "Tenant nodes missing workload=tenant taint"
  fi
else
  warn "No tenant pool nodes found (label: agentpool=tenant)"
fi

# ── 3. StorageClasses ────────────────────────────────────
check_header "StorageClasses"
for SC in managed-premium-zrs managed-premium-lrs managed-standard-zrs; do
  if kubectl get storageclass "$SC" &>/dev/null; then
    RECLAIM=$(kubectl get storageclass "$SC" -o jsonpath='{.reclaimPolicy}')
    BINDING=$(kubectl get storageclass "$SC" -o jsonpath='{.volumeBindingMode}')
    EXPAND=$(kubectl get storageclass "$SC" -o jsonpath='{.allowVolumeExpansion}')
    pass "$SC (reclaim=$RECLAIM, binding=$BINDING, expand=$EXPAND)"
    if [[ "$RECLAIM" != "Retain" ]]; then
      fail "  $SC reclaimPolicy should be Retain, got $RECLAIM"
    fi
    if [[ "$BINDING" != "WaitForFirstConsumer" ]]; then
      warn "  $SC volumeBindingMode should be WaitForFirstConsumer, got $BINDING"
    fi
  else
    fail "StorageClass $SC not found"
  fi
done

# ── 4. CRD ───────────────────────────────────────────────
check_header "Custom Resource Definition"
if kubectl get crd openclawtenants.openclaw.io &>/dev/null; then
  CRD_VERSIONS=$(kubectl get crd openclawtenants.openclaw.io -o jsonpath='{.spec.versions[*].name}')
  pass "CRD openclawtenants.openclaw.io installed (versions: $CRD_VERSIONS)"

  # Verify schema has key fields
  HAS_SPEC=$(kubectl get crd openclawtenants.openclaw.io -o json | jq '.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties | keys' 2>/dev/null || echo "[]")
  if echo "$HAS_SPEC" | grep -q "tenantId"; then
    pass "CRD schema includes tenantId field"
  else
    warn "CRD schema missing tenantId field"
  fi
else
  fail "CRD openclawtenants.openclaw.io not found"
fi

# ── 5. Operator RBAC ─────────────────────────────────────
check_header "Operator RBAC"
if kubectl get serviceaccount agent-warden-operator -n agent-warden-system &>/dev/null; then
  pass "ServiceAccount agent-warden-operator exists"
else
  fail "ServiceAccount agent-warden-operator not found in agent-warden-system"
fi

if kubectl get clusterrole agent-agent-warden-operator &>/dev/null; then
  RULES=$(kubectl get clusterrole agent-agent-warden-operator -o json | jq '.rules | length')
  pass "ClusterRole agent-agent-warden-operator exists ($RULES rule groups)"
else
  fail "ClusterRole agent-agent-warden-operator not found"
fi

if kubectl get clusterrolebinding agent-agent-warden-operator &>/dev/null; then
  pass "ClusterRoleBinding agent-agent-warden-operator exists"
else
  fail "ClusterRoleBinding agent-agent-warden-operator not found"
fi

# ── 6. System Namespace ──────────────────────────────────
check_header "System Namespace"
if kubectl get namespace agent-warden-system &>/dev/null; then
  LABELS=$(kubectl get namespace agent-warden-system -o jsonpath='{.metadata.labels}')
  pass "Namespace agent-warden-system exists"
  if echo "$LABELS" | grep -q "agent-warden"; then
    pass "Namespace has agent-warden label"
  else
    warn "Namespace missing agent-warden label"
  fi
else
  fail "Namespace agent-warden-system not found"
fi

# ── 7. Secrets Store CSI Driver ──────────────────────────
check_header "Secrets Store CSI Driver"
CSI_PODS=$(kubectl get pods -n kube-system -l app=secrets-store-csi-driver --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CSI_PODS" -gt 0 ]]; then
  RUNNING=$(kubectl get pods -n kube-system -l app=secrets-store-csi-driver --no-headers 2>/dev/null | grep -c "Running" || true)
  pass "CSI Driver pods: $RUNNING/$CSI_PODS running"
else
  # Also check for azure-specific label
  CSI_PODS=$(kubectl get pods -n kube-system -l "app.kubernetes.io/name=secrets-store-csi-driver" --no-headers 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$CSI_PODS" -gt 0 ]]; then
    pass "CSI Driver pods found: $CSI_PODS"
  else
    fail "No Secrets Store CSI Driver pods found"
  fi
fi

# Azure Key Vault provider pods
AKV_PODS=$(kubectl get pods -n kube-system -l "app=secrets-store-provider-azure" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [[ "$AKV_PODS" -gt 0 ]]; then
  pass "Azure Key Vault CSI provider pods: $AKV_PODS"
else
  AKV_PODS=$(kubectl get pods -n kube-system --no-headers 2>/dev/null | grep -c "csi-secrets-store-provider-azure" || true)
  if [[ "$AKV_PODS" -gt 0 ]]; then
    pass "Azure Key Vault CSI provider pods found: $AKV_PODS"
  else
    warn "No Azure Key Vault CSI provider pods found"
  fi
fi

# ── 8. Network Policy Controller ─────────────────────────
check_header "Network Policy (Calico)"
CALICO_PODS=$(kubectl get pods -n kube-system --no-headers 2>/dev/null | grep -ci "calico" || true)
if [[ "$CALICO_PODS" -gt 0 ]]; then
  pass "Calico pods running: $CALICO_PODS"
else
  TIGERA=$(kubectl get pods -n calico-system --no-headers 2>/dev/null | wc -l | tr -d ' ' 2>/dev/null || echo "0")
  if [[ "$TIGERA" -gt 0 ]]; then
    pass "Calico (Tigera) pods found in calico-system: $TIGERA"
  else
    warn "No Calico pods detected — NetworkPolicy enforcement may not work"
  fi
fi

# ── 9. Health-Check CronJob ──────────────────────────────
check_header "Health-Check CronJob"
CRONJOB_NAME=$(kubectl get cronjob -n agent-warden-system --no-headers 2>/dev/null | awk '{print $1}' | head -1 || true)
if [[ -n "$CRONJOB_NAME" ]]; then
  SCHEDULE=$(kubectl get cronjob "$CRONJOB_NAME" -n agent-warden-system -o jsonpath='{.spec.schedule}')
  pass "CronJob $CRONJOB_NAME exists (schedule: $SCHEDULE)"
else
  warn "No CronJob found in agent-warden-system"
fi

# ── 10. DNS Resolution ───────────────────────────────────
check_header "Cluster DNS"
DNS_POD=$(kubectl get pods -n kube-system -l k8s-app=kube-dns --no-headers 2>/dev/null | head -1 | awk '{print $1}')
if [[ -n "$DNS_POD" ]]; then
  pass "CoreDNS pod found: $DNS_POD"
  DNS_RUNNING=$(kubectl get pods -n kube-system -l k8s-app=kube-dns --no-headers 2>/dev/null | grep -c "Running" || true)
  pass "CoreDNS pods running: $DNS_RUNNING"
else
  fail "No CoreDNS pods found"
fi

# ── 11. Gateway API CRDs ─────────────────────────────────
check_header "Gateway API"
for GW_CRD in gatewayclasses.gateway.networking.k8s.io gateways.gateway.networking.k8s.io httproutes.gateway.networking.k8s.io; do
  if kubectl get crd "$GW_CRD" &>/dev/null; then
    pass "CRD $GW_CRD installed"
  else
    fail "CRD $GW_CRD not found — install Gateway API CRDs"
  fi
done

# Check for GatewayClass
if kubectl get gatewayclass azure-alb-external &>/dev/null; then
  pass "GatewayClass azure-alb-external exists"
else
  warn "GatewayClass azure-alb-external not found"
fi

# Check for Gateway in system namespace
if kubectl get gateway agent-warden-gateway -n agent-warden-system &>/dev/null; then
  pass "Gateway agent-warden-gateway exists"
else
  warn "Gateway agent-warden-gateway not found in agent-warden-system"
fi

# ── 12. RuntimeClass ─────────────────────────────────────
check_header "RuntimeClass"
if kubectl get runtimeclass kata-mshv-vm-isolation &>/dev/null; then
  HANDLER=$(kubectl get runtimeclass kata-mshv-vm-isolation -o jsonpath='{.handler}')
  pass "RuntimeClass kata-mshv-vm-isolation exists (handler: $HANDLER)"
else
  warn "RuntimeClass kata-mshv-vm-isolation not found (sandbox isolation may not work)"
fi

# ── 13. Operator Deployment ──────────────────────────────
check_header "Operator Deployment"
if kubectl get deployment agent-warden-operator -n agent-warden-system &>/dev/null; then
  READY=$(kubectl get deployment agent-warden-operator -n agent-warden-system -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  DESIRED=$(kubectl get deployment agent-warden-operator -n agent-warden-system -o jsonpath='{.spec.replicas}')
  if [[ "$READY" == "$DESIRED" && "$READY" -gt 0 ]]; then
    pass "Operator deployment: $READY/$DESIRED replicas ready"
  else
    fail "Operator deployment: $READY/$DESIRED replicas ready"
  fi
else
  fail "Operator deployment not found in agent-warden-system"
fi

# ── Summary ───────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Kubernetes Base Verification Summary                       ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  ✅ Passed:   %-44s║\n" "$PASS"
printf "║  ⚠️  Warnings: %-44s║\n" "$WARN"
printf "║  ❌ Failed:   %-44s║\n" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════╝"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
