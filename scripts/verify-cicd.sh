#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Verify CI/CD pipeline prerequisites and configuration
#
# Checks:
#   1. GitHub Actions workflow files exist and are valid YAML
#   2. Required GitHub secrets are documented
#   3. Dockerfile availability for each image
#   4. Helm chart linting
#   5. Terraform validation
#   6. OIDC federated credential for GitHub Actions
#   7. ACR accessibility
#
# Usage: ./scripts/verify-cicd.sh [environment]
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV="${1:-dev}"
BASE_NAME="agentwarden"
RG_NAME="rg-${BASE_NAME}-${ENV}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }
warn() { echo "  ⚠️  $1"; ((WARN++)); }
check_header() { echo ""; echo "━━━ $1 ━━━"; }

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Agent Warden — CI/CD Verification                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── 1. Workflow Files ─────────────────────────────────────
check_header "GitHub Actions Workflow Files"
WORKFLOW_DIR="$REPO_ROOT/.github/workflows"
EXPECTED_WORKFLOWS=(
  "infra-terraform.yaml"
  "build-images.yaml"
  "deploy-k8s.yaml"
  "security-scan.yaml"
)

if [[ -d "$WORKFLOW_DIR" ]]; then
  pass "Workflow directory exists: .github/workflows/"
  for WF in "${EXPECTED_WORKFLOWS[@]}"; do
    if [[ -f "$WORKFLOW_DIR/$WF" ]]; then
      pass "Workflow: $WF"
      # Validate YAML syntax
      if command -v python3 &>/dev/null; then
        if python3 -c "import yaml; yaml.safe_load(open('$WORKFLOW_DIR/$WF'))" 2>/dev/null; then
          pass "  Valid YAML syntax"
        else
          fail "  Invalid YAML syntax in $WF"
        fi
      elif command -v yq &>/dev/null; then
        if yq eval '.' "$WORKFLOW_DIR/$WF" &>/dev/null; then
          pass "  Valid YAML syntax"
        else
          fail "  Invalid YAML syntax in $WF"
        fi
      else
        warn "  Cannot validate YAML (install pyyaml or yq)"
      fi

      # Check for OIDC auth pattern (no static secrets)
      if grep -q "id-token: write" "$WORKFLOW_DIR/$WF"; then
        pass "  OIDC permissions configured"
      else
        warn "  Missing 'id-token: write' — may use static secrets"
      fi
    else
      fail "Missing workflow: $WF"
    fi
  done
else
  fail "Workflow directory .github/workflows/ not found"
fi

# ── 2. Dockerfiles ────────────────────────────────────────
check_header "Dockerfiles"
DOCKER_CONTEXTS=(
  "agent-warden-server:Agent Warden Server"
  "agent-warden-openclaw:Custom OpenClaw (agent-browser + Chrome)"
  "k8s/operator:Kubernetes Operator"
)

for ENTRY in "${DOCKER_CONTEXTS[@]}"; do
  CTX="${ENTRY%%:*}"
  DESC="${ENTRY##*:}"
  if [[ -f "$REPO_ROOT/$CTX/Dockerfile" ]]; then
    pass "$DESC: Dockerfile found ($CTX/Dockerfile)"
    # Check for non-root USER directive
    if grep -q "^USER" "$REPO_ROOT/$CTX/Dockerfile"; then
      pass "  Non-root USER directive present"
    else
      warn "  No USER directive — image may run as root"
    fi
  else
    warn "$DESC: No Dockerfile at $CTX/Dockerfile (needed for CI build)"
  fi
done

# ── 3. Helm Chart Lint ────────────────────────────────────
check_header "Helm Chart Validation"
CHART_PATH="$REPO_ROOT/k8s/helm/openclaw-tenant"
if [[ -f "$CHART_PATH/Chart.yaml" ]]; then
  pass "Chart.yaml exists"
  if command -v helm &>/dev/null; then
    LINT_OUTPUT=$(helm lint "$CHART_PATH" \
      --set tenantId=test-tenant \
      --set tier=free \
      --set keyVault.name=kv-test \
      --set keyVault.clientId=00000000-0000-0000-0000-000000000000 \
      --set keyVault.tenantIdEntra=00000000-0000-0000-0000-000000000000 \
      2>&1 || true)
    if echo "$LINT_OUTPUT" | grep -q "0 chart(s) failed"; then
      pass "Helm lint passed"
    elif echo "$LINT_OUTPUT" | grep -qi "error"; then
      fail "Helm lint errors:"
      echo "$LINT_OUTPUT" | grep -i "error" | sed 's/^/    /'
    else
      pass "Helm lint completed"
    fi

    # Template render test
    TEMPLATE_OUTPUT=$(helm template test-release "$CHART_PATH" \
      --set tenantId=test-tenant \
      --set tier=free \
      --set keyVault.name=kv-test \
      --set keyVault.clientId=00000000-0000-0000-0000-000000000000 \
      --set keyVault.tenantIdEntra=00000000-0000-0000-0000-000000000000 \
      2>&1 || true)
    if [[ $? -eq 0 ]] && echo "$TEMPLATE_OUTPUT" | grep -q "kind:"; then
      RESOURCE_COUNT=$(echo "$TEMPLATE_OUTPUT" | grep "^kind:" | wc -l | tr -d ' ')
      pass "Helm template renders $RESOURCE_COUNT resource(s)"
    else
      fail "Helm template rendering failed"
    fi
  else
    warn "Helm CLI not available — skipping lint"
  fi
else
  fail "Chart.yaml not found at $CHART_PATH"
fi

# ── 4. Terraform Validation ──────────────────────────────
check_header "Terraform Validation"
TF_DIR="$REPO_ROOT/infra/terraform"
if [[ -f "$TF_DIR/main.tf" ]]; then
  pass "Terraform main.tf exists"
  if command -v terraform &>/dev/null; then
    TF_FMT=$(cd "$TF_DIR" && terraform fmt -check -recursive 2>&1 || true)
    if [[ -z "$TF_FMT" ]]; then
      pass "Terraform formatting correct"
    else
      warn "Terraform formatting issues:"
      echo "$TF_FMT" | head -5 | sed 's/^/    /'
    fi

    # Validate (requires init, so just check for obvious issues)
    if [[ -d "$TF_DIR/.terraform" ]]; then
      TF_VAL=$(cd "$TF_DIR" && terraform validate 2>&1 || true)
      if echo "$TF_VAL" | grep -q "Success"; then
        pass "Terraform validation passed"
      else
        warn "Terraform validation issues (may need init first)"
      fi
    else
      warn "Terraform not initialized — run 'terraform init' first for validation"
    fi
  else
    warn "Terraform CLI not available — skipping validation"
  fi

  # Check that all modules exist
  MODULES=$(grep -o 'source *= *"./modules/[^"]*"' "$TF_DIR/main.tf" | sed 's/.*"\(.*\)"/\1/' || true)
  if [[ -n "$MODULES" ]]; then
    while IFS= read -r mod; do
      if [[ -d "$TF_DIR/$mod" ]]; then
        pass "Module: $mod"
      else
        fail "Missing module: $mod"
      fi
    done <<< "$MODULES"
  fi
else
  fail "No Terraform main.tf found"
fi

# ── 5. ACR Access ─────────────────────────────────────────
check_header "Container Registry Access"
ACR_NAME=$(az acr list --resource-group "$RG_NAME" --query "[0].name" -o tsv 2>/dev/null || true)
if [[ -n "$ACR_NAME" ]]; then
  pass "ACR found: $ACR_NAME"
  # Test login
  if az acr login --name "$ACR_NAME" --expose-token &>/dev/null 2>&1; then
    pass "ACR login successful"
  else
    warn "Cannot login to ACR (may need different credentials)"
  fi

  # Check for existing images
  REPOS=$(az acr repository list --name "$ACR_NAME" -o tsv 2>/dev/null || true)
  if [[ -n "$REPOS" ]]; then
    echo "  Existing repositories:"
    for REPO in $REPOS; do
      TAGS=$(az acr repository show-tags --name "$ACR_NAME" --repository "$REPO" --top 3 -o tsv 2>/dev/null || echo "no-tags")
      pass "  $REPO (latest tags: $(echo "$TAGS" | tr '\n' ', ' | sed 's/,$//'))"
    done
  else
    warn "No images pushed to ACR yet"
  fi
else
  warn "No ACR found in $RG_NAME"
fi

# ── 6. OIDC Federated Credential (GitHub Actions) ────────
check_header "GitHub OIDC Federation"
echo "  Checking for app registrations with GitHub OIDC..."
# Look for federated credentials with GitHub Actions issuer
APP_IDS=$(az ad app list --display-name "agent-warden" --query "[].appId" -o tsv 2>/dev/null || true)
if [[ -n "$APP_IDS" ]]; then
  for APP_ID in $APP_IDS; do
    APP_NAME=$(az ad app show --id "$APP_ID" --query displayName -o tsv 2>/dev/null)
    pass "App Registration: $APP_NAME ($APP_ID)"
    FEDS=$(az ad app federated-credential list --id "$APP_ID" --query "[].{name:name, issuer:issuer, subject:subject}" -o json 2>/dev/null || echo "[]")
    FED_COUNT=$(echo "$FEDS" | jq 'length')
    if [[ "$FED_COUNT" -gt 0 ]]; then
      for i in $(seq 0 $((FED_COUNT - 1))); do
        FED_NAME=$(echo "$FEDS" | jq -r ".[$i].name")
        FED_ISSUER=$(echo "$FEDS" | jq -r ".[$i].issuer")
        FED_SUBJECT=$(echo "$FEDS" | jq -r ".[$i].subject")
        if echo "$FED_ISSUER" | grep -q "token.actions.githubusercontent.com"; then
          pass "  Federated cred: $FED_NAME (GitHub Actions → $FED_SUBJECT)"
        else
          pass "  Federated cred: $FED_NAME (issuer: $FED_ISSUER)"
        fi
      done
    else
      warn "  No federated credentials — GitHub Actions OIDC not configured"
    fi
  done
else
  warn "No 'agent-warden' app registration found — OIDC not set up"
  echo "  See README.md → Manual Steps → Entra ID App Registration"
fi

# ── 7. Required Secrets Checklist ─────────────────────────
check_header "Required GitHub Secrets (Manual Checklist)"
echo "  The following secrets must be configured in GitHub → Settings → Secrets:"
REQUIRED_SECRETS=(
  "AZURE_CLIENT_ID"
  "AZURE_TENANT_ID"
  "AZURE_SUBSCRIPTION_ID"
  "AKS_ADMIN_GROUP_ID"
  "AZURE_RESOURCE_GROUP"
  "AKS_CLUSTER_NAME"
  "ACR_NAME"
)
for SECRET in "${REQUIRED_SECRETS[@]}"; do
  warn "Ensure GitHub secret is set: $SECRET"
done
echo ""
echo "  (Cannot verify GitHub secrets from CLI — check manually at:"
echo "   https://github.com/<org>/<repo>/settings/secrets/actions)"

# ── Summary ───────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  CI/CD Verification Summary                                 ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  ✅ Passed:   %-44s║\n" "$PASS"
printf "║  ⚠️  Warnings: %-44s║\n" "$WARN"
printf "║  ❌ Failed:   %-44s║\n" "$FAIL"
echo "╚══════════════════════════════════════════════════════════════╝"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
