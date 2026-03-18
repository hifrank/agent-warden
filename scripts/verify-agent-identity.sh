#!/usr/bin/env bash
# verify-agent-identity.sh — Validate per-agent Entra ID + SaaS Auth Proxy stack (§18.7)
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0; WARN=0

pass()  { ((PASS++)); echo -e "  ${GREEN}✓${NC} $1"; }
fail()  { ((FAIL++)); echo -e "  ${RED}✗${NC} $1"; }
warn()  { ((WARN++)); echo -e "  ${YELLOW}⚠${NC} $1"; }

echo "═══════════════════════════════════════════════════════"
echo "  Agent Identity & SaaS Auth Proxy Verification"
echo "═══════════════════════════════════════════════════════"

# ─── 1. SaaS Auth Proxy source ───────────────────────────
echo -e "\n▸ SaaS Auth Proxy Implementation"
if [[ -f agent-warden-saas-proxy/src/proxy.ts ]]; then
  pass "proxy.ts exists"
  grep -q "exchangeRefreshToken" agent-warden-saas-proxy/src/proxy.ts && pass "Token exchange implemented" || fail "Missing token exchange"
  grep -q "isPathAllowed" agent-warden-saas-proxy/src/proxy.ts && pass "Path policy enforcement" || fail "Missing path policy"
  grep -q "auditLog" agent-warden-saas-proxy/src/proxy.ts && pass "Audit logging implemented" || fail "Missing audit logging"
  grep -q "PROVIDERS" agent-warden-saas-proxy/src/proxy.ts && pass "Provider registry configured" || fail "Missing provider registry"
  grep -q "127.0.0.1" agent-warden-saas-proxy/src/proxy.ts && pass "Bound to localhost only" || fail "Not bound to localhost"
else
  fail "agent-warden-saas-proxy/src/proxy.ts not found"
fi

if [[ -f agent-warden-saas-proxy/Dockerfile ]]; then
  pass "Dockerfile exists"
  grep -q "USER 65534" agent-warden-saas-proxy/Dockerfile && pass "Runs as nobody (65534)" || fail "Not running as nobody"
else
  fail "Dockerfile not found"
fi

# ─── 2. MCP Server agent identity tools ──────────────────
echo -e "\n▸ MCP Server Agent Identity Tools"
if [[ -f agent-warden-server/src/tools/agent-identity.ts ]]; then
  pass "agent-identity.ts exists"
  grep -q "provisionAgentIdentity" agent-warden-server/src/tools/agent-identity.ts && pass "provisionAgentIdentity function" || fail "Missing provision"
  grep -q "connectSaaSProvider" agent-warden-server/src/tools/agent-identity.ts && pass "connectSaaSProvider function" || fail "Missing connect"
  grep -q "listSaaSConnections" agent-warden-server/src/tools/agent-identity.ts && pass "listSaaSConnections function" || fail "Missing list"
  grep -q "revokeSaaSConnection" agent-warden-server/src/tools/agent-identity.ts && pass "revokeSaaSConnection function" || fail "Missing revoke"
  grep -q "federatedIdentityCredentials" agent-warden-server/src/tools/agent-identity.ts && pass "AKS Workload Identity federation" || fail "Missing WIF"
else
  fail "agent-identity.ts not found"
fi

# Verify tools registered in index
if [[ -f agent-warden-server/src/index.ts ]]; then
  grep -q "warden.identity.provision" agent-warden-server/src/index.ts && pass "warden.identity.provision registered" || fail "Tool not registered"
  grep -q "warden.identity.connect" agent-warden-server/src/index.ts && pass "warden.identity.connect registered" || fail "Tool not registered"
  grep -q "warden.identity.connections" agent-warden-server/src/index.ts && pass "warden.identity.connections registered" || fail "Tool not registered"
  grep -q "warden.identity.revoke" agent-warden-server/src/index.ts && pass "warden.identity.revoke registered" || fail "Tool not registered"
else
  fail "index.ts not found"
fi

# ─── 3. Helm chart integration ───────────────────────────
echo -e "\n▸ Helm Chart SaaS Auth Proxy"
HELM_DIR="k8s/helm/openclaw-tenant"

if [[ -f "$HELM_DIR/values.yaml" ]]; then
  grep -q "saasProxy:" "$HELM_DIR/values.yaml" && pass "saasProxy config in values.yaml" || fail "Missing saasProxy config"
  grep -q "port: 9090" "$HELM_DIR/values.yaml" && pass "Proxy port 9090 configured" || fail "Wrong proxy port"
  grep -q "policies:" "$HELM_DIR/values.yaml" && pass "Path policies configured" || fail "Missing path policies"
fi

if [[ -f "$HELM_DIR/templates/statefulset.yaml" ]]; then
  grep -q "saas-auth-proxy" "$HELM_DIR/templates/statefulset.yaml" && pass "SaaS proxy sidecar in StatefulSet" || fail "Sidecar not added"
  grep -q "SAAS_PROXY_URL" "$HELM_DIR/templates/statefulset.yaml" && pass "SAAS_PROXY_URL env var set" || fail "Missing SAAS_PROXY_URL"
  grep -q "saas-policy" "$HELM_DIR/templates/statefulset.yaml" && pass "Policy ConfigMap volume mounted" || fail "Missing policy volume"
else
  fail "StatefulSet template not found"
fi

if [[ -f "$HELM_DIR/templates/saas-proxy-policy.yaml" ]]; then
  pass "SaaS proxy policy ConfigMap template exists"
  grep -q "policy.json" "$HELM_DIR/templates/saas-proxy-policy.yaml" && pass "policy.json data key present" || fail "Missing policy.json"
else
  fail "SaaS proxy policy template not found"
fi

# ─── 4. Design doc ───────────────────────────────────────
echo -e "\n▸ Design Document"
DOC="docs/design/secure-multi-tenant-openclaw.md"
if [[ -f "$DOC" ]]; then
  grep -q "18.7" "$DOC" && pass "§18.7 section exists" || fail "Missing §18.7"
  grep -q "SaaS Auth Proxy" "$DOC" && pass "SaaS Auth Proxy documented" || fail "Proxy not documented"
  grep -q "delegated" "$DOC" && pass "Delegated permissions model documented" || fail "Missing delegated model"
  grep -q "App Registration" "$DOC" && pass "App Registration flow documented" || fail "Missing App Reg flow"
else
  fail "Design document not found"
fi

# ─── 5. CI/CD pipeline ──────────────────────────────────
echo -e "\n▸ CI/CD Pipeline"
CI_FILE=".github/workflows/build-images.yaml"
if [[ -f "$CI_FILE" ]]; then
  grep -q "agent-warden-saas-proxy" "$CI_FILE" && pass "SaaS proxy in CI pipeline" || fail "Not in CI"
  grep -q "build-saas-proxy" "$CI_FILE" && pass "build-saas-proxy job defined" || fail "Missing build job"
else
  fail "CI pipeline file not found"
fi

# ─── 6. Live check (if cluster available) ────────────────
echo -e "\n▸ Live Cluster Check"
if kubectl cluster-info &>/dev/null; then
  TENANT_NS="${1:-}"
  if [[ -n "$TENANT_NS" ]]; then
    echo "    Checking tenant namespace: $TENANT_NS"
    
    # Check SaaS proxy container
    PROXY_READY=$(kubectl get pod -n "$TENANT_NS" -l app.kubernetes.io/name=openclaw \
      -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="saas-auth-proxy")].ready}' 2>/dev/null || true)
    if [[ "$PROXY_READY" == "true" ]]; then
      pass "SaaS auth proxy container running"
    else
      warn "SaaS auth proxy container not ready (may be disabled)"
    fi

    # Check policy ConfigMap
    if kubectl get configmap -n "$TENANT_NS" -l app.kubernetes.io/name=openclaw --field-selector metadata.name=saas-proxy-policy-* &>/dev/null 2>&1; then
      pass "SaaS proxy policy ConfigMap found"
    else
      warn "No policy ConfigMap found"
    fi
  else
    warn "No tenant namespace specified (pass as argument to test live)"
  fi
else
  warn "No cluster connection — skipping live checks"
fi

# ─── Summary ─────────────────────────────────────────────
echo -e "\n═══════════════════════════════════════════════════════"
echo -e "  Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$WARN warnings${NC}"
echo "═══════════════════════════════════════════════════════"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
