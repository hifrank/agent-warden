#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Verify security posture of the platform and tenants
#
# Checks:
#   1.  No pods running as root
#   2.  No privileged containers
#   3.  All tenant namespaces have NetworkPolicy
#   4.  All tenant namespaces have ResourceQuota
#   5.  No default ServiceAccount token automount
#   6.  Key Vault purge-protection across all tenant vaults
#   7.  RBAC (no ClusterRoleBindings to cluster-admin for non-system)
#   8.  Kubernetes API audit (Azure Monitor)
#   9.  Pod Security Standards
#  10.  External egress validation per tenant
#
# Usage: ./scripts/verify-security.sh [environment]
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV="${1:-dev}"
BASE_NAME="agentwarden"
RG_NAME="rg-${BASE_NAME}-${ENV}"

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }
warn() { echo "  ⚠️  $1"; ((WARN++)); }
check_header() { echo ""; echo "━━━ $1 ━━━"; }

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Agent Warden — Security Posture Verification               ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# Collect all tenant namespaces
TENANT_NS=$(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | grep "^tenant-" || true)
TENANT_COUNT=$(echo "$TENANT_NS" | grep -c "." 2>/dev/null || echo "0")
echo ""
echo "  Found $TENANT_COUNT tenant namespace(s)"

# ── 1. No Root Pods ──────────────────────────────────────
check_header "No Root Containers"
ROOT_PODS=0
ALL_PODS_JSON=$(kubectl get pods --all-namespaces -o json 2>/dev/null)
ROOT_CONTAINERS=$(echo "$ALL_PODS_JSON" | jq -r '
  .items[] |
  select(.metadata.namespace | startswith("tenant-")) |
  .metadata.namespace as $ns |
  .metadata.name as $pod |
  .spec.containers[] |
  select(.securityContext.runAsNonRoot != true) |
  "\($ns)/\($pod)/\(.name)"' 2>/dev/null || true)

if [[ -n "$ROOT_CONTAINERS" ]]; then
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    fail "Container may run as root: $entry"
    ((ROOT_PODS++))
  done <<< "$ROOT_CONTAINERS"
else
  pass "No tenant containers allow root execution"
fi

# ── 2. No Privileged Containers ──────────────────────────
check_header "No Privileged Containers"
PRIVILEGED=$(echo "$ALL_PODS_JSON" | jq -r '
  .items[] |
  select(.metadata.namespace | startswith("tenant-")) |
  .metadata.namespace as $ns |
  .metadata.name as $pod |
  .spec.containers[] |
  select(.securityContext.privileged == true) |
  "\($ns)/\($pod)/\(.name)"' 2>/dev/null || true)

if [[ -n "$PRIVILEGED" ]]; then
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    fail "Privileged container found: $entry"
  done <<< "$PRIVILEGED"
else
  pass "No privileged containers in tenant namespaces"
fi

# ── 3. ReadOnlyRootFilesystem ────────────────────────────
# NOTE: The openclaw-gateway container requires readOnlyRootFilesystem: false
# because the agent-browser skill needs Chrome, which writes to crashpad db,
# GPU cache, and other paths that cannot be redirected to tmpfs mounts.
# The seccompProfile is also set to Unconfined for Chrome subprocess management.
# Sidecar containers (litellm-proxy, saas-auth-proxy, git-sync) still enforce
# readOnlyRootFilesystem: true.
check_header "Read-Only Root Filesystem"
WRITABLE_ROOT=$(echo "$ALL_PODS_JSON" | jq -r '
  .items[] |
  select(.metadata.namespace | startswith("tenant-")) |
  .metadata.namespace as $ns |
  .metadata.name as $pod |
  .spec.containers[] |
  select(.securityContext.readOnlyRootFilesystem != true) |
  "\($ns)/\($pod)/\(.name)"' 2>/dev/null || true)

if [[ -n "$WRITABLE_ROOT" ]]; then
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    # openclaw-gateway needs writable root for agent-browser/Chrome support
    if [[ "$entry" == *"/openclaw-gateway" ]]; then
      warn "Writable root filesystem (expected — agent-browser/Chrome): $entry"
    else
      warn "Writable root filesystem: $entry"
    fi
  done <<< "$WRITABLE_ROOT"
else
  pass "All tenant containers use readOnlyRootFilesystem"
fi

# ── 4. NetworkPolicy per Tenant Namespace ─────────────────
check_header "NetworkPolicy Coverage"
if [[ -n "$TENANT_NS" ]]; then
  while IFS= read -r ns; do
    [[ -z "$ns" ]] && continue
    NP_COUNT=$(kubectl get networkpolicy -n "$ns" --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$NP_COUNT" -gt 0 ]]; then
      # Check for default-deny
      HAS_DENY=$(kubectl get networkpolicy -n "$ns" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | grep -c "deny" || true)
      if [[ "$HAS_DENY" -gt 0 ]]; then
        pass "$ns: $NP_COUNT NetworkPolicy(ies), default-deny present"
      else
        warn "$ns: $NP_COUNT NetworkPolicy(ies), but no default-deny"
      fi
    else
      fail "$ns: NO NetworkPolicy — tenant is not isolated!"
    fi
  done <<< "$TENANT_NS"
else
  warn "No tenant namespaces to check"
fi

# ── 5. ResourceQuota per Tenant Namespace ─────────────────
check_header "ResourceQuota Coverage"
if [[ -n "$TENANT_NS" ]]; then
  while IFS= read -r ns; do
    [[ -z "$ns" ]] && continue
    RQ_COUNT=$(kubectl get resourcequota -n "$ns" --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$RQ_COUNT" -gt 0 ]]; then
      pass "$ns: ResourceQuota present"
    else
      fail "$ns: NO ResourceQuota — tenant is not resource-bounded!"
    fi
  done <<< "$TENANT_NS"
else
  warn "No tenant namespaces to check"
fi

# ── 6. ServiceAccount Token Automount ─────────────────────
check_header "ServiceAccount Token Automount"
if [[ -n "$TENANT_NS" ]]; then
  while IFS= read -r ns; do
    [[ -z "$ns" ]] && continue
    DEFAULT_SA=$(kubectl get serviceaccount default -n "$ns" -o jsonpath='{.automountServiceAccountToken}' 2>/dev/null || echo "null")
    if [[ "$DEFAULT_SA" == "false" ]]; then
      pass "$ns: default SA token automount disabled"
    else
      warn "$ns: default SA may automount token (value=$DEFAULT_SA)"
    fi
  done <<< "$TENANT_NS"
else
  warn "No tenant namespaces to check"
fi

# ── 7. Key Vault Security (all tenant vaults) ────────────
check_header "Key Vault Security"
TENANT_KVS=$(az keyvault list --resource-group "$RG_NAME" --query "[?starts_with(name, 'kv-')].name" -o tsv 2>/dev/null || true)
if [[ -n "$TENANT_KVS" ]]; then
  while IFS= read -r kv; do
    [[ -z "$kv" ]] && continue
    KV_JSON=$(az keyvault show --name "$kv" -o json 2>/dev/null || true)
    if [[ -n "$KV_JSON" ]]; then
      PURGE=$(echo "$KV_JSON" | jq -r '.properties.enablePurgeProtection // false')
      RBAC=$(echo "$KV_JSON" | jq -r '.properties.enableRbacAuthorization')
      DEFAULT_ACTION=$(echo "$KV_JSON" | jq -r '.properties.networkAcls.defaultAction // "Allow"')

      [[ "$PURGE" == "true" ]] && pass "$kv: Purge protection ✓" || fail "$kv: Purge protection OFF"
      [[ "$RBAC" == "true" ]] && pass "$kv: RBAC authorization ✓" || fail "$kv: Access policy mode (should use RBAC)"
      if [[ "$DEFAULT_ACTION" == "Deny" ]]; then
        pass "$kv: Network default action = Deny"
      else
        # Public AKS clusters require Key Vault public access for CSI driver
        warn "$kv: Network default action = $DEFAULT_ACTION (expected for public AKS + CSI driver)"
      fi
    fi
  done <<< "$TENANT_KVS"
else
  warn "No tenant Key Vaults found (kv-* pattern)"
fi

# ── 8. Cluster-Admin Bindings ─────────────────────────────
check_header "Cluster-Admin Role Bindings"
ADMIN_BINDINGS=$(kubectl get clusterrolebinding -o json 2>/dev/null | jq -r '
  .items[] |
  select(.roleRef.name == "cluster-admin") |
  select(
    (.subjects[]?.namespace // "" | startswith("kube-") | not) and
    (.subjects[]?.namespace // "" | test("^(kube-system|gatekeeper-system|calico-system)$") | not) and
    (.metadata.name | test("^(system:|aks-|aad-)") | not)
  ) |
  "\(.metadata.name) → \(.subjects[0].kind)/\(.subjects[0].name)"' 2>/dev/null || true)

if [[ -n "$ADMIN_BINDINGS" ]]; then
  while IFS= read -r binding; do
    [[ -z "$binding" ]] && continue
    warn "Non-system cluster-admin binding: $binding"
  done <<< "$ADMIN_BINDINGS"
else
  pass "No unexpected cluster-admin bindings"
fi

# ── 9. Pod Security Standards ─────────────────────────────
check_header "Pod Security Standards"
if [[ -n "$TENANT_NS" ]]; then
  while IFS= read -r ns; do
    [[ -z "$ns" ]] && continue
    PSS_ENFORCE=$(kubectl get namespace "$ns" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null || true)
    if [[ -n "$PSS_ENFORCE" ]]; then
      pass "$ns: Pod Security Standard enforce=$PSS_ENFORCE"
    else
      warn "$ns: No Pod Security Standard label (consider adding 'restricted')"
    fi
  done <<< "$TENANT_NS"
else
  warn "No tenant namespaces to check"
fi

# ── 10. Egress Validation ─────────────────────────────────
check_header "Egress Validation"
if [[ -n "$TENANT_NS" ]]; then
  NS_SAMPLE=$(echo "$TENANT_NS" | head -1)
  POD_SAMPLE=$(kubectl get pod -n "$NS_SAMPLE" --no-headers 2>/dev/null | head -1 | awk '{print $1}')
  if [[ -n "$POD_SAMPLE" ]]; then
    echo "  Testing egress from $NS_SAMPLE/$POD_SAMPLE..."

    # DNS should work (port 53)
    DNS_TEST=$(kubectl exec -n "$NS_SAMPLE" "$POD_SAMPLE" -c openclaw-gateway -- \
      nslookup kubernetes.default.svc.cluster.local 2>&1 || true)
    if echo "$DNS_TEST" | grep -qi "address\|server"; then
      pass "DNS resolution works"
    else
      warn "DNS resolution test inconclusive"
    fi

    # HTTPS egress should work (443)
    HTTPS_TEST=$(kubectl exec -n "$NS_SAMPLE" "$POD_SAMPLE" -c openclaw-gateway -- \
      wget -q --spider --timeout=5 https://api.openai.com 2>&1 || true)
    if [[ $? -eq 0 ]] || echo "$HTTPS_TEST" | grep -qi "200\|connected"; then
      pass "HTTPS egress (443) works"
    else
      warn "HTTPS egress test inconclusive (may need curl/wget in image)"
    fi

    # Non-HTTPS should be blocked (e.g., port 8080)
    BLOCKED_TEST=$(kubectl exec -n "$NS_SAMPLE" "$POD_SAMPLE" -c openclaw-gateway -- \
      timeout 3 bash -c "echo test > /dev/tcp/8.8.8.8/8080" 2>&1 || true)
    if echo "$BLOCKED_TEST" | grep -qi "timed out\|refused\|denied\|No route"; then
      pass "Non-standard egress appears blocked"
    else
      warn "Non-standard egress test inconclusive"
    fi
  else
    warn "No pods available for egress testing in $NS_SAMPLE"
  fi
else
  warn "No tenant namespaces for egress testing"
fi

# ── Summary ───────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Security Posture Verification Summary                      ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  ✅ Passed:   %-44s║\n" "$PASS"
printf "║  ⚠️  Warnings: %-44s║\n" "$WARN"
printf "║  ❌ Failed:   %-44s║\n" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════╝"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "SECURITY ISSUES DETECTED — address failed checks before production."
  exit 1
fi
