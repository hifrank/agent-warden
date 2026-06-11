/**
 * Local observability test — runs entirely on macOS (no pod/AKS needed).
 *
 * Tests:
 *   1. T1/T2/FIC token acquisition (using blueprint credentials)
 *   2. Raw HTTP POST to A365 export endpoint (to see exact response/headers)
 *   3. Full SDK export flow via ObservabilityManager
 *
 * Usage:
 *   cd agent-warden-a365
 *   A365_CLIENT_SECRET="Ciw..." npx tsx test/test-local.ts
 *
 * Or with pre-acquired bearer token (skip T1/T2/FIC):
 *   A365_BEARER_TOKEN="eyJ..." npx tsx test/test-local.ts
 */

// ── Config (observability-test tenant) ──

const CONFIG = {
  tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
  blueprintClientAppId: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  blueprintClientSecret: process.env.A365_CLIENT_SECRET ?? "",
  aaInstanceId: "760d5a66-7a2d-4c58-b8f9-b89627429aeb",
  agentUpn: "a365072dfe@aprforazure.onmicrosoft.com",
  agenticUserId: "a55f13fb-b27d-4421-832e-2f441bc6c9a0",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Step 1: T1/T2/FIC Token ──

async function acquireToken(): Promise<string> {
  // If pre-set token, use it directly
  if (process.env.A365_BEARER_TOKEN) {
    console.log("\n=== Using pre-set A365_BEARER_TOKEN ===");
    return process.env.A365_BEARER_TOKEN;
  }

  if (!CONFIG.blueprintClientSecret) {
    console.error("ERROR: Set A365_CLIENT_SECRET or A365_BEARER_TOKEN env var");
    process.exit(1);
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`;

  // T1
  console.log("\n=== T1: client_credentials + fmi_path ===");
  const t1Body = new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: CONFIG.blueprintClientSecret,
    fmi_path: CONFIG.aaInstanceId,
  });
  const t1Resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: t1Body.toString(),
  });
  if (!t1Resp.ok) throw new Error(`T1 failed: ${t1Resp.status} ${await t1Resp.text()}`);
  const t1Data = (await t1Resp.json()) as { access_token: string };
  console.log("T1 OK");

  // T2
  console.log("\n=== T2: client_assertion ===");
  const t2Body = new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1Data.access_token,
  });
  const t2Resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: t2Body.toString(),
  });
  if (!t2Resp.ok) throw new Error(`T2 failed: ${t2Resp.status} ${await t2Resp.text()}`);
  const t2Data = (await t2Resp.json()) as { access_token: string };
  console.log("T2 OK");

  // FIC
  console.log("\n=== FIC: user_fic ===");
  const ficBody = new URLSearchParams({
    scope: "https://api.powerplatform.com/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "user_fic",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1Data.access_token,
    username: CONFIG.agentUpn,
    user_federated_identity_credential: t2Data.access_token,
  });
  const ficResp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: ficBody.toString(),
  });
  if (!ficResp.ok) throw new Error(`FIC failed: ${ficResp.status} ${await ficResp.text()}`);
  const ficData = (await ficResp.json()) as { access_token: string };
  console.log("FIC OK");

  // Decode token claims
  const parts = ficData.access_token.split(".");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  console.log("\nToken claims:");
  console.log("  aud:", claims.aud);
  console.log("  sub:", claims.sub);
  console.log("  upn:", claims.upn);
  console.log("  oid:", claims.oid);
  console.log("  scp:", claims.scp);
  console.log("  roles:", claims.roles);
  console.log("  appid:", claims.appid);
  console.log("  tid:", claims.tid);

  return ficData.access_token;
}

// ── Step 2: Raw HTTP POST to export endpoint ──

async function testRawExport(token: string): Promise<void> {
  console.log("\n========================================");
  console.log("=== RAW HTTP EXPORT TEST ===");
  console.log("========================================");

  const agentId = CONFIG.blueprintClientAppId;
  const tenantId = CONFIG.tenantId;
  const url = `https://agent365.svc.cloud.microsoft/observability/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/traces?api-version=1`;
  console.log("URL:", url);

  // Minimal OTLP-like payload matching SDK format
  const traceId = "0000000000000000" + Date.now().toString(16).padStart(16, "0");
  const spanId = Date.now().toString(16).padStart(16, "0");
  const now = Date.now();

  const payload = {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "openclaw-gateway" } },
          { key: "service.namespace", value: { stringValue: "agent-warden" } },
          { key: "service.version", value: { stringValue: "0.2.0" } },
        ],
      },
      scopeSpans: [{
        scope: { name: "Agent365Sdk", version: "0.1.0" },
        spans: [{
          traceId,
          spanId,
          name: "invoke_agent Agent Warden",
          kind: "SPAN_KIND_CLIENT",
          startTimeUnixNano: (now * 1e6).toString(),
          endTimeUnixNano: ((now + 1000) * 1e6).toString(),
          status: { code: "STATUS_CODE_UNSET" },
          attributes: [
            { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
            { key: "gen_ai.system", value: { stringValue: "az.ai.agent365" } },
            { key: "gen_ai.agent.id", value: { stringValue: agentId } },
            { key: "gen_ai.agent.name", value: { stringValue: "Agent Warden" } },
            { key: "gen_ai.agent.description", value: { stringValue: "AI agent governance platform" } },
            { key: "gen_ai.agent.applicationid", value: { stringValue: agentId } },
            { key: "gen_ai.agent.upn", value: { stringValue: CONFIG.agentUpn } },
            { key: "gen_ai.agent.user.id", value: { stringValue: CONFIG.agenticUserId } },
            { key: "tenant.id", value: { stringValue: tenantId } },
            { key: "gen_ai.conversation.id", value: { stringValue: `test-local-${now}` } },
            { key: "gen_ai.channel.name", value: { stringValue: "test" } },
            { key: "gen_ai.execution.type", value: { stringValue: "HumanToAgent" } },
            { key: "gen_ai.input.messages", value: { stringValue: '["test input from local"]' } },
            { key: "gen_ai.output.messages", value: { stringValue: '["test output from local"]' } },
            { key: "gen_ai.caller.id", value: { stringValue: "local-test-user" } },
            { key: "gen_ai.caller.name", value: { stringValue: "Local Tester" } },
            { key: "gen_ai.caller.upn", value: { stringValue: "tester@local" } },
            { key: "operation.source", value: { stringValue: "SDK" } },
            { key: "server.address", value: { stringValue: "localhost" } },
            { key: "server.port", value: { intValue: 3978 } },
          ],
        }],
      }],
    }],
  };

  const body = JSON.stringify(payload);
  console.log("Payload size:", body.length, "bytes");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
      "x-ms-tenant-id": tenantId,
    },
    body,
  });

  console.log("\nResponse status:", resp.status, resp.statusText);
  console.log("Response headers:");
  resp.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));
  const respBody = await resp.text();
  console.log("Response body:", respBody || "(empty)");
}

// ── Step 3: SDK Export ──

async function testSdkExport(token: string): Promise<void> {
  console.log("\n========================================");
  console.log("=== SDK EXPORT TEST ===");
  console.log("========================================");

  process.env.ENABLE_A365_OBSERVABILITY_EXPORTER = "true";

  const { ObservabilityManager, InvokeAgentScope, InferenceScope, ExecuteToolScope } =
    await import("@microsoft/agents-a365-observability");
  const { diag, DiagConsoleLogger, DiagLogLevel } = await import("@opentelemetry/api");

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

  const sdk = ObservabilityManager.configure((b: any) => {
    b.withService("openclaw-gateway", "0.2.0")
      .withServiceNamespace("agent-warden")
      .withTokenResolver((_agentId: string, _tenantId: string) => {
        console.log(`[tokenResolver] called: agentId=${_agentId}, tenantId=${_tenantId}`);
        return token;
      })
      .withCustomLogger({
        info: (msg: string, ...a: any[]) => console.log("[sdk]", msg, ...a),
        warn: (msg: string, ...a: any[]) => console.warn("[sdk]", msg, ...a),
        error: (msg: string, ...a: any[]) => console.error("[sdk]", msg, ...a),
        event: (type: string, ok: boolean, ms: number, msg?: string, det?: any) =>
          console.log("[sdk-event]", type, ok, ms + "ms", msg || "", det ? JSON.stringify(det) : ""),
      });
  });

  sdk.start();
  console.log("SDK started with real token\n");

  const agentDetails = {
    agentId: CONFIG.blueprintClientAppId,
    agentName: "Agent Warden",
    agentDescription: "AI agent governance platform powered by OpenClaw",
    agentBlueprintId: CONFIG.blueprintClientAppId,
    agentAUID: CONFIG.agenticUserId,
    agentEmail: CONFIG.agentUpn,
    tenantId: CONFIG.tenantId,
  };

  // InvokeAgentScope
  const invokeScope = InvokeAgentScope.start(
    {
      content: "Hello from local test",
      conversationId: `local-test-${Date.now()}`,
      sessionId: `session-${Date.now()}`,
      channel: { name: "test" },
    },
    { endpoint: { host: "localhost", port: 3978, protocol: "https" } },
    agentDetails,
    { userDetails: { userId: "local-test-user", userName: "Local Tester", userEmail: "tester@local.test" } },
  );
  invokeScope.recordInputMessages(["Hello from local test"]);

  // InferenceScope
  const inferScope = InferenceScope.start(
    { content: "Hello from local test", conversationId: `local-test-${Date.now()}`, channel: { name: "test" } },
    { operationName: "Chat" as any, model: "gpt-5.4", providerName: "Azure OpenAI" },
    agentDetails,
  );
  inferScope.recordInputMessages(["Hello from local test"]);
  inferScope.recordOutputMessages(["I'm Agent Warden, an AI governance agent."]);
  inferScope.recordInputTokens(15);
  inferScope.recordOutputTokens(25);
  inferScope.recordFinishReasons(["stop"]);
  inferScope.dispose();
  console.log("InferenceScope closed");

  // ExecuteToolScope
  const toolScope = ExecuteToolScope.start(
    { conversationId: `local-test-${Date.now()}`, channel: { name: "test" } },
    { toolName: "check_governance", toolType: "function", toolCallId: `tool-${Date.now()}`, arguments: JSON.stringify({ query: "test" }) },
    agentDetails,
  );
  toolScope.recordResponse(JSON.stringify({ status: "ok", agents: 3 }));
  toolScope.dispose();
  console.log("ExecuteToolScope closed");

  // Close InvokeAgentScope
  invokeScope.recordResponse("I'm Agent Warden, ready to help with governance.");
  invokeScope.dispose();
  console.log("InvokeAgentScope closed");

  // Wait for batch flush (default 5s)
  console.log("\nWaiting 8s for batch export flush...");
  await sleep(8000);

  await ObservabilityManager.shutdown();
  console.log("\n=== SDK test complete ===");
}

// ── Main ──

async function main() {
  console.log("=== Local Observability Test ===");
  console.log("Tenant:", CONFIG.tenantId);
  console.log("Blueprint:", CONFIG.blueprintClientAppId);
  console.log("AA Instance:", CONFIG.aaInstanceId);
  console.log("Agent UPN:", CONFIG.agentUpn);

  const token = await acquireToken();

  // Test 1: Raw HTTP (see actual response details)
  await testRawExport(token);

  // Test 2: SDK-driven export
  await testSdkExport(token);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
