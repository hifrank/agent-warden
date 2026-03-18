/**
 * E2E test for governance query tools: scope-usage, data-map, anomalies.
 * Usage: node test/test-governance-queries.mjs
 */
import { queryScopeUsage, buildDataMap, queryAnomalies } from "../dist/tools/governance-queries.js";

const cosmosEndpoint = process.env.AZURE_COSMOS_ENDPOINT;
const cosmosDatabase = process.env.AZURE_COSMOS_DATABASE || "agent-warden";
const tenantId = "demo-tenant";

async function main() {
  console.log("=== Governance Queries E2E Test ===\n");

  // 1. Scope Usage
  console.log("1. queryScopeUsage...");
  try {
    const scopeUsage = await queryScopeUsage(cosmosEndpoint, cosmosDatabase, tenantId, { days: 7 });
    console.log(`   Found ${scopeUsage.length} scope usage reports`);
    if (scopeUsage.length > 0) {
      console.log(`   Latest: provider=${scopeUsage[0].provider}, scopes=${scopeUsage[0].usedScopes?.length || 0}`);
    }
  } catch (e) {
    console.log(`   Error: ${e.message}`);
  }

  // 2. Data Map
  console.log("\n2. buildDataMap...");
  try {
    const dataMap = await buildDataMap(cosmosEndpoint, cosmosDatabase, tenantId, { days: 7 });
    console.log(`   sources: ${dataMap.sources.length}`);
    console.log(`   destinations: ${dataMap.destinations.length}`);
    console.log(`   llmUsage: ${JSON.stringify(dataMap.llmUsage)}`);
    console.log(`   dlpViolations: ${dataMap.dlpViolations}`);
    console.log(`   anomalies: ${dataMap.anomalies.length}`);
    if (dataMap.sources.length > 0) {
      console.log(`   Top source: ${dataMap.sources[0].provider}/${dataMap.sources[0].resourceType} (reads: ${dataMap.sources[0].readCount})`);
    }
  } catch (e) {
    console.log(`   Error: ${e.message}`);
  }

  // 3. Anomalies
  console.log("\n3. queryAnomalies...");
  try {
    const anomalies = await queryAnomalies(cosmosEndpoint, cosmosDatabase, { tenantId, days: 7 });
    console.log(`   Found ${anomalies.length} anomalies`);
    if (anomalies.length > 0) {
      console.log(`   Latest: type=${anomalies[0].type}, severity=${anomalies[0].severity}, provider=${anomalies[0].provider}`);
    }
  } catch (e) {
    console.log(`   Error: ${e.message}`);
  }

  console.log("\n=== Governance Queries Test Complete ===");
}

main().catch((e) => {
  console.error("Test failed:", e.message || e);
  process.exit(1);
});
