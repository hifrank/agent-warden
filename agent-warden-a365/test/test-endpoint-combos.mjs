/**
 * Test endpoint combinations: Blueprint vs AA instance × /observability/ vs /observabilityService/
 * Usage: A365_CLIENT_SECRET="Ciw..." node test/test-endpoint-combos.mjs
 */

const CONFIG = {
  tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
  blueprintClientAppId: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  blueprintClientSecret: process.env.A365_CLIENT_SECRET,
  aaInstanceId: "760d5a66-7a2d-4c58-b8f9-b89627429aeb",
};

if (!CONFIG.blueprintClientSecret) { console.error("Set A365_CLIENT_SECRET"); process.exit(1); }

const tokenEndpoint = `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`;

async function postForm(params) {
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return r.json();
}

async function getFicToken() {
  const t1 = await postForm({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: CONFIG.blueprintClientSecret,
    fmi_path: CONFIG.aaInstanceId,
  });
  if (t1.error) throw new Error(`T1: ${t1.error_description}`);

  const t2 = await postForm({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
  });
  if (t2.error) throw new Error(`T2: ${t2.error_description}`);

  const fic = await postForm({
    scope: "https://api.powerplatform.com/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "user_fic",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
    username: "a365072dfe@aprforazure.onmicrosoft.com",
    user_federated_identity_credential: t2.access_token,
  });
  if (fic.error) throw new Error(`FIC: ${fic.error_description}`);
  return fic.access_token;
}

function makePayload(agentId) {
  return JSON.stringify({
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "tenant.id", value: { stringValue: CONFIG.tenantId } },
          { key: "gen_ai.agent.id", value: { stringValue: agentId } },
        ],
      },
      scopeSpans: [{
        scope: { name: "test" },
        spans: [{
          traceId: "abcd1234abcd1234abcd1234abcd1234",
          spanId: "abcd1234abcd1234",
          name: "test_span",
          kind: 1,
          startTimeUnixNano: "1712100000000000000",
          endTimeUnixNano: "1712100001000000000",
          attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } }],
          status: { code: 1 },
        }],
      }],
    }],
  });
}

async function testEndpoint(label, url, token, agentId) {
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: makePayload(agentId),
  });
  const body = await r.text();
  console.log(`${label}: ${r.status} ${r.statusText}${body ? " — " + body.substring(0, 200) : ""}`);
}

async function main() {
  console.log("Acquiring FIC token...");
  const token = await getFicToken();
  console.log("Token acquired.\n");

  const base = "https://agent365.svc.cloud.microsoft";
  const tid = CONFIG.tenantId;
  const bp = CONFIG.blueprintClientAppId;
  const aa = CONFIG.aaInstanceId;

  await testEndpoint("Blueprint + /observability/     ", `${base}/observability/tenants/${tid}/agents/${bp}/traces?api-version=1`, token, bp);
  await testEndpoint("AA inst  + /observability/      ", `${base}/observability/tenants/${tid}/agents/${aa}/traces?api-version=1`, token, aa);
  await testEndpoint("Blueprint + /observabilitySvc/  ", `${base}/observabilityService/tenants/${tid}/agents/${bp}/traces?api-version=1`, token, bp);
  await testEndpoint("AA inst  + /observabilitySvc/   ", `${base}/observabilityService/tenants/${tid}/agents/${aa}/traces?api-version=1`, token, aa);
}

main().catch(e => console.error(e));
