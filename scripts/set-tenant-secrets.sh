#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Add secrets to a tenant's Key Vault
#
# Usage: ./scripts/set-tenant-secrets.sh <tenant-id>
#
# Prompts interactively for each secret value (not logged or echoed).
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

TENANT_ID="${1:?Usage: $0 <tenant-id>}"
KV_NAME="kv-${TENANT_ID}"
KV_NAME="${KV_NAME:0:24}"

echo "Setting secrets for tenant $TENANT_ID (Key Vault: $KV_NAME)"
echo "Leave blank to skip a secret."
echo ""

# OpenAI API Key
read -rsp "OpenAI API Key: " OPENAI_KEY
echo ""
if [[ -n "$OPENAI_KEY" ]]; then
  az keyvault secret set --vault-name "$KV_NAME" --name "openai-api-key" --value "$OPENAI_KEY" -o none
  echo "  ✓ openai-api-key set"
fi

# Anthropic API Key
read -rsp "Anthropic API Key: " ANTHROPIC_KEY
echo ""
if [[ -n "$ANTHROPIC_KEY" ]]; then
  az keyvault secret set --vault-name "$KV_NAME" --name "anthropic-api-key" --value "$ANTHROPIC_KEY" -o none
  echo "  ✓ anthropic-api-key set"
fi

# Telegram Bot Token
read -rsp "Telegram Bot Token: " TELEGRAM_TOKEN
echo ""
if [[ -n "$TELEGRAM_TOKEN" ]]; then
  az keyvault secret set --vault-name "$KV_NAME" --name "telegram-bot-token" --value "$TELEGRAM_TOKEN" -o none
  echo "  ✓ telegram-bot-token set"
fi

# Discord Bot Token
read -rsp "Discord Bot Token: " DISCORD_TOKEN
echo ""
if [[ -n "$DISCORD_TOKEN" ]]; then
  az keyvault secret set --vault-name "$KV_NAME" --name "discord-bot-token" --value "$DISCORD_TOKEN" -o none
  echo "  ✓ discord-bot-token set"
fi

# Slack Bot Token
read -rsp "Slack Bot Token: " SLACK_TOKEN
echo ""
if [[ -n "$SLACK_TOKEN" ]]; then
  az keyvault secret set --vault-name "$KV_NAME" --name "slack-bot-token" --value "$SLACK_TOKEN" -o none
  echo "  ✓ slack-bot-token set"
fi

# Cross-Tenant Purview DLP Credentials (optional)
echo ""
echo "── Cross-Tenant Purview DLP (optional, press Enter to skip) ──"
read -rsp "Purview DLP Client ID (multi-tenant app): " PURVIEW_CLIENT_ID
echo ""
if [[ -n "$PURVIEW_CLIENT_ID" ]]; then
  az keyvault secret set --vault-name "$KV_NAME" --name "purview-dlp-client-id" --value "$PURVIEW_CLIENT_ID" -o none
  echo "  ✓ purview-dlp-client-id set"
fi

read -rsp "Purview DLP Client Secret: " PURVIEW_SECRET
echo ""
if [[ -n "$PURVIEW_SECRET" ]]; then
  az keyvault secret set --vault-name "$KV_NAME" --name "purview-dlp-client-secret" --value "$PURVIEW_SECRET" -o none
  echo "  ✓ purview-dlp-client-secret set"
fi

echo ""
echo "Done. Restart the pod to pick up new secrets:"
echo "  kubectl rollout restart statefulset openclaw-${TENANT_ID} -n tenant-${TENANT_ID}"
