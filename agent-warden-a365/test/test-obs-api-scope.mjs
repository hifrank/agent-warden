/**
 * Test: FIC token with Observability API scope (Maven.ReadWrite.All) instead of PowerPlatform scope
 * Usage: A365_CLIENT_SECRET="Ciw..." node test/test-obs-api-scope.mjs
 */
const CONFIG = {
  tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
  bp: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  sec: process.env.A365_CLIENT_SECRET,
  aa: "760d5a66-7a2d-4c58-b8f9-b89627429aeb",
  upn: "a365072dfe@aprforazure.onmicrosoft.com",
};

if (!CONFIG.sec) { console.error("Set A365_CLIENT_SECRET"); process.exit(1); }

const ep = `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`;

async function pf(params) {
  const r = await fetch(ep, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return r.json();
}

function makePayload() {
  const now = Date.now();
  return JSON.stringify({
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "tenant.id", value: { stringValue: CONFIG.tenantId } },
          { key: "gen_ai.agent.id", value: { stringValue: CONFIG.bp } },
        ],
      },
      scopeSpans: [{
        scope: { name: "test" },
        spans: [{
          traceId: "abcd1234abcd1234abcd1234abcd1234",
          spanId: "abcd1234abcd1234",
          name: "invoke_agent Test Agent",
          kind: 1,
          startTimeUnixNano: "" + now * 1e6,
          endTimeUnixNano: "" + (now + 1000) * 1e6,
          attributes: [
            { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
            { key: "gen_ai.system", value: { stringValue: "az.ai.agent365" } },
            { key: "gen_ai.agent.id", value: { stringValue: CONFIG.bp } },
            { key: "gen_ai.agent.name", value: { stringValue: "Agent Warden" } },
            { key: "gen_ai.agent.upn", value: { stringValue: CONFIG.upn } },
            { key: "gen_ai.agent.user.id", value: { stringValue: "a55f13fb-b27d-4421-832e-2f441bc6c9a0" } },
            { key: "gen_ai.agent.applicationid", value: { stringValue: CONFIG.bp } },
            { key: "tenant.id", value: { stringValue: CONFIG.tenantId } },
            { key: "operation.source", value: { stringValue: "SDK" } },
          ],
          status: { code: 1 },
        }],
      }],
    }],
  });
}

async function testExport(label, token) {
  const url = `https://agent365.svc.cloud.microsoft/observability/tenants/${CONFIG.tenantId}/agents/${CONFIG.bp}/traces?api-version=1`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-ms-tenant-id": CONFIG.tenantId,
    },
    body: makePayload(),
  });
  const body = await r.text();
  console.log(`${label}: ${r.status} ${r.statusText}${body ? " — " + body.substring(0, 300) : ""}`);
}

async function main() {
  // T1
  const t1 = await pf({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.bp,
    grant_type: "client_credentials",
    client_secret: CONFIG.sec,
    fmi_path: CONFIG.aa,
  });
  if (t1.error) { console.error("T1:", t1.error_description); return; }
  console.log("T1 OK");

  // T2
  const t2 = await pf({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.aa,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
  });
  if (t2.error) { console.error("T2:", t2.error_description); return; }
  console.log("T2 OK");

  // FIC with Power Platform scope (current approach)
  const ficPP = await pf({
    scope: "https://api.powerplatform.com/.default",
    client_id: CONFIG.aa,
    grant_type: "user_fic",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
    username: CONFIG.upn,
    user_federated_identity_credential: t2.access_token,
  });
  if (ficPP.error) { console.error("FIC(PP):", ficPP.error_description); }
  else {
    const c = JSON.parse(Buffer.from(ficPP.access_token.split(".")[1], "base64url"));
    console.log(`FIC(PP): aud=${c.aud}, scp=${c.scp}`);
    await testExport("PP token → /observability/", ficPP.access_token);
  }

  // FIC with Observability API scope
  const ficObs = await pf({
    scope: "api://9b975845-388f-4429-889e-eab1ef63949c/.default",
    client_id: CONFIG.aa,
    grant_type: "user_fic",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
    username: CONFIG.upn,
    user_federated_identity_credential: t2.access_token,
  });
  if (ficObs.error) { console.error("FIC(Obs):", ficObs.error_description); }
  else {
    const c = JSON.parse(Buffer.from(ficObs.access_token.split(".")[1], "base64url"));
    console.log(`FIC(Obs): aud=${c.aud}, scp=${c.scp}`);
    await testExport("Obs token → /observability/", ficObs.access_token);
    // Also try the S2S path
    const url2 = `https://agent365.svc.cloud.microsoft/observabilityService/tenants/${CONFIG.tenantId}/agents/${CONFIG.bp}/traces?api-version=1`;
    const r2 = await fetch(url2, {
      method: "POST",
      headers: { Authorization: `Bearer ${ficObs.access_token}`, "Content-Type": "application/json", "x-ms-tenant-id": CONFIG.tenantId },
      body: makePayload(),
    });
    console.log(`Obs token → /observabilitySvc/: ${r2.status} ${r2.statusText}`);
  }
}

main().catch(e => console.error(e));
