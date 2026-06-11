#!/bin/bash
# Test A365 observability endpoints with different paths/IDs
# Uses token from A365 tenant login cache

set -e

TENANT="dab94ed2-4cee-4b36-b007-6618f570b4a3"
BLUEPRINT_APP_ID="60e56f90-f29e-4b97-ac94-6b0500106f77"
BLUEPRINT_SP_ID="8f6dca1c-c6d3-46b2-8715-f9cca60e99b4"
BASE="https://agent365.svc.cloud.microsoft"

# Get token - use --tenant to fetch from cache
TOKEN=$(az account get-access-token --resource "https://api.powerplatform.com" --tenant "$TENANT" -o tsv --query accessToken 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not get token. Run: az login --tenant $TENANT --scope https://api.powerplatform.com/.default --use-device-code"
  exit 1
fi
echo "Token acquired ($(echo -n "$TOKEN" | wc -c | tr -d ' ') chars)"

BODY='{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"scope":{"name":"test"},"spans":[]}]}]}'

test_endpoint() {
  local label="$1"
  local url="$2"
  echo -n "  $label: "
  RESP=$(curl -s -w "\n%{http_code}" -X POST "$url" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$BODY" 2>&1)
  HTTP_CODE=$(echo "$RESP" | tail -1)
  BODY_RESP=$(echo "$RESP" | head -n -1)
  echo "HTTP $HTTP_CODE $(echo "$BODY_RESP" | head -c 200)"
}

echo ""
echo "=== Testing endpoints ==="
test_endpoint "default + blueprint app" "$BASE/observability/tenants/$TENANT/agents/$BLUEPRINT_APP_ID/traces?api-version=1"
test_endpoint "S2S + blueprint app"     "$BASE/observabilityService/tenants/$TENANT/agents/$BLUEPRINT_APP_ID/traces?api-version=1"
test_endpoint "default + blueprint SP"  "$BASE/observability/tenants/$TENANT/agents/$BLUEPRINT_SP_ID/traces?api-version=1"
test_endpoint "S2S + blueprint SP"      "$BASE/observabilityService/tenants/$TENANT/agents/$BLUEPRINT_SP_ID/traces?api-version=1"

echo ""
echo "Done"
