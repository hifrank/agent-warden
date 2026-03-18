#!/usr/bin/env bash
# E2E test: call Purview processContent API via cross-tenant credentials
set -euo pipefail

E5_TENANT="8cbe524f-4297-47b4-ad3a-d04b4c850249"
CLIENT_ID="d94c93dd-3c80-4f3d-9671-8b71a7dccafa"
USER_ID="157c590c-24f0-4e90-af64-fef68dbb8777"

# Get secret from pod
CLIENT_SECRET=$(kubectl exec -n tenant-demo-tenant openclaw-demo-tenant-0 -c openclaw-gateway -- printenv PURVIEW_DLP_CLIENT_SECRET 2>/dev/null)

echo "1. Acquiring token for E5 tenant..."
TOKEN_RESP=$(curl -s -X POST "https://login.microsoftonline.com/$E5_TENANT/oauth2/v2.0/token" \
  -d "client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&grant_type=client_credentials")

TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('access_token',''))")
if [[ -z "$TOKEN" ]]; then
  echo "FAIL: Could not acquire token"
  echo "$TOKEN_RESP" | python3 -m json.tool
  exit 1
fi
echo "   OK — token acquired"

echo "2. Calling processContent API with sensitive data..."
BODY=$(python3 -c "
import json, uuid, datetime
print(json.dumps({
  'contentToProcess': {
    'contentEntries': [{
      '@odata.type': 'microsoft.graph.processConversationMetadata',
      'identifier': str(uuid.uuid4()),
      'content': {
        '@odata.type': 'microsoft.graph.textContent',
        'data': 'My credit card is 4532-0155-1234-5678 and my SSN is 123-45-6789'
      },
      'name': 'E2E DLP test',
      'correlationId': str(uuid.uuid4()),
      'sequenceNumber': 0,
      'isTruncated': False,
      'createdDateTime': datetime.datetime.utcnow().isoformat() + 'Z',
      'modifiedDateTime': datetime.datetime.utcnow().isoformat() + 'Z'
    }],
    'activityMetadata': {'activity': 'uploadText'},
    'deviceMetadata': {
      'deviceType': 'Managed',
      'operatingSystemSpecifications': {
        'operatingSystemPlatform': 'Linux',
        'operatingSystemVersion': 'AKS'
      }
    },
    'protectedAppMetadata': {
      'name': 'Agent Warden',
      'version': '0.1.0',
      'applicationLocation': {
        '@odata.type': '#microsoft.graph.policyLocationApplication',
        'value': 'd94c93dd-3c80-4f3d-9671-8b71a7dccafa'
      }
    },
    'integratedAppMetadata': {
      'name': 'Agent Warden',
      'version': '0.1.0'
    }
  }
}))
")

RESP=$(curl -s -w "\n%{http_code}" -X POST \
  "https://graph.microsoft.com/v1.0/users/$USER_ID/dataSecurityAndGovernance/processContent" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY")

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY_RESP=$(echo "$RESP" | sed '$d')

echo "   HTTP status: $HTTP_CODE"
echo "   Response:"
echo "$BODY_RESP" | python3 -m json.tool 2>/dev/null || echo "$BODY_RESP"

if [[ "$HTTP_CODE" == "200" ]]; then
  echo ""
  echo "✅ processContent API call SUCCEEDED"
else
  echo ""
  echo "❌ processContent API call returned HTTP $HTTP_CODE"
fi
