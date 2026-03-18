#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Master verification — runs all verification scripts in order
#
# Usage:
#   ./scripts/verify-all.sh [environment] [tenant-id]
#
# Examples:
#   ./scripts/verify-all.sh                     # infra + k8s + cicd + security
#   ./scripts/verify-all.sh dev                  # same, explicit env
#   ./scripts/verify-all.sh dev acme-corp        # + tenant verification
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV="${1:-dev}"
TENANT_ID="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TOTAL_PASS=0
TOTAL_FAIL=0
SECTION_RESULTS=()

run_verify() {
  local name="$1"
  local script="$2"
  shift 2
  local args=("$@")

  echo ""
  echo "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"
  echo "┃  STEP: $name"
  echo "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"

  if [[ -x "$script" ]]; then
    if "$script" "${args[@]}" 2>&1; then
      SECTION_RESULTS+=("✅ $name")
    else
      SECTION_RESULTS+=("❌ $name")
      ((TOTAL_FAIL++))
    fi
  else
    echo "  ⚠️  Script not found or not executable: $script"
    SECTION_RESULTS+=("⚠️  $name (script missing)")
  fi
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Agent Warden — Full Platform Verification                  ║"
echo "║  Environment: $ENV"
if [[ -n "$TENANT_ID" ]]; then
  echo "║  Tenant: $TENANT_ID"
fi
echo "╚══════════════════════════════════════════════════════════════╝"

# ── Run each verification step ────────────────────────────
run_verify "1. Azure Infrastructure" "$SCRIPT_DIR/verify-infra.sh" "$ENV"
run_verify "2. Kubernetes Base" "$SCRIPT_DIR/verify-k8s-base.sh"
run_verify "3. CI/CD Pipeline" "$SCRIPT_DIR/verify-cicd.sh" "$ENV"
run_verify "4. Security Posture" "$SCRIPT_DIR/verify-security.sh" "$ENV"
run_verify "5. DLP / Purview" "$SCRIPT_DIR/verify-dlp.sh" "$ENV" ${TENANT_ID:+"$TENANT_ID"}

if [[ -n "$TENANT_ID" ]]; then
  run_verify "6. Tenant: $TENANT_ID" "$SCRIPT_DIR/verify-tenant.sh" "$TENANT_ID" "$ENV"
fi

# ── Overall Summary ───────────────────────────────────────
echo ""
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  OVERALL VERIFICATION SUMMARY                               ║"
echo "╠══════════════════════════════════════════════════════════════╣"
for result in "${SECTION_RESULTS[@]}"; do
  printf "║  %-58s║\n" "$result"
done
echo "╠══════════════════════════════════════════════════════════════╣"
if [[ $TOTAL_FAIL -eq 0 ]]; then
  echo "║  ✅ ALL STEPS PASSED                                        ║"
else
  printf "║  ❌ %d STEP(S) FAILED %-38s║\n" "$TOTAL_FAIL" ""
fi
echo "╚══════════════════════════════════════════════════════════════╝"

if [[ $TOTAL_FAIL -gt 0 ]]; then
  exit 1
fi
