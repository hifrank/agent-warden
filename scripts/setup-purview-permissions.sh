#!/usr/bin/env bash
# Setup Purview DLP permissions:
# 1. Check current app permissions
# 2. Add InformationProtection.Policy.Read.All if missing
# 3. Create/verify DLP policy targeting the app
set -euo pipefail

E5_TENANT="${PURVIEW_DLP_TENANT_ID:?Set PURVIEW_DLP_TENANT_ID}"
CLIENT_ID="${PURVIEW_DLP_CLIENT_ID:?Set PURVIEW_DLP_CLIENT_ID}"
USER_ID="${PURVIEW_DLP_USER_ID:?Set PURVIEW_DLP_USER_ID}"

# Get secret from pod
echo "=== Step 0: Getting client secret from pod ==="
CLIENT_SECRET=$(kubectl exec -n tenant-demo-tenant openclaw-demo-tenant-0 -c openclaw-gateway -- printenv PURVIEW_DLP_CLIENT_SECRET 2>/dev/null)
echo "Client secret: ${#CLIENT_SECRET} chars"

# Get token
echo ""
echo "=== Step 1: Acquiring token ==="
TOKEN_RESP=$(curl -s -X POST "https://login.microsoftonline.com/$E5_TENANT/oauth2/v2.0/token" \
  -d "client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&grant_type=client_credentials")

TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('access_token',''))")
if [[ -z "$TOKEN" ]]; then
  echo "FAIL: Could not acquire token"
  echo "$TOKEN_RESP" | python3 -m json.tool 2>/dev/null || echo "$TOKEN_RESP"
  exit 1
fi
echo "Token acquired (${#TOKEN} chars)"

# Get service principal ID
echo ""
echo "=== Step 2: Looking up Service Principal ==="
SP_RESP=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/servicePrincipals?\$filter=appId%20eq%20'${CLIENT_ID}'&\$select=id,displayName,appId")
SP_ID=$(echo "$SP_RESP" | python3 -c "import sys,json; v=json.load(sys.stdin).get('value',[]); print(v[0]['id'] if v else '')")
SP_NAME=$(echo "$SP_RESP" | python3 -c "import sys,json; v=json.load(sys.stdin).get('value',[]); print(v[0].get('displayName','?') if v else '')")

if [[ -z "$SP_ID" ]]; then
  echo "FAIL: Could not find service principal for app $CLIENT_ID"
  echo "$SP_RESP" | python3 -m json.tool 2>/dev/null || echo "$SP_RESP"
  exit 1
fi
echo "Service Principal: $SP_NAME ($SP_ID)"

# Get current app role assignments
echo ""
echo "=== Step 3: Current App Role Assignments ==="
ROLES_RESP=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignments")
echo "$ROLES_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
roles = data.get('value', [])
if not roles:
    print('  (none)')
for a in roles:
    print(f\"  {a.get('resourceDisplayName','?')} | roleId={a.get('appRoleId','?')}\")
" 2>/dev/null || echo "$ROLES_RESP"

# Look up Microsoft Graph service principal to find the correct appRoleId
echo ""
echo "=== Step 4: Looking up InformationProtectionPolicy.Read.All role ID ==="
GRAPH_SP_RESP=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/servicePrincipals?\$filter=appId%20eq%20'00000003-0000-0000-c000-000000000000'&\$select=id,appRoles")
ROLE_INFO=$(echo "$GRAPH_SP_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
sps = data.get('value', [])
if not sps:
    print('FAIL: Could not find Microsoft Graph SP')
    sys.exit(1)
graph_sp_id = sps[0]['id']
roles = sps[0].get('appRoles', [])
# Look for InformationProtectionPolicy.Read.All
target_roles = [
    'InformationProtectionPolicy.Read.All',
]
print(f'Graph SP ID: {graph_sp_id}')
for r in roles:
    if r.get('value') in target_roles:
        print(f\"  Found: {r['value']} = {r['id']}\")
# Also search broader InformationProtection roles
for r in roles:
    if 'InformationProtection' in r.get('value', '') or 'Purview' in r.get('value', '') or 'DataSecurity' in r.get('value', ''):
        print(f\"  Related: {r['value']} = {r['id']}\")
")
echo "$ROLE_INFO"

echo ""
echo "=== Step 5: Check delegated permissions (oauth2PermissionGrants) ==="
OAUTH_RESP=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/oauth2PermissionGrants")
echo "$OAUTH_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
grants = data.get('value', [])
if not grants:
    print('  (none)')
for g in grants:
    print(f\"  scope='{g.get('scope','')}' consentType={g.get('consentType','')} resourceId={g.get('resourceId','')}\")
" 2>/dev/null || echo "$OAUTH_RESP"

echo ""
echo "=== Done ==="
echo ""
echo "To grant InformationProtectionPolicy.Read.All, you need to use Azure Portal > Entra ID > App registrations > $CLIENT_ID > API permissions,"
echo "OR use the Graph API to POST to /servicePrincipals/$SP_ID/appRoleAssignments."
echo ""
echo "The app needs these permissions for full DLP functionality:"
echo "  1. InformationProtectionPolicy.Read.All — for protectionScopes/compute"
echo "  2. The existing permissions for processContent and contentActivities"
