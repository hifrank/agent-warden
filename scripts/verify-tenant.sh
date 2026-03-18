#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Verify a single tenant deployment end-to-end
#
# Checks:
#   1.  Namespace exists with correct labels
#   2.  Per-tenant Key Vault (Premium, purge-protection, RBAC)
#   3.  Per-tenant Managed Identity + federated credential
#   4.  Helm release healthy
#   5.  StatefulSet replicas running
#   6.  PVCs bound (state-vol, work-vol)
#   7.  ServiceAccount with Workload Identity annotation
#   8.  SecretProviderClass (CSI → Key Vault)
#   9.  NetworkPolicy (default-deny + selective rules)
#  10.  ResourceQuota + LimitRange
#  11.  Service endpoint (port 18789)
#  12.  Pod readiness & liveness probes responding
#  13.  OpenClaw doctor (in-pod health)
#  14.  Key Vault secrets reachable from pod
#
# Usage: ./scripts/verify-tenant.sh <tenant-id> [environment]
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

TENANT_ID="${1:?Usage: $0 <tenant-id> [environment]}"
ENV="${2:-dev}"

BASE_NAME="agentwarden"
RG_NAME="rg-${BASE_NAME}-${ENV}"
NAMESPACE="tenant-${TENANT_ID}"
KV_NAME="kv-${TENANT_ID}"
KV_NAME="${KV_NAME:0:24}"
MI_NAME="mi-${TENANT_ID}"
HELM_RELEASE="oc-${TENANT_ID}"

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }
warn() { echo "  ⚠️  $1"; ((WARN++)); }
check_header() { echo ""; echo "━━━ $1 ━━━"; }

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Agent Warden — Tenant Verification: $TENANT_ID"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── 1. Namespace ──────────────────────────────────────────
check_header "Namespace"
if kubectl get namespace "$NAMESPACE" &>/dev/null; then
  pass "Namespace $NAMESPACE exists"
  NS_LABELS=$(kubectl get namespace "$NAMESPACE" -o jsonpath='{.metadata.labels}')
  if echo "$NS_LABELS" | grep -q "$TENANT_ID"; then
    pass "Namespace labeled with tenant ID"
  else
    warn "Namespace missing tenant-specific labels"
  fi
else
  fail "Namespace $NAMESPACE not found"
  echo ""
  echo "Tenant does not appear to be provisioned. Run:"
  echo "  ./scripts/provision-tenant.sh $TENANT_ID <tier> <email>"
  exit 1
fi

# ── 2. Key Vault ─────────────────────────────────────────
check_header "Per-Tenant Key Vault"
if az keyvault show --name "$KV_NAME" &>/dev/null; then
  KV_JSON=$(az keyvault show --name "$KV_NAME" -o json)
  KV_SKU=$(echo "$KV_JSON" | jq -r '.properties.sku.name')
  PURGE=$(echo "$KV_JSON" | jq -r '.properties.enablePurgeProtection // false')
  RBAC=$(echo "$KV_JSON" | jq -r '.properties.enableRbacAuthorization')
  pass "Key Vault $KV_NAME exists"
  [[ "$KV_SKU" == "premium" ]] && pass "SKU: Premium" || warn "SKU: $KV_SKU"
  [[ "$PURGE" == "true" ]] && pass "Purge protection enabled" || fail "Purge protection not enabled"
  [[ "$RBAC" == "true" ]] && pass "RBAC authorization enabled" || fail "RBAC not enabled"

  # Check for expected secrets
  echo ""
  echo "  Key Vault Secrets:"
  SECRETS=$(az keyvault secret list --vault-name "$KV_NAME" --query "[].name" -o tsv 2>/dev/null || true)
  if [[ -n "$SECRETS" ]]; then
    for S in $SECRETS; do
      pass "  Secret: $S"
    done
  else
    warn "  No secrets found — run set-tenant-secrets.sh"
  fi

  # Check expected secrets exist
  for EXPECTED_SECRET in openai-api-key anthropic-api-key; do
    if echo "$SECRETS" | grep -q "^${EXPECTED_SECRET}$"; then
      : # already printed
    else
      warn "  Missing recommended secret: $EXPECTED_SECRET"
    fi
  done
else
  fail "Key Vault $KV_NAME not found"
fi

# ── 3. Managed Identity ──────────────────────────────────
check_header "Managed Identity"
if az identity show --name "$MI_NAME" --resource-group "$RG_NAME" &>/dev/null; then
  MI_CLIENT_ID=$(az identity show --name "$MI_NAME" --resource-group "$RG_NAME" --query clientId -o tsv)
  pass "Managed Identity $MI_NAME exists (clientId: $MI_CLIENT_ID)"

  # Check federated credential
  FED_CRED=$(az identity federated-credential list \
    --identity-name "$MI_NAME" \
    --resource-group "$RG_NAME" \
    --query "[].name" -o tsv 2>/dev/null || true)
  if [[ -n "$FED_CRED" ]]; then
    for FC in $FED_CRED; do
      FC_JSON=$(az identity federated-credential show \
        --name "$FC" \
        --identity-name "$MI_NAME" \
        --resource-group "$RG_NAME" \
        -o json 2>/dev/null || echo "{}")
      SUBJECT=$(echo "$FC_JSON" | jq -r '.subject // "unknown"')
      ISSUER=$(echo "$FC_JSON" | jq -r '.issuer // "unknown"')
      pass "Federated credential: $FC (subject: $SUBJECT)"

      # Validate OIDC issuer matches current AKS cluster
      CURRENT_ISSUER=$(az aks show -g "$RG_NAME" -n "$(az aks list -g "$RG_NAME" --query '[0].name' -o tsv 2>/dev/null)" --query oidcIssuerProfile.issuerUrl -o tsv 2>/dev/null || true)
      if [[ -n "$CURRENT_ISSUER" && "$ISSUER" == "$CURRENT_ISSUER" ]]; then
        pass "OIDC issuer matches current AKS cluster"
      elif [[ -n "$CURRENT_ISSUER" ]]; then
        fail "OIDC issuer MISMATCH: federated=$ISSUER, AKS=$CURRENT_ISSUER"
        echo "  ➡ Fix: az identity federated-credential update --name $FC --identity-name $MI_NAME --resource-group $RG_NAME --issuer \"$CURRENT_ISSUER\" --subject \"$SUBJECT\""
      fi
    done
  else
    fail "No federated credentials found for $MI_NAME"
  fi

  # Check Azure OpenAI RBAC (if AOAI exists)
  AOAI_NAME=$(az cognitiveservices account list --resource-group "$RG_NAME" --query "[?kind=='OpenAI'].name | [0]" -o tsv 2>/dev/null || true)
  if [[ -n "$AOAI_NAME" ]]; then
    AOAI_ID=$(az cognitiveservices account show --name "$AOAI_NAME" --resource-group "$RG_NAME" --query id -o tsv 2>/dev/null || true)
    AOAI_ROLE=$(az role assignment list --scope "$AOAI_ID" --assignee "$MI_PRINCIPAL" \
      --query "[?contains(roleDefinitionName,'OpenAI')].roleDefinitionName | [0]" -o tsv 2>/dev/null || true)
    if [[ -n "$AOAI_ROLE" ]]; then
      pass "MI has '$AOAI_ROLE' on Azure OpenAI ($AOAI_NAME)"
    else
      warn "MI missing Azure OpenAI RBAC role on $AOAI_NAME"
    fi
  fi

  # Check Key Vault role assignment
  KV_ID=$(az keyvault show --name "$KV_NAME" --query id -o tsv 2>/dev/null || true)
  if [[ -n "$KV_ID" ]]; then
    MI_PRINCIPAL=$(az identity show --name "$MI_NAME" --resource-group "$RG_NAME" --query principalId -o tsv)
    ROLE_ASSIGNED=$(az role assignment list --scope "$KV_ID" --assignee "$MI_PRINCIPAL" --query "[?roleDefinitionName=='Key Vault Secrets User'].id" -o tsv 2>/dev/null || true)
    if [[ -n "$ROLE_ASSIGNED" ]]; then
      pass "MI has 'Key Vault Secrets User' role on $KV_NAME"
    else
      fail "MI missing 'Key Vault Secrets User' role on $KV_NAME"
    fi
  fi
else
  fail "Managed Identity $MI_NAME not found in $RG_NAME"
fi

# ── 4. Helm Release ──────────────────────────────────────
check_header "Helm Release"
# Try both naming conventions: oc-<tenant> and <tenant>
HELM_STATUS="{}"
for CANDIDATE in "$HELM_RELEASE" "$TENANT_ID" "demo-${TENANT_ID##demo-}"; do
  HELM_STATUS=$(helm status "$CANDIDATE" -n "$NAMESPACE" --output json 2>/dev/null || echo "{}")
  if echo "$HELM_STATUS" | jq -r '.info.status' 2>/dev/null | grep -q "deployed"; then
    HELM_RELEASE="$CANDIDATE"
    break
  fi
done
if echo "$HELM_STATUS" | jq -r '.info.status' 2>/dev/null | grep -q "deployed"; then
  HELM_VERSION=$(echo "$HELM_STATUS" | jq -r '.version')
  HELM_UPDATED=$(echo "$HELM_STATUS" | jq -r '.info.last_deployed')
  pass "Helm release $HELM_RELEASE deployed (revision $HELM_VERSION, $HELM_UPDATED)"
else
  fail "Helm release not found in $NAMESPACE (tried oc-${TENANT_ID}, ${TENANT_ID})"
fi

# ── 5. StatefulSet ────────────────────────────────────────
check_header "StatefulSet"
STS_NAME="openclaw-${TENANT_ID}"
if kubectl get statefulset "$STS_NAME" -n "$NAMESPACE" &>/dev/null; then
  STS_JSON=$(kubectl get statefulset "$STS_NAME" -n "$NAMESPACE" -o json)
  DESIRED=$(echo "$STS_JSON" | jq -r '.spec.replicas')
  READY=$(echo "$STS_JSON" | jq -r '.status.readyReplicas // 0')
  pass "StatefulSet $STS_NAME: $READY/$DESIRED ready"
  if [[ "$READY" -lt "$DESIRED" ]]; then
    fail "Not all replicas ready ($READY/$DESIRED)"
  fi

  # Check volume claim templates
  VCT_COUNT=$(echo "$STS_JSON" | jq '.spec.volumeClaimTemplates | length')
  pass "Volume claim templates: $VCT_COUNT"
  for i in $(seq 0 $((VCT_COUNT - 1))); do
    VCT_NAME=$(echo "$STS_JSON" | jq -r ".spec.volumeClaimTemplates[$i].metadata.name")
    VCT_SIZE=$(echo "$STS_JSON" | jq -r ".spec.volumeClaimTemplates[$i].spec.resources.requests.storage")
    VCT_SC=$(echo "$STS_JSON" | jq -r ".spec.volumeClaimTemplates[$i].spec.storageClassName")
    pass "  $VCT_NAME: $VCT_SIZE ($VCT_SC)"
  done
else
  fail "StatefulSet $STS_NAME not found in $NAMESPACE"
fi

# ── 6. PVCs ───────────────────────────────────────────────
check_header "Persistent Volume Claims"
PVCS=$(kubectl get pvc -n "$NAMESPACE" --no-headers 2>/dev/null || true)
if [[ -n "$PVCS" ]]; then
  while IFS= read -r line; do
    PVC_NAME=$(echo "$line" | awk '{print $1}')
    PVC_STATUS=$(echo "$line" | awk '{print $2}')
    PVC_SIZE=$(echo "$line" | awk '{print $4}')
    if [[ "$PVC_STATUS" == "Bound" ]]; then
      pass "PVC $PVC_NAME: Bound ($PVC_SIZE)"
    else
      fail "PVC $PVC_NAME: $PVC_STATUS (expected Bound)"
    fi
  done <<< "$PVCS"
else
  fail "No PVCs found in $NAMESPACE"
fi

# ── 7. ServiceAccount ────────────────────────────────────
check_header "ServiceAccount (Workload Identity)"
SA_NAME="openclaw-${TENANT_ID}"
if kubectl get serviceaccount "$SA_NAME" -n "$NAMESPACE" &>/dev/null; then
  pass "ServiceAccount $SA_NAME exists"
  WI_CLIENT=$(kubectl get serviceaccount "$SA_NAME" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.azure\.workload\.identity/client-id}' 2>/dev/null || true)
  if [[ -n "$WI_CLIENT" ]]; then
    pass "Workload Identity annotation: $WI_CLIENT"
  else
    fail "Missing azure.workload.identity/client-id annotation"
  fi
else
  fail "ServiceAccount $SA_NAME not found"
fi

# ── 8. SecretProviderClass ────────────────────────────────
check_header "SecretProviderClass (CSI → Key Vault)"
SPC_OUTPUT=$(kubectl get secretproviderclass -n "$NAMESPACE" --no-headers 2>/dev/null || true)
if [[ -n "$SPC_OUTPUT" ]]; then
  SPC_NAME=$(echo "$SPC_OUTPUT" | head -1 | awk '{print $1}')
  pass "SecretProviderClass found: $SPC_NAME"
  SPC_KV=$(kubectl get secretproviderclass "$SPC_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.parameters.keyvaultName}' 2>/dev/null || true)
  if [[ "$SPC_KV" == "$KV_NAME" ]]; then
    pass "Points to correct Key Vault: $SPC_KV"
  else
    warn "Key Vault name mismatch: got '$SPC_KV', expected '$KV_NAME'"
  fi
else
  fail "No SecretProviderClass found in $NAMESPACE"
fi

# ── 9. NetworkPolicy ─────────────────────────────────────
check_header "NetworkPolicy"
NP_COUNT=$(kubectl get networkpolicy -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [[ "$NP_COUNT" -gt 0 ]]; then
  pass "$NP_COUNT NetworkPolicy object(s) found"
  NP_NAMES=$(kubectl get networkpolicy -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}')
  for NP in $NP_NAMES; do
    pass "  NetworkPolicy: $NP"
  done

  # Check for default-deny
  if echo "$NP_NAMES" | grep -q "default-deny"; then
    pass "Default-deny policy present"
  else
    warn "No default-deny policy detected"
  fi
else
  fail "No NetworkPolicies in $NAMESPACE (tenant is not isolated!)"
fi

# ── 10. ResourceQuota + LimitRange ────────────────────────
check_header "ResourceQuota & LimitRange"
RQ=$(kubectl get resourcequota -n "$NAMESPACE" --no-headers 2>/dev/null || true)
if [[ -n "$RQ" ]]; then
  RQ_NAME=$(echo "$RQ" | head -1 | awk '{print $1}')
  pass "ResourceQuota: $RQ_NAME"
  # Show key quotas
  CPU_LIMIT=$(kubectl get resourcequota "$RQ_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.hard.limits\.cpu}' 2>/dev/null || echo "?")
  MEM_LIMIT=$(kubectl get resourcequota "$RQ_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.hard.limits\.memory}' 2>/dev/null || echo "?")
  POD_LIMIT=$(kubectl get resourcequota "$RQ_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.hard.pods}' 2>/dev/null || echo "?")
  pass "  CPU limit: $CPU_LIMIT, Memory limit: $MEM_LIMIT, Pods: $POD_LIMIT"
else
  fail "No ResourceQuota in $NAMESPACE"
fi

LR=$(kubectl get limitrange -n "$NAMESPACE" --no-headers 2>/dev/null || true)
if [[ -n "$LR" ]]; then
  LR_NAME=$(echo "$LR" | head -1 | awk '{print $1}')
  pass "LimitRange: $LR_NAME"
else
  warn "No LimitRange in $NAMESPACE"
fi

# ── 11. Service ───────────────────────────────────────────
check_header "Service"
SVC_NAME="openclaw-${TENANT_ID}"
if kubectl get service "$SVC_NAME" -n "$NAMESPACE" &>/dev/null; then
  SVC_PORT=$(kubectl get service "$SVC_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.ports[0].port}')
  SVC_TYPE=$(kubectl get service "$SVC_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.type}')
  pass "Service $SVC_NAME ($SVC_TYPE, port $SVC_PORT)"
  if [[ "$SVC_PORT" == "18789" ]]; then
    pass "Correct OpenClaw port (18789)"
  else
    warn "Service port $SVC_PORT (expected 18789)"
  fi
else
  fail "Service $SVC_NAME not found"
fi

# ── 12. Pod health probes ────────────────────────────────
check_header "Pod Health"
POD_NAME=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/instance=${TENANT_ID}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [[ -n "$POD_NAME" ]]; then
  POD_STATUS=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.phase}')
  RESTARTS=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null || echo "0")
  pass "Pod $POD_NAME: $POD_STATUS (restarts: $RESTARTS)"

  if [[ "$RESTARTS" -gt 5 ]]; then
    fail "High restart count ($RESTARTS) — check logs"
  elif [[ "$RESTARTS" -gt 0 ]]; then
    warn "Pod has restarted $RESTARTS time(s)"
  fi

  # Check readiness
  READY=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null || echo "false")
  if [[ "$READY" == "true" ]]; then
    pass "Readiness check: passing"
  else
    fail "Readiness check: failing"
  fi

  # Check liveness probe response
  LIVENESS=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.containers[0].livenessProbe}' 2>/dev/null || true)
  if [[ -n "$LIVENESS" && "$LIVENESS" != "{}" ]]; then
    pass "Liveness probe configured"
  else
    warn "No liveness probe configured"
  fi

  # Check security context
  RUN_AS=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.containers[0].securityContext.runAsNonRoot}' 2>/dev/null || echo "false")
  READ_ONLY=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.containers[0].securityContext.readOnlyRootFilesystem}' 2>/dev/null || echo "false")
  if [[ "$RUN_AS" == "true" ]]; then
    pass "runAsNonRoot: true"
  else
    warn "runAsNonRoot not set"
  fi
  if [[ "$READ_ONLY" == "true" ]]; then
    pass "readOnlyRootFilesystem: true"
  else
    warn "readOnlyRootFilesystem not set"
  fi
else
  fail "No pods found for tenant $TENANT_ID"
fi

# ── 13. OpenClaw doctor ──────────────────────────────────
check_header "OpenClaw Doctor (In-Pod)"
if [[ -n "$POD_NAME" && "$POD_STATUS" == "Running" ]]; then
  DOCTOR_OUTPUT=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -c openclaw-gateway -- openclaw doctor 2>&1 || true)
  if echo "$DOCTOR_OUTPUT" | grep -qi "healthy\|ok\|pass"; then
    pass "openclaw doctor reports healthy"
  elif echo "$DOCTOR_OUTPUT" | grep -qi "error\|fail\|critical"; then
    fail "openclaw doctor reports issues"
  else
    warn "openclaw doctor output unclear — review manually"
  fi
  echo "  --- openclaw doctor output ---"
  echo "$DOCTOR_OUTPUT" | sed 's/^/  │ /'
  echo "  --- end ---"
else
  warn "Skipped — no running pod available"
fi

# ── 14. CSI Secret Mount ─────────────────────────────────
check_header "Key Vault Secrets Mount"
if [[ -n "$POD_NAME" && "$POD_STATUS" == "Running" ]]; then
  # Check if secrets volume is mounted
  MOUNT_CHECK=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -c openclaw-gateway -- ls /mnt/secrets-store/ 2>&1 || true)
  if [[ -n "$MOUNT_CHECK" && ! "$MOUNT_CHECK" =~ "No such file" && ! "$MOUNT_CHECK" =~ "error" ]]; then
    SECRET_FILES=$(echo "$MOUNT_CHECK" | wc -l | tr -d ' ')
    pass "Secrets store mounted with $SECRET_FILES file(s)"
    echo "$MOUNT_CHECK" | while read -r f; do
      [[ -n "$f" ]] && pass "  Mounted secret: $f"
    done
  else
    warn "Secrets store mount not accessible (Key Vault may have no secrets yet)"
  fi
else
  warn "Skipped — no running pod available"
fi

# ── Summary ───────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Tenant Verification Summary: $TENANT_ID"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  ✅ Passed:   %-44s║\n" "$PASS"
printf "║  ⚠️  Warnings: %-44s║\n" "$WARN"
printf "║  ❌ Failed:   %-44s║\n" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════╝"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
