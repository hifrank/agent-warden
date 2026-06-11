/**
 * Test: Observability API with app-only (client_credentials) token
 * 
 * Tries multiple audiences/scopes:
 *   1. Blueprint client_credentials → https://api.powerplatform.com/.default
 *   2. Blueprint client_credentials → Observability API appId/.default
 *   3. Blueprint client_credentials → https://agent365.svc.cloud.microsoft/.default
 *
 * Usage:
 *   A365_CLIENT_SECRET="Ciw..." node test/test-obs-app-permission.mjs
 */
const CONFIG = {
  tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
  blueprintClientAppId: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  blueprintClientSecret: process.env.A365_CLIENT_SECRET,
  aaInstanceId: "760d5a66-7a2d-4c58-b8f9-b89627429aeb",
  agentUpn: "a365072dfe@aprforazure.onmicrosoft.com",
  obsApiAppId: "9b975845-388f-4429-889e-eab1ef63949c",
};

const tokenEndpoint = `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`;
const h = { "Content-Type": "application/x-www-form-urlencoded" };

function decodeJwt(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

async function getClientCredentialsToken(clientId, clientSecret, scope, label) {
  const body = new URLSearchParams({
    scope,
    client_id: clientId,
    grant_type: "client_credentials",
    client_secret: clientSecret,
  });
  const resp = await fetch(tokenEndpoint, { method: "POST", headers: h, body: body.toString() });
  const data = await resp.json();
  if (data.error) {
    console.log(`  [${label}] Token FAILED: ${data.error} - ${data.error_description?.slice(0, 200)}`);
    return null;
  }
  const claims = decodeJwt(data.access_token);
  console.log(`  [${label}] Token OK — aud: ${claims.aud}, roles: ${JSON.stringify(claims.roles || [])}, appid: ${claims.appid}`);
  return data.access_token;
}

async function getT1Token() {
  const body = new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: CONFIG.blueprintClientSecret,
    fmi_path: CONFIG.aaInstanceId,
  });
  const resp = await fetch(tokenEndpoint, { method: "POST", headers: h, body: body.toString() });
  const data = await resp.json();
  if (data.error) {
    console.log(`  [T1] Token FAILED: ${data.error}`);
    return null;
  }
  return data.access_token;
}

async function getT1ClientCredentials(scope, label) {
  const t1 = await getT1Token();
  if (!t1) return null;

  // Use T1 as client_assertion for the AA instance to get app-only token
  const body = new URLSearchParams({
    scope,
    client_id: CONFIG.aaInstanceId,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1,
  });
  const resp = await fetch(tokenEndpoint, { method: "POST", headers: h, body: body.toString() });
  const data = await resp.json();
  if (data.error) {
    console.log(`  [${label}] Token FAILED: ${data.error} - ${data.error_description?.slice(0, 200)}`);
    return null;
  }
  const claims = decodeJwt(data.access_token);
  console.log(`  [${label}] Token OK — aud: ${claims.aud}, roles: ${JSON.stringify(claims.roles || [])}, scp: ${claims.scp || "none"}, appid: ${claims.appid || claims.azp}`);
  return data.access_token;
}

async function postTraces(token, agentId, label) {
  if (!token) { console.log(`  [${label}] Skipped — no token\n`); return; }

  const now = Date.now();
  const payload = JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "test-app-perm" } }] },
      scopeSpans: [{
        scope: { name: "test" },
        spans: [{
          traceId: "00000000000000001234567890abcdef",
          spanId: "1234567890abcdef",
          name: "invoke_agent test-app-perm",
          kind: "SPAN_KIND_CLIENT",
          startTimeUnixNano: String(now * 1e6),
          endTimeUnixNano: String((now + 1000) * 1e6),
          status: { code: "STATUS_CODE_UNSET" },
          attributes: [
            { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
            { key: "gen_ai.system", value: { stringValue: "az.ai.agent365" } },
            { key: "tenant.id", value: { stringValue: CONFIG.tenantId } },
            { key: "gen_ai.agent.id", value: { stringValue: agentId } },
            { key: "gen_ai.agent.name", value: { stringValue: "test" } },
            { key: "gen_ai.agent.upn", value: { stringValue: CONFIG.agentUpn } },
            { key: "gen_ai.agent.user.id", value: { stringValue: "a55f13fb-b27d-4421-832e-2f441bc6c9a0" } },
            { key: "operation.source", value: { stringValue: "SDK" } },
          ],
        }],
      }],
    }],
  });

  // Try both endpoint paths
  for (const path of ["observability", "observabilityService"]) {
    const url = `https://agent365.svc.cloud.microsoft/${path}/tenants/${CONFIG.tenantId}/agents/${agentId}/traces?api-version=1`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${token}`, "x-ms-tenant-id": CONFIG.tenantId },
      body: payload,
    });
    const statusText = `${resp.status} ${resp.statusText}`;
    let extra = "";
    if (!resp.ok) {
      const body = await resp.text();
      extra = ` — ${body.slice(0, 150)}`;
    }
    console.log(`  [${label}] POST /${path}/.../${agentId.slice(0,8)}... → ${statusText}${extra}`);
  }
  console.log();
}

async function run() {
  console.log("=== Strategy 1: Blueprint client_credentials → PowerPlatform ===");
  const t1 = await getClientCredentialsToken(
    CONFIG.blueprintClientAppId, CONFIG.blueprintClientSecret,
    "https://api.powerplatform.com/.default", "BP→PP"
  );
  await postTraces(t1, CONFIG.blueprintClientAppId, "BP→PP-blueprint");
  await postTraces(t1, CONFIG.aaInstanceId, "BP→PP-aa");

  console.log("=== Strategy 2: Blueprint client_credentials → Obs API appId ===");
  const t2 = await getClientCredentialsToken(
    CONFIG.blueprintClientAppId, CONFIG.blueprintClientSecret,
    `api://${CONFIG.obsApiAppId}/.default`, "BP→ObsAPI"
  );
  await postTraces(t2, CONFIG.blueprintClientAppId, "BP→ObsAPI-blueprint");

  console.log("=== Strategy 3: Blueprint client_credentials → agent365.svc ===");
  const t3 = await getClientCredentialsToken(
    CONFIG.blueprintClientAppId, CONFIG.blueprintClientSecret,
    "https://agent365.svc.cloud.microsoft/.default", "BP→a365svc"
  );
  await postTraces(t3, CONFIG.blueprintClientAppId, "BP→a365svc");

  console.log("=== Strategy 4: AA instance client_credentials (via T1) → PowerPlatform ===");
  const t4 = await getT1ClientCredentials("https://api.powerplatform.com/.default", "AA→PP");
  await postTraces(t4, CONFIG.aaInstanceId, "AA→PP-aa");
  await postTraces(t4, CONFIG.blueprintClientAppId, "AA→PP-blueprint");

  console.log("=== Strategy 5: AA instance client_credentials (via T1) → Obs API appId ===");
  const t5 = await getT1ClientCredentials(`api://${CONFIG.obsApiAppId}/.default`, "AA→ObsAPI");
  await postTraces(t5, CONFIG.aaInstanceId, "AA→ObsAPI-aa");

  console.log("=== Strategy 6: AA instance client_credentials (via T1) → agent365.svc ===");
  const t6 = await getT1ClientCredentials("https://agent365.svc.cloud.microsoft/.default", "AA→a365svc");
  await postTraces(t6, CONFIG.aaInstanceId, "AA→a365svc-aa");

  // Comparison: FIC token (what we currently use)
  console.log("=== Reference: FIC token → PowerPlatform (current) ===");
  const t1tok = await getT1Token();
  const t2tok = await (await fetch(tokenEndpoint, { method: "POST", headers: h, body: new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1tok,
  }).toString() })).json();
  const fic = await (await fetch(tokenEndpoint, { method: "POST", headers: h, body: new URLSearchParams({
    scope: "https://api.powerplatform.com/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "user_fic",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1tok,
    username: CONFIG.agentUpn,
    user_federated_identity_credential: t2tok.access_token,
  }).toString() })).json();
  if (fic.access_token) {
    const claims = decodeJwt(fic.access_token);
    console.log(`  [FIC→PP] Token OK — aud: ${claims.aud}, scp: ${claims.scp}, upn: ${claims.upn}`);
    await postTraces(fic.access_token, CONFIG.aaInstanceId, "FIC→PP-aa");
  }
}

run().catch(console.error);
