/**
 * Test: Follow the official A365 Observability docs EXACTLY with LangChain auto-instrumentation.
 * Reference: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability?tabs=nodejs
 *
 * Steps from the doc:
 *   1. ObservabilityManager.configure() with builder pattern
 *   2. LangChainTraceInstrumentor.instrument()
 *   3. BaggageBuilder to set agent/tenant context
 *   4. Run a LangChain chain inside the baggage scope
 *
 * Usage:
 *   A365_CLIENT_SECRET="Ciw..." AZURE_OPENAI_API_KEY="..." node test/test-langchain-a365.mjs
 *
 *   Or with console-only (no server export):
 *   ENABLE_A365_OBSERVABILITY_EXPORTER=false A365_CLIENT_SECRET="Ciw..." node test/test-langchain-a365.mjs
 */

// ─── Config ───
const CONFIG = {
  tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
  blueprintClientAppId: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  blueprintClientSecret: process.env.A365_CLIENT_SECRET,
  aaInstanceId: "760d5a66-7a2d-4c58-b8f9-b89627429aeb",
  agentUpn: "a365072dfe@aprforazure.onmicrosoft.com",
  agenticUserId: "a55f13fb-b27d-4421-832e-2f441bc6c9a0",
};

if (!CONFIG.blueprintClientSecret) {
  console.error("ERROR: Set A365_CLIENT_SECRET env var");
  process.exit(1);
}

// ─── T1/T2/FIC Token Acquisition ───
const tokenEndpoint = `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`;

async function postForm(params) {
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return r.json();
}

async function acquireFicToken() {
  console.log("=== Acquiring FIC token (T1 → T2 → FIC) ===");

  // T1: Blueprint client_credentials with fmi_path
  const t1 = await postForm({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: CONFIG.blueprintClientSecret,
    fmi_path: CONFIG.aaInstanceId,
  });
  if (t1.error) throw new Error(`T1 failed: ${t1.error_description}`);
  console.log("  T1 OK");

  // T2: AA instance client_assertion
  const t2 = await postForm({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
  });
  if (t2.error) throw new Error(`T2 failed: ${t2.error_description}`);
  console.log("  T2 OK");

  // FIC: user_fic exchange for PowerPlatform scope
  const fic = await postForm({
    scope: "https://api.powerplatform.com/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "user_fic",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
    username: CONFIG.agentUpn,
    user_federated_identity_credential: t2.access_token,
  });
  if (fic.error) throw new Error(`FIC failed: ${fic.error_description}`);
  console.log("  FIC OK");

  // Decode & show claims
  const claims = JSON.parse(Buffer.from(fic.access_token.split(".")[1], "base64url").toString());
  console.log(`  aud=${claims.aud}, upn=${claims.upn}, scp=${claims.scp}`);

  return fic.access_token;
}

// ─── Main ───
async function main() {
  const token = await acquireFicToken();

  // ─── Step 1: Configure ObservabilityManager (from docs: "Configuration" section) ───
  // Doc says: set ENABLE_A365_OBSERVABILITY_EXPORTER=true for server export, false for console
  if (process.env.ENABLE_A365_OBSERVABILITY_EXPORTER === undefined) {
    process.env.ENABLE_A365_OBSERVABILITY_EXPORTER = "true";
  }
  const exporterEnabled = process.env.ENABLE_A365_OBSERVABILITY_EXPORTER === "true";
  console.log(`\n=== Configuring ObservabilityManager (exporter=${exporterEnabled}) ===`);

  const { ObservabilityManager } = await import("@microsoft/agents-a365-observability");
  const { BaggageBuilder } = await import("@microsoft/agents-a365-observability");

  // Doc says: set ENABLE_A365_OBSERVABILITY_EXPORTER env var. Let's just use that.
  const sdk = ObservabilityManager.configure((builder) =>
    builder
      .withService("agent-warden-langchain-test", "1.0.0")
      .withCustomLogger({
        info: (msg, ...a) => console.log("[a365-info]", msg, ...a),
        warn: (msg, ...a) => console.warn("[a365-warn]", msg, ...a),
        error: (msg, ...a) => console.error("[a365-error]", msg, ...a),
        event: (name, ok, ms, msg, det) =>
          console.log(`[a365-event] ${name} ok=${ok} ${ms}ms`, msg || "", det ? JSON.stringify(det) : ""),
      })
      .withTokenResolver((_agentId, _tenantId) => {
        console.log(`  [tokenResolver] agentId=${_agentId}, tenantId=${_tenantId}`);
        return token;
      })
  );

  // ─── Step 2: Enable LangChain auto-instrumentation (from docs: "LangChain Framework" section) ───
  console.log("\n=== Enabling LangChain auto-instrumentation ===");
  const { LangChainTraceInstrumentor } = await import(
    "@microsoft/agents-a365-observability-extensions-langchain"
  );
  const LangChainCallbacks = await import("@langchain/core/callbacks/manager");

  sdk.start();
  console.log("  ObservabilityManager started");

  LangChainTraceInstrumentor.instrument(LangChainCallbacks);
  console.log("  LangChainTraceInstrumentor enabled");

  // ─── Step 3: Set baggage context (from docs: "Baggage attributes" section) ───
  console.log("\n=== Setting baggage context via BaggageBuilder ===");
  const baggageScope = new BaggageBuilder()
    .tenantId(CONFIG.tenantId)
    .agentId(CONFIG.blueprintClientAppId)
    .agentAuid(CONFIG.agenticUserId)
    .agentEmail(CONFIG.agentUpn)
    .agentBlueprintId(CONFIG.blueprintClientAppId)
    .agentName("Agent Warden")
    .agentDescription("AI agent governance platform")
    .channelName("test")
    .conversationId(`langchain-test-${Date.now()}`)
    .userId("local-tester")
    .userName("Local Test User")
    .userEmail("tester@local.test")
    .callerClientIp("127.0.0.1")
    .invokeAgentServer("localhost", 3978)
    .build();

  console.log("  BaggageScope created");

  // ─── Step 4: Run a LangChain chain inside the baggage scope (from docs) ───
  console.log("\n=== Running LangChain chain inside baggage scope ===");

  await baggageScope.run(async () => {
    // Use a simple fake LLM to avoid needing real Azure OpenAI keys for this test.
    // The point is to verify the A365 exporter captures the LangChain spans.
    const { FakeListChatModel } = await import("@langchain/core/utils/testing");
    const { HumanMessage } = await import("@langchain/core/messages");
    const { StringOutputParser } = await import("@langchain/core/output_parsers");
    const { ChatPromptTemplate } = await import("@langchain/core/prompts");

    const fakeLLM = new FakeListChatModel({
      responses: ["I am Agent Warden, an AI governance platform. I can help monitor and manage your AI agents."],
    });

    // Simple chain: prompt → LLM → parse
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", "You are {agent_name}, an AI governance agent."],
      ["human", "{input}"],
    ]);

    const chain = prompt.pipe(fakeLLM).pipe(new StringOutputParser());

    console.log("  Invoking chain...");
    const result = await chain.invoke({
      agent_name: "Agent Warden",
      input: "What can you do?",
    });
    console.log("  Chain result:", result);
  });

  baggageScope.dispose();
  console.log("  BaggageScope disposed");

  // ─── Step 5: Wait for batch flush & shutdown ───
  console.log("\n=== Waiting 10s for batch export flush ===");
  await new Promise((r) => setTimeout(r, 10000));

  console.log("=== Shutting down ===");
  await ObservabilityManager.shutdown();

  console.log("\n=== DONE ===");
  if (exporterEnabled) {
    console.log("Check https://admin.cloud.microsoft/#/agents/all → select agent → Activity");
  } else {
    console.log("Console-only mode — check span logs above for correctness");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
