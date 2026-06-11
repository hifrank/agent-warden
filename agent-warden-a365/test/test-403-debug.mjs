/**
 * Debug 403: test multiple token types × endpoint paths
 *
 * Usage: A365_CLIENT_SECRET="Ciw..." node test/test-403-debug.mjs
 */

const CONFIG = {
  tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
  blueprintClientAppId: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  blueprintClientSecret: process.env.A365_CLIENT_SECRET,
  aaInstanceId: "760d5a66-7a2d-4c58-b8f9-b89627429aeb",
  agentUpn: "a365072dfe@aprforazure.onmicrosoft.com",
};

if (!CONFIG.blueprintClientSecret) {
  console.error("Set A365_CLIENT_SECRET");
  process.exit(1);
}

const tokenEndpoint = `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`;

async function postForm(params) {
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return r.json();
}

async function getT1() {
  const d = await postForm({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: CONFIG.blueprintClientSecret,
    fmi_path: CONFIG.aaInstanceId,
  });
  if (d.error) throw new Error(`T1: ${d.error_description}`);
  return d.access_token;
}

async function getT2(t1) {
  const d = await postForm({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1,
  });
  if (d.error) throw new Error(`T2: ${d.error_description}`);
  return d.access_token;
}

async function getFIC(t1, t2, scope) {
  const d = await postForm({
    scope,
    client_id: CONFIG.aaInstanceId,
    grant_type: "user_fic",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1,
    username: CONFIG.agentUpn,
    user_federated_identity_credential: t2,
  });
  if (d.error) return { error: d.error_description?.slice(0, 120) };
  const claims = JSON.parse(Buffer.from(d.access_token.split(".")[1], "base64url").toString());
  return { token: d.access_token, aud: claims.aud, scp: claims.scp, roles: claims.roles };
}

async function getCC(scope) {
  const d = await postForm({
    scope,
    client_id: CONFIG.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: CONFIG.blueprintClientSecret,
  });
  if (d.error) return { error: d.error_description?.slice(0, 120) };
  const claims = JSON.parse(Buffer.from(d.access_token.split(".")[1], "base64url").toString());
  return { token: d.access_token, aud: claims.aud, scp: claims.scp, roles: claims.roles };
}

async function testExport(label, token, path) {
  const url = `https://agent365.svc.cloud.microsoft${path}?api-version=1`;
  const payload = {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
      scopeSpans: [{
        scope: { name: "Agent365Sdk" },
        spans: [{
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          name: "invoke_agent Test",
          kind: "SPAN_KIND_CLIENT",
          startTimeUnixNano: String(Date.now() * 1e6),
          endTimeUnixNano: String((Date.now() + 100) * 1e6),
          status: { code: "STATUS_CODE_UNSET" },
          attributes: [
            { key: "gen_ai.agent.id", value: { stringValue: CONFIG.blueprintClientAppId } },
            { key: "gen_ai.agent.name", value: { stringValue: "Agent Warden" } },
            { key: "gen_ai.agent.applicationid", value: { stringValue: CONFIG.blueprintClientAppId } },
            { key: "gen_ai.agent.upn", value: { stringValue: CONFIG.agentUpn } },
            { key: "gen_ai.agent.user.id", value: { stringValue: "a55f13fb-b27d-4421-832e-2f441bc6c9a0" } },
            { key: "tenant.id", value: { stringValue: CONFIG.tenantId } },
            { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
            { key: "gen_ai.conversation.id", value: { stringValue: "debug-test" } },
            { key: "gen_ai.channel.name", value: { stringValue: "test" } },
            { key: "gen_ai.execution.type", value: { stringValue: "HumanToAgent" } },
            { key: "gen_ai.input.messages", value: { stringValue: '["test"]' } },
            { key: "gen_ai.output.messages", value: { stringValue: '["ok"]' } },
            { key: "gen_ai.caller.id", value: { stringValue: "tester" } },
            { key: "gen_ai.caller.upn", value: { stringValue: "tester@test" } },
            { key: "operation.source", value: { stringValue: "SDK" } },
            { key: "server.address", value: { stringValue: "localhost" } },
            { key: "server.port", value: { intValue: 3978 } },
          ],
        }],
      }],
    }],
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-ms-tenant-id": CONFIG.tenantId,
    },
    body: JSON.stringify(payload),
  });
  const body = await resp.text();
  const corr = resp.headers.get("x-ms-correlation-id") || "?";
  console.log(`  ${label.padEnd(22)} => ${resp.status} ${resp.statusText}  corr=${corr}  body=${body || "(empty)"}`);
  return resp.status;
}

async function main() {
  console.log("=== Acquiring tokens ===\n");
  const t1 = await getT1();
  console.log("T1 OK");
  const t2 = await getT2(t1);
  console.log("T2 OK");

  // Token variant 1: FIC with PowerPlatform scope (current approach)
  const ficPP = await getFIC(t1, t2, "https://api.powerplatform.com/.default");
  console.log("FIC PowerPlatform:", ficPP.error || `aud=${ficPP.aud} scp=${ficPP.scp}`);

  // Token variant 2: FIC with Observability API scope
  const ficObs = await getFIC(t1, t2, "api://9b975845-388f-4429-889e-eab1ef63949c/.default");
  console.log("FIC ObsAPI:", ficObs.error || `aud=${ficObs.aud} scp=${ficObs.scp}`);

  // Token variant 3: Client credentials (app-level) with PowerPlatform
  const ccPP = await getCC("https://api.powerplatform.com/.default");
  console.log("CC PowerPlatform:", ccPP.error || `aud=${ccPP.aud} roles=${ccPP.roles}`);

  // Token variant 4: Client credentials with Observability API
  const ccObs = await getCC("api://9b975845-388f-4429-889e-eab1ef63949c/.default");
  console.log("CC ObsAPI:", ccObs.error || `aud=${ccObs.aud} roles=${ccObs.roles}`);

  const tid = CONFIG.tenantId;
  const aid = CONFIG.blueprintClientAppId;

  // --- Test /observability/ path ---
  console.log("\n=== /observability/ path ===");
  const tokens = [
    ["FIC+PowerPlatform", ficPP],
    ["FIC+ObsAPI", ficObs],
    ["CC+PowerPlatform", ccPP],
    ["CC+ObsAPI", ccObs],
  ];
  for (const [label, t] of tokens) {
    if (t.token) {
      await testExport(label, t.token, `/observability/tenants/${tid}/agents/${aid}/traces`);
    } else {
      console.log(`  ${label.padEnd(22)} => SKIPPED (${t.error?.slice(0, 60)})`);
    }
  }

  // --- Test /observabilityService/ path (S2S) ---
  console.log("\n=== /observabilityService/ path (S2S) ===");
  for (const [label, t] of tokens) {
    if (t.token) {
      await testExport(label, t.token, `/observabilityService/tenants/${tid}/agents/${aid}/traces`);
    } else {
      console.log(`  ${label.padEnd(22)} => SKIPPED`);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
