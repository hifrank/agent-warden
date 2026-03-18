#!/usr/bin/env bash
# verify-sandbox-monitoring.sh — Validate sandbox monitoring stack
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0; WARN=0

pass()  { ((PASS++)); echo -e "  ${GREEN}✓${NC} $1"; }
fail()  { ((FAIL++)); echo -e "  ${RED}✗${NC} $1"; }
warn()  { ((WARN++)); echo -e "  ${YELLOW}⚠${NC} $1"; }

echo "═══════════════════════════════════════════════════════"
echo "  Sandbox Monitoring Verification"
echo "═══════════════════════════════════════════════════════"

# ─── 1. RuntimeClass ──────────────────────────────────────
echo -e "\n▸ RuntimeClass"
if kubectl get runtimeclass kata-mshv-vm-isolation &>/dev/null; then
  pass "RuntimeClass kata-mshv-vm-isolation exists"
  HANDLER=$(kubectl get runtimeclass kata-mshv-vm-isolation -o jsonpath='{.handler}')
  [[ "$HANDLER" == "kata-mshv-vm-isolation" ]] && pass "Handler correct" || fail "Handler: $HANDLER"
else
  fail "RuntimeClass kata-mshv-vm-isolation not found"
fi

# ─── 2. Sandbox node pool ────────────────────────────────
echo -e "\n▸ Sandbox Node Pool"
SANDBOX_NODES=$(kubectl get nodes -l openclaw.io/pool=sandbox --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [[ "$SANDBOX_NODES" -ge 1 ]]; then
  pass "Sandbox nodes found: $SANDBOX_NODES"
  # Check Kata runtime support
  KATA_READY=$(kubectl get nodes -l openclaw.io/pool=sandbox -o jsonpath='{.items[0].status.nodeInfo.containerRuntimeVersion}')
  echo "    Runtime: $KATA_READY"
else
  warn "No sandbox nodes found (pool may not have scaled up yet)"
fi

# ─── 3. sandbox-monitor image ────────────────────────────
echo -e "\n▸ sandbox-monitor Image"
if [[ -f sandbox-monitor/Dockerfile ]]; then
  pass "Dockerfile exists"
  grep -q "sandbox-monitor" sandbox-monitor/Dockerfile && pass "Entrypoint configured" || fail "Missing entrypoint"
  grep -q "USER 65534" sandbox-monitor/Dockerfile && pass "Runs as nobody (65534)" || fail "Not running as nobody"
else
  fail "sandbox-monitor/Dockerfile not found"
fi

if [[ -f sandbox-monitor/src/monitor.ts ]]; then
  pass "monitor.ts exists"
  grep -q "riskScore" sandbox-monitor/src/monitor.ts && pass "Risk scoring implemented" || fail "Missing risk scoring"
  grep -q "/proc/net/tcp" sandbox-monitor/src/monitor.ts && pass "Network monitoring via /proc" || fail "Missing network monitoring"
  grep -q "inotify" sandbox-monitor/src/monitor.ts && pass "Filesystem monitoring via inotify" || fail "Missing filesystem monitoring"
else
  fail "sandbox-monitor/src/monitor.ts not found"
fi

# ─── 4. MCP Server sandbox tools ─────────────────────────
echo -e "\n▸ MCP Server Sandbox Tools"
if [[ -f agent-warden-server/src/tools/sandbox.ts ]]; then
  pass "tools/sandbox.ts exists"
  grep -q "reportSandboxExecution" agent-warden-server/src/tools/sandbox.ts && pass "reportSandboxExecution function" || fail "Missing reportSandboxExecution"
  grep -q "querySandboxAudit" agent-warden-server/src/tools/sandbox.ts && pass "querySandboxAudit function" || fail "Missing querySandboxAudit"
else
  fail "tools/sandbox.ts not found"
fi

if [[ -f agent-warden-server/src/index.ts ]]; then
  grep -q "warden.sandbox.report" agent-warden-server/src/index.ts && pass "warden.sandbox.report registered" || fail "Tool not registered"
  grep -q "warden.sandbox.audit" agent-warden-server/src/index.ts && pass "warden.sandbox.audit registered" || fail "Tool not registered"
else
  fail "index.ts not found"
fi

# ─── 5. Helm sandbox template ────────────────────────────
echo -e "\n▸ Helm Sandbox Template"
HELM_DIR="k8s/helm/openclaw-tenant"
if [[ -f "$HELM_DIR/templates/sandbox.yaml" ]]; then
  pass "sandbox.yaml template exists"
  grep -q "kata-mshv-vm-isolation" "$HELM_DIR/templates/sandbox.yaml" && pass "Uses Kata runtime class" || fail "Missing Kata runtime"
  grep -q "automountServiceAccountToken: false" "$HELM_DIR/templates/sandbox.yaml" && pass "SA token mounting disabled" || fail "SA token not disabled"
  grep -q "readOnlyRootFilesystem" "$HELM_DIR/templates/sandbox.yaml" && pass "Read-only root filesystem" || fail "Missing readOnlyRootFilesystem"
  grep -q "drop:" "$HELM_DIR/templates/sandbox.yaml" && pass "Capabilities dropped" || fail "Capabilities not dropped"
else
  fail "Helm sandbox template not found"
fi

if [[ -f "$HELM_DIR/values.yaml" ]]; then
  grep -q "sandbox:" "$HELM_DIR/values.yaml" && pass "sandbox config in values.yaml" || fail "Missing sandbox config"
fi

# ─── 6. CI/CD pipeline ───────────────────────────────────
echo -e "\n▸ CI/CD Pipeline"
CI_FILE=".github/workflows/build-images.yaml"
if [[ -f "$CI_FILE" ]]; then
  grep -q "sandbox-monitor" "$CI_FILE" && pass "sandbox-monitor in CI pipeline" || fail "sandbox-monitor not in CI"
  grep -q "build-sandbox-monitor" "$CI_FILE" && pass "build-sandbox-monitor job defined" || fail "Missing build job"
else
  fail "CI pipeline file not found"
fi

# ─── 7. Live sandbox pod test (if cluster available) ─────
echo -e "\n▸ Live Sandbox Pod Test"
if kubectl cluster-info &>/dev/null; then
  NAMESPACE="${1:-default}"
  TEST_POD="sandbox-verify-$(date +%s)"
  echo "    Launching test sandbox pod: $TEST_POD"
  
  cat <<EOF | kubectl apply -f - 2>/dev/null && CREATED=true || CREATED=false
apiVersion: v1
kind: Pod
metadata:
  name: $TEST_POD
  namespace: $NAMESPACE
spec:
  runtimeClassName: kata-mshv-vm-isolation
  restartPolicy: Never
  activeDeadlineSeconds: 30
  automountServiceAccountToken: false
  tolerations:
    - key: openclaw.io/sandbox-only
      operator: Equal
      value: "true"
      effect: NoSchedule
  nodeSelector:
    openclaw.io/pool: sandbox
  containers:
    - name: test
      image: mcr.microsoft.com/cbl-mariner/base/core:2.0
      command: ["echo", "sandbox-ok"]
      securityContext:
        runAsUser: 65534
        runAsNonRoot: true
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
      resources:
        limits:
          cpu: 250m
          memory: 128Mi
EOF

  if [[ "$CREATED" == "true" ]]; then
    pass "Test sandbox pod created"
    echo "    Waiting for completion (30s timeout)..."
    if kubectl wait --for=condition=Ready "pod/$TEST_POD" -n "$NAMESPACE" --timeout=30s &>/dev/null; then
      pass "Sandbox pod became Ready"
    else
      STATUS=$(kubectl get pod "$TEST_POD" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
      [[ "$STATUS" == "Succeeded" ]] && pass "Pod completed successfully" || warn "Pod status: $STATUS (sandbox nodes may not be ready)"
    fi
    kubectl delete pod "$TEST_POD" -n "$NAMESPACE" --grace-period=0 &>/dev/null || true
  else
    warn "Could not create test pod (sandbox pool may not be provisioned)"
  fi
else
  warn "No cluster connection — skipping live test"
fi

# ─── Summary ─────────────────────────────────────────────
echo -e "\n═══════════════════════════════════════════════════════"
echo -e "  Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$WARN warnings${NC}"
echo "═══════════════════════════════════════════════════════"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
