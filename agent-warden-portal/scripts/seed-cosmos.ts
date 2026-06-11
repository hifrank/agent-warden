/**
 * Seed Cosmos DB with demo data for the agent-warden portal.
 * Uses DefaultAzureCredential (Azure CLI login).
 *
 * Usage: npx tsx scripts/seed-cosmos.ts
 */
import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const COSMOS_ENDPOINT = "https://cosmos-portal-agentwarden-dev.documents.azure.com:443/";
const DATABASE = "agent-warden";

async function main() {
  const credential = new DefaultAzureCredential();
  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: credential });
  const db = client.database(DATABASE);

  // ─── Instances ─────────────────────────────────────────
  const instancesContainer = db.container("instances");
  const instances = [
    {
      id: "oc-contoso-prod",
      tenantId: "contoso-prod",
      instanceId: "oc-contoso-prod",
      state: "Active",
      version: "0.9.2",
      tier: "enterprise",
      region: "eastus2",
      createdAt: "2026-03-01T10:00:00Z",
      lastHealthCheck: "2026-04-08T08:00:00Z",
      healthStatus: "Healthy",
      activeChannels: ["slack", "telegram"],
      skillCount: 12,
      podCount: 3,
      cpuUsagePct: 45,
      memoryUsagePct: 62,
      messagesLast24h: 1420,
      llmTokensLast24h: 890000,
      ownerIdentity: "admin@contoso.com",
      tags: { env: "production" },
    },
    {
      id: "oc-fabrikam-dev",
      tenantId: "fabrikam-dev",
      instanceId: "oc-fabrikam-dev",
      state: "Active",
      version: "0.9.1",
      tier: "pro",
      region: "westus3",
      createdAt: "2026-03-15T14:30:00Z",
      lastHealthCheck: "2026-04-08T07:55:00Z",
      healthStatus: "Degraded",
      activeChannels: ["discord"],
      skillCount: 5,
      podCount: 1,
      cpuUsagePct: 78,
      memoryUsagePct: 85,
      messagesLast24h: 310,
      llmTokensLast24h: 210000,
      ownerIdentity: "dev@fabrikam.com",
      tags: { env: "development" },
    },
  ];

  for (const inst of instances) {
    const { resource } = await instancesContainer.items.upsert(inst);
    console.log(`✓ instances/${resource!.id}`);
  }

  // ─── Tenants (for Channels & Configs) ──────────────────
  const tenantsContainer = db.container("tenants");
  const tenants = [
    {
      id: "contoso-prod",
      tenantId: "contoso-prod",
      name: "Contoso Production",
      telegramBotToken: "",
      telegramChatId: "",
      telegramPaired: false,
      soulMd: "# Contoso OpenClaw Agent\nYou are a helpful enterprise assistant for Contoso.\nBe professional, accurate, and security-conscious.\n",
      openclawMd: "plugins:\n  - agent-warden-agents-view\n  - agent-warden-a365\n  - agent-warden-purview-dlp\n\nmodel: gpt-5.4\nprovider: openai\n",
    },
    {
      id: "fabrikam-dev",
      tenantId: "fabrikam-dev",
      name: "Fabrikam Dev",
      telegramBotToken: "",
      telegramChatId: "",
      telegramPaired: false,
      soulMd: "# Fabrikam Dev Agent\nYou are a development assistant for Fabrikam.\nHelp with code, debugging, and testing.\n",
      openclawMd: "plugins:\n  - agent-warden-agents-view\n\nmodel: claude-sonnet-4-20250514\nprovider: anthropic\n",
    },
  ];

  for (const t of tenants) {
    const { resource } = await tenantsContainer.items.upsert(t);
    console.log(`✓ tenants/${resource!.id}`);
  }

  // ─── Skills ────────────────────────────────────────────
  const skillsContainer = db.container("skills");
  const skills = [
    { id: "sk-1", skillId: "sk-1", name: "web-search", description: "Search the web via Bing", version: "1.2.0", enabled: true, tenantId: "contoso-prod" },
    { id: "sk-2", skillId: "sk-2", name: "code-interpreter", description: "Execute Python in sandbox", version: "2.0.1", enabled: true, tenantId: "contoso-prod" },
    { id: "sk-3", skillId: "sk-3", name: "calendar-access", description: "Read/write M365 calendar", version: "1.0.0", enabled: false, tenantId: "contoso-prod" },
    { id: "sk-4", skillId: "sk-4", name: "file-search", description: "Search uploaded documents", version: "1.1.0", enabled: true, tenantId: "fabrikam-dev" },
    { id: "sk-5", skillId: "sk-5", name: "email-send", description: "Send emails via Graph API", version: "1.0.2", enabled: true, tenantId: "fabrikam-dev" },
  ];

  for (const sk of skills) {
    const { resource } = await skillsContainer.items.upsert(sk);
    console.log(`✓ skills/${resource!.id}`);
  }

  console.log("\n🎉 Seed complete!");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
