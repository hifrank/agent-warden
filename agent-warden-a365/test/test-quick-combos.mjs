// Quick test: try AA instance ID as agentId in URL
const CONFIG = {
  tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
  blueprintClientAppId: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  blueprintClientSecret: process.env.A365_CLIENT_SECRET,
  aaInstanceId: "760d5a66-7a2d-4c58-b8f9-b89627429aeb",
  agentUpn: "a365072dfe@aprforazure.onmicrosoft.com",
};

async function run() {
  const ep = `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`;
  const h = {"Content-Type": "application/x-www-form-urlencoded"};

  // T1
  const t1 = await (await fetch(ep, { method: "POST", headers: h, body: new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: CONFIG.blueprintClientSecret,
    fmi_path: CONFIG.aaInstanceId,
  }).toString() })).json();

  // T2
  const t2 = await (await fetch(ep, { method: "POST", headers: h, body: new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
  }).toString() })).json();

  // FIC
  const fic = await (await fetch(ep, { method: "POST", headers: h, body: new URLSearchParams({
    scope: "https://api.powerplatform.com/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "user_fic",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
    username: CONFIG.agentUpn,
    user_federated_identity_credential: t2.access_token,
  }).toString() })).json();

  const token = fic.access_token;
  const now = Date.now();
  const payload = JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
      scopeSpans: [{
        scope: { name: "test" },
        spans: [{
          traceId: "00000000000000001234567890abcdef",
          spanId: "1234567890abcdef",
          name: "invoke_agent test",
          kind: "SPAN_KIND_CLIENT",
          startTimeUnixNano: String(now * 1e6),
          endTimeUnixNano: String((now + 1000) * 1e6),
          status: { code: "STATUS_CODE_UNSET" },
          attributes: [
            { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
            { key: "gen_ai.system", value: { stringValue: "az.ai.agent365" } },
            { key: "tenant.id", value: { stringValue: CONFIG.tenantId } },
            { key: "gen_ai.agent.name", value: { stringValue: "test" } },
            { key: "gen_ai.agent.upn", value: { stringValue: CONFIG.agentUpn } },
            { key: "gen_ai.agent.user.id", value: { stringValue: "a55f13fb-b27d-4421-832e-2f441bc6c9a0" } },
            { key: "operation.source", value: { stringValue: "SDK" } },
          ],
        }],
      }],
    }],
  });

  // Test 1: Blueprint ID in URL
  const url1 = `https://agent365.svc.cloud.microsoft/observability/tenants/${CONFIG.tenantId}/agents/${CONFIG.blueprintClientAppId}/traces?api-version=1`;
  const r1 = await fetch(url1, { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${token}` }, body: payload });
  console.log(`Blueprint ID in URL: ${r1.status} ${r1.statusText}`);

  // Test 2: AA instance ID in URL
  const url2 = `https://agent365.svc.cloud.microsoft/observability/tenants/${CONFIG.tenantId}/agents/${CONFIG.aaInstanceId}/traces?api-version=1`;
  const r2 = await fetch(url2, { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${token}` }, body: payload });
  console.log(`AA Instance in URL:  ${r2.status} ${r2.statusText}`);

  // Test 3: S2S endpoint with blueprint
  const url3 = `https://agent365.svc.cloud.microsoft/observabilityService/tenants/${CONFIG.tenantId}/agents/${CONFIG.blueprintClientAppId}/traces?api-version=1`;
  const r3 = await fetch(url3, { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${token}` }, body: payload });
  console.log(`S2S + Blueprint:     ${r3.status} ${r3.statusText}`);

  // Test 4: S2S endpoint with AA instance
  const url4 = `https://agent365.svc.cloud.microsoft/observabilityService/tenants/${CONFIG.tenantId}/agents/${CONFIG.aaInstanceId}/traces?api-version=1`;
  const r4 = await fetch(url4, { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${token}` }, body: payload });
  console.log(`S2S + AA Instance:   ${r4.status} ${r4.statusText}`);
}

run().catch(console.error);
