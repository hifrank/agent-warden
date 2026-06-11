#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Setup Agent 365 Blueprint + Identity for Agent Warden
#
# This script creates the Agent Blueprint (Entra app registration),
# agentic app instance, and agentic user via the Agent 365 CLI.
#
# Prerequisites:
#   - Agent 365 CLI installed (npm i -g @microsoft/agents-a365-cli)
#   - Azure CLI logged in (az login)
#   - Frontier Preview Program enrollment granted
#   - Global Administrator, Agent ID Administrator, or Agent ID Developer role
#
# What this script does:
#   1. Creates a365.config.json (if not exists)
#   2. Runs `a365 setup all` to create:
#      - Agent Blueprint (Entra app reg)
#      - Service principal
#      - Azure infrastructure (App Service Plan + Web App — used by A365 for messaging)
#      - API permissions (Graph, Messaging Bot, Observability)
#   3. Extracts outputs from a365.generated.config.json
#   4. Stores credentials in Key Vault
#   5. Prints Helm values to configure the plugin
#
# Usage:
#   ./scripts/setup-a365-blueprint.sh [--skip-setup]
#   --skip-setup: Skip `a365 setup all` (use existing a365.generated.config.json)
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SKIP_SETUP=false
if [[ "${1:-}" == "--skip-setup" ]]; then
  SKIP_SETUP=true
fi

# ── Configuration ──
ENV="${ENV:-dev}"
BASE_NAME="${BASE_NAME:-agentwarden}"
RG_NAME="rg-${BASE_NAME}-${ENV}"
KEY_VAULT_NAME="${KEY_VAULT_NAME:-kv-demo-tenant}"
TENANT_DOMAIN="${TENANT_DOMAIN:-aprforazure.onmicrosoft.com}"
ENTRA_TENANT_ID="${ENTRA_TENANT_ID:-dab94ed2-4cee-4b36-b007-6618f570b4a3}"
AGENT_NAME="${AGENT_NAME:-Agent Warden}"
AGENT_UPN_PREFIX="${AGENT_UPN_PREFIX:-agentwarden}"
MANAGER_EMAIL="${MANAGER_EMAIL:-admin@${TENANT_DOMAIN}}"
REGION="${REGION:-eastus2}"

CONFIG_FILE="a365.config.json"
GENERATED_FILE="a365.generated.config.json"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Agent 365 Blueprint Setup — ${AGENT_NAME}                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Step 0: Verify prerequisites ──
echo "▸ Checking prerequisites..."

if ! command -v a365 &>/dev/null; then
  echo "ERROR: Agent 365 CLI not found. Install with:"
  echo "  dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease"
  exit 1
fi
echo "  ✓ a365 CLI: $(a365 --version 2>/dev/null || echo 'installed')"

if ! command -v az &>/dev/null; then
  echo "ERROR: Azure CLI not found."
  exit 1
fi

# Verify Azure login
ACCOUNT=$(az account show --query '{sub:name, tenant:tenantId}' -o json 2>/dev/null || true)
if [[ -z "$ACCOUNT" ]]; then
  echo "ERROR: Not logged into Azure CLI. Run: az login"
  exit 1
fi
echo "  ✓ Azure CLI: $(echo "$ACCOUNT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["sub"])')"

# ── Step 1: Create a365.config.json ──
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo ""
  echo "▸ Creating ${CONFIG_FILE}..."
  cat > "$CONFIG_FILE" <<EOF
{
  "tenantId": "${ENTRA_TENANT_ID}",
  "subscriptionId": "$(az account show --query id -o tsv)",
  "resourceGroup": "${RG_NAME}",
  "location": "${REGION}",
  "environment": "prod",
  "needDeployment": true,
  "appServicePlanName": "asp-${BASE_NAME}-a365-${ENV}",
  "webAppName": "app-${BASE_NAME}-a365-${ENV}",
  "agentIdentityDisplayName": "${AGENT_NAME} Identity",
  "agentBlueprintDisplayName": "${AGENT_NAME} Blueprint",
  "agentUserPrincipalName": "${AGENT_UPN_PREFIX}@${TENANT_DOMAIN}",
  "agentUserDisplayName": "${AGENT_NAME}",
  "managerEmail": "${MANAGER_EMAIL}",
  "agentUserUsageLocation": "US",
  "deploymentProjectPath": "$(pwd)/agent-warden-a365",
  "agentDescription": "${AGENT_NAME} - AI agent governance platform powered by OpenClaw"
}
EOF
  echo "  ✓ Created ${CONFIG_FILE}"
else
  echo "  ✓ ${CONFIG_FILE} already exists"
fi

# ── Step 2: Run a365 setup all ──
if [[ "$SKIP_SETUP" == "false" ]]; then
  echo ""
  echo "▸ Running 'a365 setup all'..."
  echo "  This creates: Agent Blueprint, Service Principal, Azure infrastructure"
  echo "  Estimated time: 3-5 minutes"
  echo ""
  a365 setup all
  echo ""
  echo "  ✓ Agent Blueprint setup complete"
else
  echo ""
  echo "▸ Skipping 'a365 setup all' (--skip-setup)"
fi

# ── Step 3: Extract outputs ──
if [[ ! -f "$GENERATED_FILE" ]]; then
  echo "ERROR: ${GENERATED_FILE} not found. Run without --skip-setup first."
  exit 1
fi

echo ""
echo "▸ Extracting identity outputs from ${GENERATED_FILE}..."

AGENT_BLUEPRINT_ID=$(python3 -c "import json; d=json.load(open('${GENERATED_FILE}')); print(d.get('agentBlueprintId', ''))")
AGENT_BLUEPRINT_SECRET=$(python3 -c "import json; d=json.load(open('${GENERATED_FILE}')); print(d.get('agentBlueprintClientSecret', ''))")
BOT_ID=$(python3 -c "import json; d=json.load(open('${GENERATED_FILE}')); print(d.get('botId', ''))")
MANAGED_ID=$(python3 -c "import json; d=json.load(open('${GENERATED_FILE}')); print(d.get('managedIdentityPrincipalId', ''))")

echo "  Agent Blueprint ID:  ${AGENT_BLUEPRINT_ID}"
echo "  Bot ID:              ${BOT_ID}"
echo "  Managed Identity:    ${MANAGED_ID}"
echo "  Client Secret:       ${AGENT_BLUEPRINT_SECRET:0:8}..."

# ── Step 4: Store secrets in Key Vault ──
echo ""
echo "▸ Storing credentials in Key Vault '${KEY_VAULT_NAME}'..."

# Temporarily enable public access for secret management
az keyvault update --name "$KEY_VAULT_NAME" --public-network-access Enabled --output none 2>/dev/null || true
sleep 3

az keyvault secret set \
  --vault-name "$KEY_VAULT_NAME" \
  --name "a365-client-id" \
  --value "$AGENT_BLUEPRINT_ID" \
  --output none

az keyvault secret set \
  --vault-name "$KEY_VAULT_NAME" \
  --name "a365-client-secret" \
  --value "$AGENT_BLUEPRINT_SECRET" \
  --output none

# Re-disable public access
az keyvault update --name "$KEY_VAULT_NAME" --public-network-access Disabled --output none 2>/dev/null || true

echo "  ✓ Stored a365-client-id and a365-client-secret"

# ── Step 5: Query agentic user (created after agent instance activation) ──
# Note: The agentic user is created when an admin activates the blueprint
# in M365 Admin Center. Until then, these values may be empty.
echo ""
echo "▸ Looking up agentic user..."
AGENTIC_USER_UPN="${AGENT_UPN_PREFIX}@${TENANT_DOMAIN}"
AGENTIC_USER_ID=$(az ad user show --id "$AGENTIC_USER_UPN" --query id -o tsv 2>/dev/null || echo "")

if [[ -n "$AGENTIC_USER_ID" ]]; then
  echo "  ✓ Agentic User ID:  ${AGENTIC_USER_ID}"
  echo "  ✓ Agentic User UPN: ${AGENTIC_USER_UPN}"
else
  echo "  ⚠ Agentic user not found yet."
  echo "    The agentic user is created after an admin activates the blueprint"
  echo "    in M365 Admin Center: https://admin.cloud.microsoft/#/agents/all"
  echo "    Re-run this script with --skip-setup after activation."
fi

# ── Summary ──
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Setup Complete — Helm Values for a365Plugin:               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "a365Plugin:"
echo "  enabled: true"
echo "  agentId: \"${BOT_ID}\""
echo "  agentName: \"${AGENT_NAME}\""
echo "  agentBlueprintId: \"${AGENT_BLUEPRINT_ID}\""
echo "  agentUpn: \"${AGENTIC_USER_UPN}\""
echo "  agenticUserId: \"${AGENTIC_USER_ID:-pending-activation}\""
echo "  channelName: \"telegram\""
echo "  enableA365Exporter: true"
echo "  serviceName: \"openclaw-gateway\""
echo "  serviceNamespace: \"agent-warden\""
echo ""
echo "Next steps:"
echo "  1. Activate the blueprint in M365 Admin Center:"
echo "     https://admin.cloud.microsoft/#/agents/all"
echo "  2. Assign M365 E5 license to the agentic user"
echo "  3. Update Helm values and redeploy:"
echo "     helm upgrade openclaw-demo-tenant ./k8s/helm/openclaw-tenant -n tenant-demo-tenant -f values-override.yaml"
echo "  4. Verify spans in console logs:"
echo "     kubectl logs -n tenant-demo-tenant openclaw-demo-tenant-0 -c openclaw-gateway | grep a365"
echo "  5. Verify in M365 Admin Center:"
echo "     https://admin.cloud.microsoft/#/agents/all → Select agent → Activity"
