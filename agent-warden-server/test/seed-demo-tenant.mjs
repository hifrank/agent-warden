import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const c = new CosmosClient({
  endpoint: "https://cosmos-agentwarden-dev.documents.azure.com:443/",
  aadCredentials: new DefaultAzureCredential(),
});

const r = await c.database("agent-warden").container("instances").items.upsert({
  id: "oc-demo-tenant",
  tenantId: "demo-tenant",
  instanceId: "oc-demo-tenant",
  state: "Active",
  version: "2026.3.12",
  tier: "enterprise",
  region: "eastus2",
  createdAt: "2026-03-14T00:00:00.000Z",
  activeChannels: [],
  skillCount: 0,
  podCount: 1,
  messagesLast24h: 0,
  llmTokensLast24h: 0,
  ownerIdentity: "admin@agentwarden.dev",
  tags: { environment: "dev", deployedVia: "helm" },
});
console.log("Seeded:", r.resource.id);
