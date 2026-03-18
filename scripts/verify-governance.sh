#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Verify Purview Data Governance (Tier 1) setup
#
# Checks:
#   1.  Collection hierarchy integrity
#   2.  Tenant collection exists
#   3.  Data source registration
#   4.  Cosmos DB data source details
#   5.  Catalog search API
#   6.  Catalog search with collection filter
#   7.  System scan rule sets
#   8.  Collection CRUD round-trip
#   9.  Platform MI has required Purview roles
#  10.  Purview account health
#
# Usage: ./scripts/verify-governance.sh [environment]
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV="${1:-dev}"
BASE_NAME="agentwarden"
PURVIEW_NAME="pview-${BASE_NAME}-${ENV}"
BASE_URL="https://${PURVIEW_NAME}.purview.azure.com"
PLATFORM_MI_NAME="mi-platform-${BASE_NAME}-${ENV}"
RG_NAME="rg-${BASE_NAME}-${ENV}"
COL_API="2019-11-01-preview"
SCAN_API="2022-07-01-preview"
CATALOG_API="2022-08-01-preview"
POLICY_API="2021-07-01-preview"

PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Purview Data Governance — Tier 1 Verification"
echo "  Purview: ${PURVIEW_NAME}"
echo "  Endpoint: ${BASE_URL}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Acquire token
echo ""
echo "Acquiring Purview token..."
TOKEN=$(az account get-access-token --resource "https://purview.azure.net" --query accessToken -o tsv)
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: Failed to acquire Purview token"
  exit 1
fi
echo "Token acquired (${#TOKEN} chars)"

# Get Platform MI principal ID
MI_PID=$(az identity show -n "$PLATFORM_MI_NAME" -g "$RG_NAME" --query principalId -o tsv 2>/dev/null || echo "")

api() {
  local method=$1 url=$2
  shift 2
  curl -s -w "\n%{http_code}" -X "$method" "$url" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" "$@"
}

# ── 1. Collection Hierarchy ──────────────────────────────────────────
echo ""
echo "▸ 1. Collection Hierarchy"
RESP=$(api GET "${BASE_URL}/collections?api-version=${COL_API}")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$CODE" == "200" ]]; then
  # Check full chain: tenant-demo-tenant -> agent-warden-platform -> root
  PARENT_OF_TENANT=$(echo "$BODY" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for c in data.get('value',[]):
    if c['name']=='tenant-demo-tenant':
        print(c.get('parentCollection',{}).get('referenceName',''))
" 2>/dev/null)
  PARENT_OF_PLATFORM=$(echo "$BODY" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for c in data.get('value',[]):
    if c['name']=='agent-warden-platform':
        print(c.get('parentCollection',{}).get('referenceName',''))
" 2>/dev/null)

  if [[ "$PARENT_OF_TENANT" == "agent-warden-platform" && "$PARENT_OF_PLATFORM" == "$PURVIEW_NAME" ]]; then
    pass "tenant-demo-tenant → agent-warden-platform → ${PURVIEW_NAME}"
  else
    fail "Hierarchy broken: tenant->$PARENT_OF_TENANT, platform->$PARENT_OF_PLATFORM"
  fi

  # List all collections
  echo "$BODY" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for c in data.get('value',[]):
    p=c.get('parentCollection',{}).get('referenceName','ROOT')
    print(f'    {c[\"name\"]:30s} → {p}')
" 2>/dev/null
else
  fail "Collections API returned HTTP $CODE"
fi

# ── 2. Tenant Collection ─────────────────────────────────────────────
echo ""
echo "▸ 2. Tenant Collection Details"
RESP=$(api GET "${BASE_URL}/collections/tenant-demo-tenant?api-version=${COL_API}")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$CODE" == "200" ]]; then
  NAME=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('name',''))" 2>/dev/null)
  if [[ "$NAME" == "tenant-demo-tenant" ]]; then
    pass "Collection exists: tenant-demo-tenant"
  else
    fail "Unexpected collection name: $NAME"
  fi
else
  fail "Get collection returned HTTP $CODE"
fi

# ── 3. Data Sources ──────────────────────────────────────────────────
echo ""
echo "▸ 3. Data Sources"
RESP=$(api GET "${BASE_URL}/scan/datasources?api-version=${SCAN_API}")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$CODE" == "200" ]]; then
  COUNT=$(echo "$BODY" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('value',[])))" 2>/dev/null)
  if [[ "$COUNT" -gt 0 ]]; then
    pass "${COUNT} data source(s) registered"
    echo "$BODY" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for s in data.get('value',[]):
    c=s['properties']['collection']['referenceName']
    print(f'    {s[\"name\"]:30s} | {s[\"kind\"]:20s} | collection: {c}')
" 2>/dev/null
  else
    fail "No data sources registered"
  fi
else
  fail "Data sources API returned HTTP $CODE"
fi

# ── 4. Cosmos DB Data Source ─────────────────────────────────────────
echo ""
echo "▸ 4. Cosmos DB Data Source"
RESP=$(api GET "${BASE_URL}/scan/datasources/cosmos-agentwarden-dev?api-version=${SCAN_API}")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$CODE" == "200" ]]; then
  KIND=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('kind',''))" 2>/dev/null)
  ACCT=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('properties',{}).get('accountUri',''))" 2>/dev/null)
  if [[ "$KIND" == "AzureCosmosDb" ]]; then
    pass "Cosmos DB source: kind=$KIND, uri=$ACCT"
  else
    fail "Unexpected kind: $KIND"
  fi
else
  fail "Get data source returned HTTP $CODE"
fi

# ── 5. Catalog Search ────────────────────────────────────────────────
echo ""
echo "▸ 5. Catalog Search (wildcard)"
RESP=$(api POST "${BASE_URL}/catalog/api/search/query?api-version=${CATALOG_API}" -d '{"keywords":"*","limit":10}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$CODE" == "200" ]]; then
  COUNT=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('@search.count',0))" 2>/dev/null)
  pass "Catalog search OK — ${COUNT} asset(s) indexed"
else
  fail "Catalog search returned HTTP $CODE"
fi

# ── 6. Catalog Search by Collection ──────────────────────────────────
echo ""
echo "▸ 6. Catalog Search (collection filter)"
RESP=$(api POST "${BASE_URL}/catalog/api/search/query?api-version=${CATALOG_API}" \
  -d '{"keywords":"*","filter":{"collectionId":"tenant-demo-tenant"},"limit":10}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$CODE" == "200" ]]; then
  COUNT=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('@search.count',0))" 2>/dev/null)
  pass "Collection-scoped search OK — ${COUNT} asset(s)"
else
  fail "Collection search returned HTTP $CODE"
fi

# ── 7. Scan Rule Sets ────────────────────────────────────────────────
echo ""
echo "▸ 7. System Scan Rule Sets"
RESP=$(api GET "${BASE_URL}/scan/systemScanRulesets?api-version=${SCAN_API}")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$CODE" == "200" ]]; then
  COSMOS_COUNT=$(echo "$BODY" | python3 -c "
import sys,json
data=json.load(sys.stdin)
print(len([r for r in data.get('value',[]) if 'cosmos' in r['name'].lower()]))
" 2>/dev/null)
  if [[ "$COSMOS_COUNT" -gt 0 ]]; then
    pass "${COSMOS_COUNT} Cosmos scan ruleset(s) available"
  else
    fail "No Cosmos scan rulesets found"
  fi
else
  fail "Scan rulesets returned HTTP $CODE"
fi

# ── 8. Collection CRUD ───────────────────────────────────────────────
echo ""
echo "▸ 8. Collection CRUD Round-Trip"
RESP=$(api PUT "${BASE_URL}/collections/test-verify-crud?api-version=${COL_API}" \
  -d '{"parentCollection":{"referenceName":"agent-warden-platform"},"friendlyName":"Verify CRUD"}')
CODE=$(echo "$RESP" | tail -1)

if [[ "$CODE" == "200" ]]; then
  RESP2=$(api DELETE "${BASE_URL}/collections/test-verify-crud?api-version=${COL_API}")
  CODE2=$(echo "$RESP2" | tail -1)
  if [[ "$CODE2" == "204" || "$CODE2" == "200" ]]; then
    pass "Create (200) + Delete ($CODE2) round-trip"
  else
    fail "Create OK but Delete returned HTTP $CODE2"
  fi
else
  fail "Create collection returned HTTP $CODE"
fi

# ── 9. Platform MI Roles ─────────────────────────────────────────────
echo ""
echo "▸ 9. Platform MI Purview Roles"
if [[ -n "$MI_PID" ]]; then
  RESP=$(api GET "${BASE_URL}/policyStore/metadataPolicies?api-version=${POLICY_API}&collectionName=${PURVIEW_NAME}")
  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [[ "$CODE" == "200" ]]; then
    ROLES=$(echo "$BODY" | python3 -c "
import sys,json
mi='$MI_PID'
data=json.load(sys.stdin)
roles=[]
for p in data.get('values',[]):
    for rule in p.get('properties',{}).get('attributeRules',[]):
        for cond in rule.get('dnfCondition',[]):
            for part in cond:
                if part.get('attributeName')=='principal.microsoft.id':
                    if mi in part.get('attributeValueIncludedIn',[]):
                        rid=rule['id']
                        if '_builtin_' in rid:
                            rid=rid.split('_builtin_')[1].split(':')[0]
                        roles.append(rid)
print(','.join(sorted(set(roles))))
" 2>/dev/null)

    EXPECTED="collection-administrator,data-curator,data-source-administrator"
    if [[ "$ROLES" == "$EXPECTED" ]]; then
      pass "MI $MI_PID has: $ROLES"
    else
      fail "MI roles: $ROLES (expected: $EXPECTED)"
    fi
  else
    fail "Policy API returned HTTP $CODE"
  fi
else
  fail "Could not resolve Platform MI principal ID"
fi

# ── 10. Purview Account Health ────────────────────────────────────────
echo ""
echo "▸ 10. Purview Account Health"
PVIEW_STATE=$(az purview account show -n "$PURVIEW_NAME" -g "$RG_NAME" --query provisioningState -o tsv 2>/dev/null || echo "unknown")
if [[ "$PVIEW_STATE" == "Succeeded" ]]; then
  pass "Purview account provisioningState: Succeeded"
else
  fail "Purview account state: $PVIEW_STATE"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RESULTS: ${PASS} passed, ${FAIL} failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

exit "$FAIL"
