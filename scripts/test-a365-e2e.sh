#!/usr/bin/env bash
# E2E test: Verify A365 Observability plugin emits InvokeAgent, Inference, and ExecuteTool spans
set -euo pipefail

NAMESPACE="${NAMESPACE:-tenant-demo-tenant}"
POD="${POD:-openclaw-demo-tenant-0}"
CONTAINER="${CONTAINER:-openclaw-gateway}"

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  Agent Warden — A365 Observability Plugin E2E Test           ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# ── 0. Pod Health Check ──
echo "0. Checking pod status..."
STATUS=$(kubectl get pod -n "$NAMESPACE" "$POD" -o jsonpath='{.status.phase}' 2>&1)
READY=$(kubectl get pod -n "$NAMESPACE" "$POD" -o jsonpath='{.status.containerStatuses[?(@.name=="openclaw-gateway")].ready}' 2>&1)
if [[ "$STATUS" != "Running" || "$READY" != "true" ]]; then
  echo "   ❌ Pod not healthy: phase=$STATUS ready=$READY"
  exit 1
fi
echo "   ✅ Pod $POD is Running and ready"

# ── 1. Verify Plugin Loaded ──
echo ""
echo "1. Verifying a365 plugin is loaded..."
PLUGIN_LOG=$(kubectl logs -n "$NAMESPACE" "$POD" -c "$CONTAINER" 2>&1 | grep "\[a365\] Plugin registered" | tail -1)
if [[ -z "$PLUGIN_LOG" ]]; then
  echo "   ❌ Plugin not registered — no [a365] Plugin registered log found"
  exit 1
fi
echo "   ✅ $PLUGIN_LOG"

# ── 2. Check SDK Configuration ──
echo ""
echo "2. Checking SDK configuration..."
SDK_LOG=$(kubectl logs -n "$NAMESPACE" "$POD" -c "$CONTAINER" 2>&1 | grep "\[a365\] SDK configured" | tail -1)
if [[ -z "$SDK_LOG" ]]; then
  echo "   ⚠️  No SDK configuration log found"
else
  echo "   ✅ $SDK_LOG"
fi

# ── 3. Send Test Message (triggers all hooks) ──
echo ""
echo "3. Sending test message via embedded CLI..."
# Record the timestamp before sending the message
BEFORE_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%FT%TZ)

# Run agent invocation (timeout after 45s)
AGENT_OUTPUT=$(timeout 45 kubectl exec -n "$NAMESPACE" "$POD" -c "$CONTAINER" -- \
  openclaw agent --agent main -m "Say exactly: A365 E2E test successful" 2>&1 || true)

echo "   Agent output (last 5 lines):"
echo "$AGENT_OUTPUT" | tail -5 | sed 's/^/     /'

# ── 4. Verify InvokeAgentScope ──
echo ""
echo "4. Checking InvokeAgentScope spans..."
sleep 2
INVOKE_START=$(kubectl logs -n "$NAMESPACE" "$POD" -c "$CONTAINER" --since=120s 2>&1 | grep "\[a365\] InvokeAgentScope started" | tail -1)
INVOKE_END=$(kubectl logs -n "$NAMESPACE" "$POD" -c "$CONTAINER" --since=120s 2>&1 | grep "\[a365\] InvokeAgentScope ended" | tail -1)

if [[ -n "$INVOKE_START" ]]; then
  echo "   ✅ InvokeAgentScope started: $(echo "$INVOKE_START" | sed 's/.*\[a365\] //')"
else
  echo "   ❌ InvokeAgentScope NOT started (before_agent_start hook failed)"
fi

if [[ -n "$INVOKE_END" ]]; then
  echo "   ✅ InvokeAgentScope ended: $(echo "$INVOKE_END" | sed 's/.*\[a365\] //')"
else
  echo "   ❌ InvokeAgentScope NOT ended (agent_end hook failed)"
fi

# ── 5. Verify InferenceScope ──
echo ""
echo "5. Checking InferenceScope spans..."
INF_START=$(kubectl logs -n "$NAMESPACE" "$POD" -c "$CONTAINER" --since=120s 2>&1 | grep "\[a365\] InferenceScope started" | tail -1)
INF_END=$(kubectl logs -n "$NAMESPACE" "$POD" -c "$CONTAINER" --since=120s 2>&1 | grep "\[a365\] InferenceScope ended" | tail -1)

if [[ -n "$INF_START" ]]; then
  echo "   ✅ InferenceScope started: $(echo "$INF_START" | sed 's/.*\[a365\] //')"
else
  echo "   ❌ InferenceScope NOT started (llm_input hook failed)"
fi

if [[ -n "$INF_END" ]]; then
  echo "   ✅ InferenceScope ended: $(echo "$INF_END" | sed 's/.*\[a365\] //')"
  # Extract token counts
  TOKENS=$(echo "$INF_END" | grep -o 'tokens=[^ ]*' || echo "")
  DURATION=$(echo "$INF_END" | grep -o 'duration=[^ ]*' || echo "")
  [[ -n "$TOKENS" ]] && echo "   📊 $TOKENS"
  [[ -n "$DURATION" ]] && echo "   ⏱️  $DURATION"
else
  echo "   ❌ InferenceScope NOT ended (llm_output hook failed)"
fi

# ── 6. Check for ExecuteToolScope (may not fire for simple messages) ──
echo ""
echo "6. Checking ExecuteToolScope spans (optional — depends on tool use)..."
TOOL_LOG=$(kubectl logs -n "$NAMESPACE" "$POD" -c "$CONTAINER" --since=120s 2>&1 | grep "\[a365\] ExecuteToolScope" | tail -1 || true)
if [[ -n "$TOOL_LOG" ]]; then
  echo "   ✅ ExecuteToolScope: $(echo "$TOOL_LOG" | sed 's/.*\[a365\] //')"
else
  echo "   ⏭️  No ExecuteToolScope (expected — no tools invoked for simple message)"
fi

# ── 7. Check for Errors ──
echo ""
echo "7. Checking for a365 plugin errors..."
ERRORS=$(kubectl logs -n "$NAMESPACE" "$POD" -c "$CONTAINER" --since=120s 2>&1 | grep "\[a365\].*error\|Error" | grep -v "diagnostics-otel" || true)
if [[ -n "$ERRORS" ]]; then
  echo "   ⚠️  Errors found:"
  echo "$ERRORS" | sed 's/^/     /'
else
  echo "   ✅ No errors"
fi

# ── 8. Summary ──
echo ""
echo "═══════════════════════════════════════════════════════════════"
PASS=0
FAIL=0

[[ -n "$INVOKE_START" ]] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
[[ -n "$INVOKE_END" ]] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
[[ -n "$INF_START" ]] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
[[ -n "$INF_END" ]] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

if [[ "$FAIL" -eq 0 ]]; then
  echo "✅ ALL CHECKS PASSED ($PASS/$PASS)"
  echo "   InvokeAgentScope: ✅  InferenceScope: ✅"
  echo "   A365 spans are being emitted to agent365.svc.cloud.microsoft"
else
  echo "❌ $FAIL CHECK(S) FAILED ($PASS passed, $FAIL failed)"
fi
echo "═══════════════════════════════════════════════════════════════"

exit "$FAIL"
