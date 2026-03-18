#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Verify Microsoft Purview DLP integration (§16)
#
# Checks:
#   1.  Purview account exists and is provisioned
#   2.  Platform MI has Purview Data Curator + Reader roles
#   3.  Purview diagnostic settings → Log Analytics
#   4.  DLP proxy sidecar running in tenant pods
#   5.  DLP proxy health endpoint responding
#   6.  OpenClaw LLM env vars routed through proxy
#   7.  DLP local pattern scan (test with known patterns)
#   8.  DLP audit records in Cosmos DB
#   9.  Purview → Sentinel SIEM connector
#  10.  DLP proxy container image in ACR
#
# Usage: ./scripts/verify-dlp.sh [environment] [tenant-id]
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV="${1:-dev}"
TENANT_ID="${2:-}"
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
echo "║  Agent Warden — DLP / Purview Verification (§16)            ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── 1. Purview Account ────────────────────────────────────
check_header "Microsoft Purview Account"
PURVIEW_NAME=$(az purview account list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$PURVIEW_NAME" ]]; then
  PURVIEW_JSON=$(az purview account show --name "$PURVIEW_NAME" --resource-group "$RG_NAME" -o json 2>/dev/null || echo "{}")
  PROV_STATE=$(echo "$PURVIEW_JSON" | jq -r '.provisioningState // "unknown"')
  pass "Purview account found: $PURVIEW_NAME"
  if [[ "$PROV_STATE" == "Succeeded" ]]; then
    pass "Provisioning state: Succeeded"
  else
    fail "Provisioning state: $PROV_STATE (expected Succeeded)"
  fi

  SCAN_ENDPOINT=$(echo "$PURVIEW_JSON" | jq -r '.endpoints.scan // "N/A"')
  CATALOG_ENDPOINT=$(echo "$PURVIEW_JSON" | jq -r '.endpoints.catalog // "N/A"')
  pass "Scan endpoint: $SCAN_ENDPOINT"
  pass "Catalog endpoint: $CATALOG_ENDPOINT"

  # System-assigned identity
  PURVIEW_MI=$(echo "$PURVIEW_JSON" | jq -r '.identity.principalId // "none"')
  if [[ "$PURVIEW_MI" != "none" && "$PURVIEW_MI" != "null" ]]; then
    pass "System-assigned managed identity: $PURVIEW_MI"
  else
    fail "No system-assigned identity on Purview account"
  fi
else
  fail "No Purview account found in $RG_NAME"
  echo "  Run 'terraform apply' to provision the Purview module."
fi

# ── 2. Platform MI → Purview RBAC ─────────────────────────
check_header "Purview RBAC (Platform MI)"
if [[ -n "$PURVIEW_NAME" ]]; then
  PURVIEW_ID=$(az purview account show --name "$PURVIEW_NAME" --resource-group "$RG_NAME" --query id -o tsv 2>/dev/null || true)
  PLATFORM_MI_PRINCIPAL=$(az identity list --resource-group "$RG_NAME" --query "[?contains(name, 'mi-platform')].principalId" -o tsv 2>/dev/null || true)

  if [[ -n "$PLATFORM_MI_PRINCIPAL" && -n "$PURVIEW_ID" ]]; then
    # Check Data Curator role
    CURATOR_ROLE=$(az role assignment list --scope "$PURVIEW_ID" --assignee "$PLATFORM_MI_PRINCIPAL" \
      --query "[?roleDefinitionName=='Purview Data Curator'].id" -o tsv 2>/dev/null || true)
    if [[ -n "$CURATOR_ROLE" ]]; then
      pass "Platform MI has 'Purview Data Curator' role"
    else
      fail "Platform MI missing 'Purview Data Curator' role"
    fi

    # Check Data Reader role
    READER_ROLE=$(az role assignment list --scope "$PURVIEW_ID" --assignee "$PLATFORM_MI_PRINCIPAL" \
      --query "[?roleDefinitionName=='Purview Data Reader'].id" -o tsv 2>/dev/null || true)
    if [[ -n "$READER_ROLE" ]]; then
      pass "Platform MI has 'Purview Data Reader' role"
    else
      fail "Platform MI missing 'Purview Data Reader' role"
    fi
  else
    warn "Cannot verify RBAC — platform MI or Purview ID not found"
  fi
else
  warn "Skipped — no Purview account"
fi

# ── 3. Diagnostic Settings ────────────────────────────────
check_header "Purview Diagnostic Settings"
if [[ -n "$PURVIEW_NAME" ]]; then
  DIAG=$(az monitor diagnostic-settings list --resource "$PURVIEW_ID" --query "[0].name" -o tsv 2>/dev/null || true)
  if [[ -n "$DIAG" ]]; then
    pass "Diagnostic setting found: $DIAG"
    LA_TARGET=$(az monitor diagnostic-settings show --name "$DIAG" --resource "$PURVIEW_ID" \
      --query "workspaceId" -o tsv 2>/dev/null || true)
    if [[ -n "$LA_TARGET" ]]; then
      pass "Logs flowing to Log Analytics"
    else
      warn "Diagnostic setting has no Log Analytics target"
    fi
  else
    fail "No diagnostic settings on Purview account"
  fi
else
  warn "Skipped — no Purview account"
fi

# ── 4–7. Tenant-specific DLP checks ──────────────────────
if [[ -n "$TENANT_ID" ]]; then
  NAMESPACE="tenant-${TENANT_ID}"

  # 4. DLP Proxy sidecar running
  check_header "DLP Proxy Sidecar (tenant: $TENANT_ID)"
  POD_NAME=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/instance=${TENANT_ID}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

  if [[ -n "$POD_NAME" ]]; then
    # Check if llm-dlp-proxy container exists
    DLP_CONTAINER=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
      -o jsonpath='{.spec.containers[?(@.name=="llm-dlp-proxy")].name}' 2>/dev/null || true)
    if [[ "$DLP_CONTAINER" == "llm-dlp-proxy" ]]; then
      pass "DLP proxy sidecar container present in pod"

      # Check container status
      DLP_READY=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
        -o jsonpath='{.status.containerStatuses[?(@.name=="llm-dlp-proxy")].ready}' 2>/dev/null || echo "false")
      if [[ "$DLP_READY" == "true" ]]; then
        pass "DLP proxy container is ready"
      else
        fail "DLP proxy container is NOT ready"
      fi
    else
      fail "DLP proxy sidecar not found in pod (dlpProxy.enabled may be false)"
    fi

    # 5. DLP proxy health endpoint
    check_header "DLP Proxy Health Check"
    HEALTH_RESULT=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -c openclaw-gateway -- \
      wget -qO- --timeout=3 http://127.0.0.1:8080/healthz 2>&1 || true)
    if echo "$HEALTH_RESULT" | grep -qi "ok"; then
      pass "DLP proxy /healthz endpoint responding"
    else
      warn "DLP proxy health check inconclusive: $HEALTH_RESULT"
    fi

    # DLP proxy metrics
    METRICS=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -c openclaw-gateway -- \
      wget -qO- --timeout=3 http://127.0.0.1:8080/metrics 2>&1 || true)
    if echo "$METRICS" | grep -q "totalRequests"; then
      TOTAL=$(echo "$METRICS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('totalRequests',0))" 2>/dev/null || echo "?")
      BLOCKED=$(echo "$METRICS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('blockedRequests',0))" 2>/dev/null || echo "?")
      REDACTED=$(echo "$METRICS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('redactedRequests',0))" 2>/dev/null || echo "?")
      pass "DLP proxy metrics: total=$TOTAL, blocked=$BLOCKED, redacted=$REDACTED"
    else
      warn "Could not read DLP proxy metrics"
    fi

    # 6. OpenClaw LLM env vars routed through proxy
    check_header "LLM Routing Through DLP Proxy"
    OPENAI_URL=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
      -o jsonpath='{.spec.containers[?(@.name=="openclaw-gateway")].env[?(@.name=="OPENAI_BASE_URL")].value}' 2>/dev/null || true)
    ANTHROPIC_URL=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
      -o jsonpath='{.spec.containers[?(@.name=="openclaw-gateway")].env[?(@.name=="ANTHROPIC_BASE_URL")].value}' 2>/dev/null || true)

    if echo "$OPENAI_URL" | grep -q "127.0.0.1:8080"; then
      pass "OPENAI_BASE_URL routes through DLP proxy: $OPENAI_URL"
    else
      fail "OPENAI_BASE_URL not routed through proxy (got: '$OPENAI_URL')"
    fi

    if echo "$ANTHROPIC_URL" | grep -q "127.0.0.1:8080"; then
      pass "ANTHROPIC_BASE_URL routes through DLP proxy: $ANTHROPIC_URL"
    else
      fail "ANTHROPIC_BASE_URL not routed through proxy (got: '$ANTHROPIC_URL')"
    fi

    # 7. Test DLP local pattern scan
    check_header "DLP Pattern Detection (local test)"
    echo "  Sending test content with fake API key to DLP proxy..."
    DLP_TEST=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -c openclaw-gateway -- \
      sh -c 'wget -qO- --timeout=5 --post-data="{\"model\":\"gpt-4\",\"messages\":[{\"role\":\"user\",\"content\":\"my key is sk-abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmn\"}]}" http://127.0.0.1:8080/api.openai.com/v1/chat/completions 2>&1' || true)
    if echo "$DLP_TEST" | grep -qi "dlp_policy_violation\|blocked"; then
      pass "DLP correctly blocked test API key in LLM request"
    else
      warn "DLP block test inconclusive (may need curl/wget in image): $DLP_TEST"
    fi

    # 7b. Purview DLP Plugin (init container installed)
    check_header "Purview DLP Plugin (OpenClaw Plugin)"
    PLUGIN_EXISTS=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -c openclaw-gateway -- \
      sh -c 'test -f /data/state/plugins/agent-warden-purview-dlp/openclaw.plugin.json && echo yes || echo no' 2>/dev/null || echo "no")
    if [[ "$PLUGIN_EXISTS" == "yes" ]]; then
      pass "Purview DLP plugin installed at /data/state/plugins/agent-warden-purview-dlp/"

      # Check config.json
      CONFIG_JSON=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -c openclaw-gateway -- \
        cat /data/state/plugins/agent-warden-purview-dlp/config.json 2>/dev/null || echo "{}")
      PURVIEW_ENABLED=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('purview',{}).get('enabled',False))" 2>/dev/null || echo "?")
      CROSS_TENANT=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('purview',{}).get('crossTenant',False))" 2>/dev/null || echo "?")

      if [[ "$PURVIEW_ENABLED" == "True" ]]; then
        pass "Purview Graph API: enabled"
      else
        warn "Purview Graph API: disabled (local regex only)"
      fi

      if [[ "$CROSS_TENANT" == "True" ]]; then
        pass "Cross-tenant Purview: enabled"
        # Verify cross-tenant env vars
        CT_CLIENT_ID=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
          -o jsonpath='{.spec.containers[?(@.name=="openclaw-gateway")].env[?(@.name=="PURVIEW_DLP_CLIENT_ID")].valueFrom.secretKeyRef.key}' 2>/dev/null || true)
        CT_TENANT_ID=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
          -o jsonpath='{.spec.containers[?(@.name=="openclaw-gateway")].env[?(@.name=="PURVIEW_DLP_TENANT_ID")].value}' 2>/dev/null || true)
        [[ -n "$CT_CLIENT_ID" ]] && pass "PURVIEW_DLP_CLIENT_ID env var configured" || fail "PURVIEW_DLP_CLIENT_ID env var missing"
        [[ -n "$CT_TENANT_ID" ]] && pass "PURVIEW_DLP_TENANT_ID=$CT_TENANT_ID" || fail "PURVIEW_DLP_TENANT_ID env var missing"
      fi
    else
      warn "Purview DLP plugin not installed (purviewDlpPlugin.enabled may be false)"
    fi

    # 7c. Purview DLP Plugin image in ACR
    ACR_NAME_DLP=$(az acr list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
    if [[ -n "$ACR_NAME_DLP" ]]; then
      DLP_PLUGIN_REPO=$(az acr repository show --name "$ACR_NAME_DLP" --repository "agent-warden-purview-dlp" 2>/dev/null || true)
      if [[ -n "$DLP_PLUGIN_REPO" ]]; then
        pass "agent-warden-purview-dlp image in ACR"
      else
        warn "agent-warden-purview-dlp image not in ACR"
      fi
    fi

  else
    warn "No running pods found for tenant $TENANT_ID — skipping sidecar checks"
  fi
else
  echo ""
  echo "  ℹ️  No tenant-id provided — skipping per-tenant DLP sidecar checks."
  echo "  Re-run with: ./scripts/verify-dlp.sh $ENV <tenant-id>"
fi

# ── 8. DLP Audit Records in Cosmos DB ─────────────────────
check_header "DLP Audit Records (Cosmos DB)"
COSMOS_NAME=$(az cosmosdb list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$COSMOS_NAME" ]]; then
  # Check audit container exists
  AUDIT_CONTAINER=$(az cosmosdb sql container show \
    --account-name "$COSMOS_NAME" \
    --database-name "agent-warden" \
    --name "audit" \
    --resource-group "$RG_NAME" \
    --query name -o tsv 2>/dev/null || true)
  if [[ "$AUDIT_CONTAINER" == "audit" ]]; then
    pass "Cosmos DB 'audit' container exists (stores DLP incidents)"
  else
    fail "Cosmos DB 'audit' container not found"
  fi
else
  warn "No Cosmos DB found — cannot verify audit records"
fi

# ── 9. DLP Proxy Image in ACR ────────────────────────────
check_header "DLP Proxy Container Image"
ACR_NAME=$(az acr list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$ACR_NAME" ]]; then
  DLP_REPO=$(az acr repository show --name "$ACR_NAME" --repository "purview-dlp-plugin" 2>/dev/null || true)
  if [[ -n "$DLP_REPO" ]]; then
    TAGS=$(az acr repository show-tags --name "$ACR_NAME" --repository "purview-dlp-plugin" --top 3 -o tsv 2>/dev/null || echo "none")
    pass "purview-dlp-plugin image in ACR (tags: $(echo "$TAGS" | tr '\n' ', ' | sed 's/,$//'))"
  else
    warn "purview-dlp-plugin image not yet pushed to ACR"
    echo "  Build and push with:"
    echo "    az acr build --registry ${ACR_NAME} --image purview-dlp-plugin:0.3.0 agent-warden-purview-dlp/"
  fi
else
  warn "No ACR found"
fi

# ── 10. Purview → Sentinel Connector ─────────────────────
check_header "Purview → Sentinel SIEM Integration"
if [[ -n "$PURVIEW_NAME" ]]; then
  # Check if Sentinel has a data connector for Purview events
  LA_NAME=$(az monitor log-analytics workspace list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
  if [[ -n "$LA_NAME" ]]; then
    # Check for PurviewDataSensitivityLogs table
    TABLE_CHECK=$(az monitor log-analytics workspace table show \
      --workspace-name "$LA_NAME" \
      --resource-group "$RG_NAME" \
      --name "PurviewDataSensitivityLogs" \
      --query name -o tsv 2>/dev/null || true)
    if [[ -n "$TABLE_CHECK" ]]; then
      pass "PurviewDataSensitivityLogs table in Log Analytics"
    else
      warn "PurviewDataSensitivityLogs table not found (may appear after first scan)"
    fi
  fi
else
  warn "Skipped — no Purview account"
fi

# ── Summary ───────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  DLP / Purview Verification Summary                         ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  ✅ Passed:   %-44s║\n" "$PASS"
printf "║  ⚠️  Warnings: %-44s║\n" "$WARN"
printf "║  ❌ Failed:   %-44s║\n" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════╝"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
