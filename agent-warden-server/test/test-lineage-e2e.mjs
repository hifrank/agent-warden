/**
 * E2E test: insert correlated events into Cosmos, run aggregator, verify Purview push.
 * Usage: node --env-file=.env test/test-lineage-e2e.mjs
 */
import { aggregateAndPushLineage } from "../dist/tools/lineage-aggregator.js";
import { getCosmosDb } from "../dist/middleware/cosmos.js";

const cosmosEndpoint = process.env.AZURE_COSMOS_ENDPOINT;
const cosmosDatabase = process.env.AZURE_COSMOS_DATABASE || "agent-warden";
const purviewEndpoint = process.env.AZURE_PURVIEW_GOVERNANCE_ENDPOINT;

async function main() {
  console.log("=== Lineage Aggregator E2E Test ===\n");

  // 1. Insert correlated test events with same traceId
  const traceId = `e2e-lineage-${Date.now()}`;
  const tenantId = "demo-tenant";
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const container = db.container("governance");

  const activityEvent = {
    id: `act-${traceId}`,
    type: "data.activity",
    tenantId,
    traceId,
    provider: "google",
    operation: "read",
    resourceType: "gmail/messages",
    method: "GET",
    path: "/gmail/v1/users/me/messages",
    statusCode: 200,
    durationMs: 150,
    responseBytes: 2048,
    timestamp: new Date().toISOString(),
    _lineagePushed: false,
  };

  const llmEvent = {
    id: `llm-${traceId}`,
    type: "data.llm",
    tenantId,
    traceId,
    model: "gpt-54",
    provider: "azure",
    promptTokens: 500,
    completionTokens: 50,
    durationMs: 800,
    timestamp: new Date(Date.now() + 1000).toISOString(),
    _lineagePushed: false,
  };

  console.log("1. Inserting correlated test events...");
  await container.items.create(activityEvent);
  console.log(`   data.activity: ${activityEvent.id}`);
  await container.items.create(llmEvent);
  console.log(`   data.llm: ${llmEvent.id}`);
  console.log(`   traceId: ${traceId}\n`);

  // 2. Run aggregator
  console.log("2. Running lineage aggregator...");
  const result = await aggregateAndPushLineage(
    cosmosEndpoint,
    cosmosDatabase,
    purviewEndpoint,
    { tenantId, lookbackMinutes: 5, maxTraces: 10 },
  );
  console.log(`   tracesProcessed: ${result.tracesProcessed}`);
  console.log(`   entitiesPushed: ${result.entitiesPushed}`);
  console.log(`   errors: ${JSON.stringify(result.errors)}\n`);

  // 3. Verify events were marked as pushed
  console.log("3. Verifying events marked as pushed...");
  const { resource: actCheck } = await container.item(activityEvent.id, tenantId).read();
  const { resource: llmCheck } = await container.item(llmEvent.id, tenantId).read();
  console.log(`   activity._lineagePushed: ${actCheck?._lineagePushed}`);
  console.log(`   llm._lineagePushed: ${llmCheck?._lineagePushed}`);

  // 4. Verify lineage summary written
  console.log("\n4. Checking lineage summary document...");
  try {
    const { resource: lineageSummary } = await container.item(`lineage-${traceId}`, tenantId).read();
    console.log(`   lineage doc: ${lineageSummary?.id}`);
    console.log(`   inputs: ${JSON.stringify(lineageSummary?.inputs)}`);
    console.log(`   outputs: ${JSON.stringify(lineageSummary?.outputs)}`);
    console.log(`   llm: ${JSON.stringify(lineageSummary?.llm)}`);
    console.log(`   purviewPushed: ${lineageSummary?.purviewPushed}`);
  } catch {
    console.log("   (lineage summary not found)");
  }

  console.log("\n=== E2E Test Complete ===");
}

main().catch((e) => {
  console.error("Test failed:", e.message || e);
  process.exit(1);
});
