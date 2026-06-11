/**
 * Quick test: export a single span to A365 with blueprint app ID as agentId.
 *
 * Usage:
 *   A365_BEARER_TOKEN="..." ENABLE_A365_OBSERVABILITY_EXPORTER=true \
 *     A365_OBSERVABILITY_LOG_LEVEL="info|warn|error" \
 *     node test/test-a365-export.mjs
 */

import { ObservabilityManager, InvokeAgentScope } from "@microsoft/agents-a365-observability";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

const builder = ObservabilityManager.configure((b) => {
  b.withService("openclaw-gateway", "0.1.0")
    .withServiceNamespace("agent-warden")
    .withTokenResolver((_agentId, _tenantId) => process.env.A365_BEARER_TOKEN)
    .withCustomLogger({
      info: (msg, ...a) => console.log("[sdk]", msg, ...a),
      warn: (msg, ...a) => console.warn("[sdk]", msg, ...a),
      error: (msg, ...a) => console.error("[sdk]", msg, ...a),
      event: (type, ok, ms, msg, det) =>
        console.log("[sdk-event]", type, ok, ms + "ms", msg || "", det ? JSON.stringify(det) : ""),
    });
});
builder.start();
console.log("SDK started");

// Use blueprint app ID as agentId — this is what appears in the export URL
const agentDetails = {
  agentId: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  agentName: "Agent Warden",
  agentDescription: "AI agent governance platform",
  agentBlueprintId: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
};

const scope = InvokeAgentScope.start(
  { content: "test input", conversationId: "test-conv-1", channel: { name: "test" } },
  {},
  agentDetails,
);
scope.recordInputMessages(["test input"]);
scope.recordResponse("test output");
scope.dispose();
console.log("Span created, waiting 6s for flush...");

setTimeout(async () => {
  await ObservabilityManager.shutdown();
  console.log("=== Done ===");
}, 6000);
