import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadConfig } from "./config/env.js";
import {
  TenantProvisionInputSchema,
  TierSchema,
  TenantStateSchema,
} from "./config/types.js";
import {
  provisionTenant,
  suspendTenant,
  deleteTenant,
  removeTenantRecord,
} from "./tools/tenant-lifecycle.js";
import { checkTenantHealth, checkAllTenantsHealth } from "./tools/health-check.js";
import { listInstances, getInstance, getFleetSummary } from "./tools/inventory.js";
import { dlpScan, listDLPPolicies, listDLPIncidents } from "./tools/dlp.js";
import { submitPromptGuardIncident } from "./tools/prompt-guard-incident.js";
import {
  provisionAgentIdentity,
  connectSaaSProvider,
  listSaaSConnections,
  revokeSaaSConnection,
} from "./tools/agent-identity.js";
import {
  setupTenantGovernance,
  teardownTenantGovernance,
  listCollections,
  listDataSources,
  searchCatalog,
  getClassifiedAssets,
  runScan,
  listScanRuns,
  getAssetLineage,
  registerCustomTypes,
  createEntities,
  pushTraceLineage,
  upsertCollection,
} from "./middleware/purview-governance.js";
import { aggregateAndPushLineage } from "./tools/lineage-aggregator.js";
import { queryScopeUsage, buildDataMap, queryAnomalies } from "./tools/governance-queries.js";
import { authenticateRequest } from "./middleware/auth.js";

const config = loadConfig();

const server = new McpServer({
  name: "agent-warden",
  version: "0.1.0",
});

// ─── Tenant Lifecycle Tools ───────────────────────────────

server.tool(
  "warden.tenant.provision",
  "Provision a new OpenClaw tenant with isolated namespace, Key Vault, identity, and persistent storage",
  {
    tenantId: z.string().min(3).max(63).describe("Unique tenant identifier (lowercase, alphanumeric + hyphens)"),
    adminEmail: z.string().email().describe("Tenant admin email"),
    tier: TierSchema.describe("Tenant tier: free, pro, or enterprise"),
    region: z.string().default("eastus2").describe("Azure region"),
    channels: z
      .array(z.object({ type: z.string(), enabled: z.boolean() }))
      .default([])
      .describe("Channel configurations"),
  },
  async (input) => {
    const result = await provisionTenant(
      TenantProvisionInputSchema.parse(input),
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE,
      config.ACR_LOGIN_SERVER,
      config.HELM_CHART_VERSION,
      config.AZURE_KEYVAULT_URL,
      config.AZURE_KEK_VAULT_URL,
      config.AKS_RESOURCE_GROUP,
      config.AZURE_TENANT_ID,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "warden.tenant.suspend",
  "Suspend a tenant — scale pods to 0, retain all persistent data",
  {
    tenantId: z.string().describe("Tenant ID to suspend"),
  },
  async ({ tenantId }) => {
    await suspendTenant(
      tenantId,
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        { type: "text" as const, text: `Tenant ${tenantId} suspended.` },
      ],
    };
  }
);

server.tool(
  "warden.tenant.delete",
  "Delete a tenant — crypto-shred secrets, remove all resources",
  {
    tenantId: z.string().describe("Tenant ID to delete"),
  },
  async ({ tenantId }) => {
    await deleteTenant(
      tenantId,
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE,
      config.AZURE_KEYVAULT_URL,
      config.AZURE_KEK_VAULT_URL,
      config.AKS_RESOURCE_GROUP
    );
    return {
      content: [
        { type: "text" as const, text: `Tenant ${tenantId} deleted.` },
      ],
    };
  }
);

// ─── Health Check Tools ───────────────────────────────────

server.tool(
  "warden.tenant.health",
  "Run health check for a specific tenant instance",
  {
    tenantId: z.string().describe("Tenant ID to check"),
  },
  async ({ tenantId }) => {
    const result = await checkTenantHealth(
      tenantId,
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

// ─── Inventory Tools ──────────────────────────────────────

server.tool(
  "warden.inventory.list",
  "List all tenant instances with optional filters",
  {
    state: TenantStateSchema.optional().describe("Filter by state"),
    tier: TierSchema.optional().describe("Filter by tier"),
    region: z.string().optional().describe("Filter by region"),
    healthStatus: z
      .enum(["Healthy", "Degraded", "Unhealthy"])
      .optional()
      .describe("Filter by health status"),
  },
  async (filters) => {
    const instances = await listInstances(
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE,
      filters
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(instances, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.inventory.get",
  "Get detailed information about a specific tenant instance",
  {
    tenantId: z.string().describe("Tenant ID"),
  },
  async ({ tenantId }) => {
    const instance = await getInstance(
      tenantId,
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        {
          type: "text" as const,
          text: instance
            ? JSON.stringify(instance, null, 2)
            : `Tenant ${tenantId} not found.`,
        },
      ],
    };
  }
);

server.tool(
  "warden.monitoring.fleet",
  "Get fleet-wide summary: counts by state, tier, health",
  {},
  async () => {
    const summary = await getFleetSummary(
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(summary, null, 2) },
      ],
    };
  }
);

// ─── DLP Tools (§16) ─────────────────────────────────────

server.tool(
  "warden.dlp.scan",
  "Scan content for sensitive data (PII, credentials, PHI) using local patterns + Microsoft Purview DLP API",
  {
    tenantId: z.string().describe("Tenant ID"),
    content: z.string().describe("Content to scan"),
    contentType: z
      .enum(["message", "llm-prompt", "llm-response", "tool-output", "file"])
      .describe("Type of content for policy matching"),
    sourceChannel: z.string().optional().describe("Source channel (telegram, slack, etc.)"),
    destinationChannel: z.string().optional().describe("Destination channel"),
  },
  async ({ tenantId, content, contentType, sourceChannel, destinationChannel }) => {
    const result = await dlpScan(
      tenantId,
      content,
      contentType,
      config.AZURE_PURVIEW_ENDPOINT,
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE,
      sourceChannel,
      destinationChannel
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.dlp.policy.list",
  "List all active DLP policies and their configuration",
  {},
  async () => {
    const policies = await listDLPPolicies(
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(policies, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.dlp.incidents",
  "Query recent DLP incidents (blocked/redacted content) for a tenant",
  {
    tenantId: z.string().describe("Tenant ID"),
    limit: z.number().int().min(1).max(500).default(50).describe("Max incidents to return"),
  },
  async ({ tenantId, limit }) => {
    const incidents = await listDLPIncidents(
      tenantId,
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE,
      limit
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(incidents, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.dlp.prompt_guard.incident",
  "Archive raw prompt-guard evidence to Blob Storage, submit a Purview activity, and persist an audit incident",
  {
    tenantId: z.string().describe("Tenant ID"),
    reason: z.string().describe("Why the prompt guard triggered"),
    rawEvidence: z.string().describe("Full raw evidence text that triggered the prompt guard"),
    evidenceMimeType: z.string().optional().describe("Evidence MIME type, for example text/plain"),
    detectionSource: z.string().optional().describe("Detection source, defaults to l1-prompt-guard-tool"),
    safeSummary: z.string().optional().describe("Redacted user-safe summary of the incident"),
    conversationId: z.string().optional().describe("Conversation identifier"),
    threadId: z.string().optional().describe("Thread identifier"),
    sourceChannel: z.string().optional().describe("Source channel such as telegram or slack"),
    modelId: z.string().optional().describe("Model identifier used by the agent"),
    ruleName: z.string().optional().describe("Policy or rule name associated with the hit"),
  },
  async (input) => {
    const result = await submitPromptGuardIncident(input);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

// ─── Agent Identity & SaaS Connection Tools (§18.7) ─────

server.tool(
  "warden.identity.provision",
  "Create an Entra ID App Registration for a tenant's agent with federated credential for AKS Workload Identity",
  {
    tenantId: z.string().describe("Tenant ID"),
    displayName: z.string().describe("User display name (e.g. 'frank')"),
    portalBaseUrl: z.string().url().describe("Self-service portal base URL"),
    aksOidcIssuer: z.string().url().describe("AKS OIDC issuer URL"),
  },
  async ({ tenantId, displayName, portalBaseUrl, aksOidcIssuer }) => {
    const result = await provisionAgentIdentity(
      { tenantId, displayName, portalBaseUrl, aksOidcIssuer },
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.identity.connect",
  "Exchange an OAuth authorization code from a SaaS provider consent flow and store the refresh token",
  {
    tenantId: z.string().describe("Tenant ID"),
    provider: z.enum(["google", "graph", "sfdc", "slack", "github"]).describe("SaaS provider"),
    authorizationCode: z.string().describe("OAuth authorization code from consent redirect"),
    redirectUri: z.string().url().describe("Redirect URI used in the consent flow"),
  },
  async ({ tenantId, provider, authorizationCode, redirectUri }) => {
    const result = await connectSaaSProvider(
      { tenantId, provider, authorizationCode, redirectUri },
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.identity.connections",
  "List all SaaS connections for a tenant's agent identity",
  {
    tenantId: z.string().describe("Tenant ID"),
  },
  async ({ tenantId }) => {
    const result = await listSaaSConnections(
      tenantId,
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.identity.revoke",
  "Revoke a SaaS connection — deletes the refresh token from Key Vault and removes the connection record",
  {
    tenantId: z.string().describe("Tenant ID"),
    provider: z.enum(["google", "graph", "sfdc", "slack", "github"]).describe("SaaS provider to revoke"),
  },
  async ({ tenantId, provider }) => {
    const result = await revokeSaaSConnection(
      tenantId,
      provider,
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

// ─── Data Governance Tools (§16 Tier 1: Azure Purview Data Map) ──

server.tool(
  "warden.governance.setup",
  "Set up Purview data governance for a tenant: create collection, register data sources",
  {
    tenantId: z.string().describe("Tenant ID"),
    cosmosAccountEndpoint: z.string().url().optional().describe("Cosmos DB endpoint for tenant data"),
    blobStorageEndpoint: z.string().url().optional().describe("Blob Storage endpoint for session backups"),
  },
  async ({ tenantId, cosmosAccountEndpoint, blobStorageEndpoint }) => {
    const result = await setupTenantGovernance(
      config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT,
      tenantId,
      config.PURVIEW_ROOT_COLLECTION ?? "agent-warden-platform",
      cosmosAccountEndpoint,
      blobStorageEndpoint,
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.teardown",
  "Remove Purview data governance for a deleted tenant",
  {
    tenantId: z.string().describe("Tenant ID"),
  },
  async ({ tenantId }) => {
    const result = await teardownTenantGovernance(
      config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT,
      tenantId,
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.collections",
  "List all Purview collections (one per tenant + platform root)",
  {},
  async () => {
    const result = await listCollections(config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.datasources",
  "List all registered data sources in Purview Data Map",
  {},
  async () => {
    const result = await listDataSources(config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.scan.run",
  "Trigger a classification scan on a registered data source",
  {
    dataSourceName: z.string().describe("Data source name (e.g. cosmos-demo-tenant)"),
    scanName: z.string().describe("Scan name to run"),
  },
  async ({ dataSourceName, scanName }) => {
    const result = await runScan(
      config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT,
      dataSourceName,
      scanName,
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.scan.history",
  "List scan run history for a data source",
  {
    dataSourceName: z.string().describe("Data source name"),
    scanName: z.string().describe("Scan name"),
  },
  async ({ dataSourceName, scanName }) => {
    const result = await listScanRuns(
      config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT,
      dataSourceName,
      scanName,
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.search",
  "Search the Purview Data Map catalog for classified assets",
  {
    query: z.string().describe("Search keywords (use * for all)"),
    collectionFilter: z.string().optional().describe("Filter by collection name (e.g. tenant-demo-tenant)"),
  },
  async ({ query, collectionFilter }) => {
    const filter = collectionFilter
      ? { collectionId: collectionFilter }
      : undefined;
    const result = await searchCatalog(
      config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT,
      query,
      filter,
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.classifications",
  "Get classified assets for a specific tenant collection",
  {
    tenantId: z.string().describe("Tenant ID"),
  },
  async ({ tenantId }) => {
    const result = await getClassifiedAssets(
      config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT,
      `tenant-${tenantId}`,
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.lineage",
  "Get data lineage for an asset (track where data flows)",
  {
    assetGuid: z.string().describe("Purview asset GUID"),
    direction: z.enum(["INPUT", "OUTPUT", "BOTH"]).default("BOTH").describe("Lineage direction"),
  },
  async ({ assetGuid, direction }) => {
    const result = await getAssetLineage(
      config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT,
      assetGuid,
      direction,
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.bootstrap",
  "One-time setup: register OpenClaw custom entity types in Purview Data Map and create root collection",
  {},
  async () => {
    const steps: { step: string; ok: boolean; detail: unknown }[] = [];

    // 1. Register custom types
    const typeResult = await registerCustomTypes(config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT);
    steps.push({ step: "register-custom-types", ok: typeResult.ok, detail: typeResult.data });

    // 2. Create root collection
    const rootName = config.PURVIEW_ROOT_COLLECTION ?? "agent-warden-platform";
    const collResult = await upsertCollection(config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT, {
      name: rootName,
      friendlyName: "Agent Warden Platform",
      description: "Root collection for all Agent Warden tenant data governance",
    });
    steps.push({ step: "create-root-collection", ok: collResult.ok, detail: collResult.data });

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ ok: steps.every((s) => s.ok), steps }, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.entity.create",
  "Create or update entities in Purview Data Map (batch, up to 50)",
  {
    entities: z.array(z.object({
      typeName: z.string().describe("Atlas type name (e.g. saas_resource, openclaw_tenant)"),
      attributes: z.record(z.unknown()).describe("Entity attributes including name and qualifiedName"),
    })).describe("Array of entities to create"),
  },
  async ({ entities }) => {
    const result = await createEntities(config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT, entities);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.lineage.push",
  "Push trace-based lineage to Purview: source SaaS resources → agent process → LLM → destination SaaS resources",
  {
    tenantId: z.string().describe("Tenant ID"),
    traceId: z.string().describe("Trace ID correlating all events in this agent run"),
    toolsUsed: z.array(z.string()).default([]).describe("Tool names used in this trace"),
    durationMs: z.number().default(0).describe("Total trace duration in ms"),
    dlpViolations: z.number().default(0).describe("Number of DLP violations detected"),
    inputs: z.array(z.object({
      provider: z.string(),
      resourceType: z.string(),
      qualifiedName: z.string(),
      name: z.string(),
    })).describe("Input SaaS resources (data sources)"),
    outputs: z.array(z.object({
      provider: z.string(),
      resourceType: z.string(),
      qualifiedName: z.string(),
      name: z.string(),
    })).describe("Output SaaS resources (data destinations)"),
    llm: z.object({
      model: z.string(),
      provider: z.string(),
      promptTokens: z.number(),
      completionTokens: z.number(),
    }).optional().describe("LLM invocation details (if applicable)"),
  },
  async (input) => {
    const result = await pushTraceLineage(config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT, input);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.lineage.aggregate",
  "Aggregate data.activity + data.llm events by traceId and push lineage to Purview Data Map",
  {
    tenantId: z.string().optional().describe("Filter by tenant ID (omit for all tenants)"),
    lookbackMinutes: z.number().default(30).describe("Look back window in minutes"),
    maxTraces: z.number().default(100).describe("Maximum number of traces to process"),
  },
  async ({ tenantId, lookbackMinutes, maxTraces }) => {
    const result = await aggregateAndPushLineage(
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE,
      config.AZURE_PURVIEW_GOVERNANCE_ENDPOINT,
      { tenantId, lookbackMinutes, maxTraces },
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

// ─── Governance L3/L4: Scope Usage, Data Map, Anomalies ─────

server.tool(
  "warden.governance.scope-usage",
  "Query OAuth scope usage reports for a tenant — shows which scopes are actually used vs granted, per provider",
  {
    tenantId: z.string().describe("Tenant ID"),
    provider: z.string().optional().describe("Filter by SaaS provider (google, graph, github, slack, sfdc)"),
    days: z.number().default(7).describe("Look back window in days"),
  },
  async ({ tenantId, provider, days }) => {
    const reports = await queryScopeUsage(
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE,
      tenantId,
      { provider, days },
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(reports, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.data-map",
  "Build a data map view for a tenant — all SaaS sources read from, destinations written to, LLM usage, DLP violations",
  {
    tenantId: z.string().describe("Tenant ID"),
    days: z.number().default(30).describe("Look back window in days"),
  },
  async ({ tenantId, days }) => {
    const dataMap = await buildDataMap(
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE,
      tenantId,
      { days },
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(dataMap, null, 2) },
      ],
    };
  }
);

server.tool(
  "warden.governance.anomalies",
  "List access anomalies detected across tenants — new resource types, write pattern changes",
  {
    tenantId: z.string().optional().describe("Filter by tenant ID (omit for all tenants)"),
    days: z.number().default(7).describe("Look back window in days"),
    severity: z.enum(["low", "medium", "high"]).optional().describe("Filter by severity"),
  },
  async ({ tenantId, days, severity }) => {
    const anomalies = await queryAnomalies(
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE,
      { tenantId, days, severity },
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(anomalies, null, 2) },
      ],
    };
  }
);

// ─── Start Server ─────────────────────────────────────────

async function main() {
  const mode = process.env.MCP_TRANSPORT ?? "stdio";

  if (mode === "http") {
    const port = config.MCP_SERVER_PORT;

    const httpServer = createServer(async (req, res) => {
      if (!authenticateRequest(req, res)) return;

      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      // ── REST: POST /api/tenants/provision ──
      if (url.pathname === "/api/tenants/provision" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
          const input = TenantProvisionInputSchema.parse(JSON.parse(body));

          // Return 202 immediately, run provisioning async
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted", tenantId: input.tenantId }));

          // Fire-and-forget provisioning
          provisionTenant(
            input,
            config.AZURE_COSMOS_ENDPOINT,
            config.AZURE_COSMOS_DATABASE,
            config.ACR_LOGIN_SERVER,
            config.HELM_CHART_VERSION,
            config.AZURE_KEYVAULT_URL,
            config.AZURE_KEK_VAULT_URL,
            config.AKS_RESOURCE_GROUP,
            config.AZURE_TENANT_ID,
          ).catch((err) => {
            console.error(`[provision] Unhandled error for ${input.tenantId}:`, err);
          });
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Invalid input" }));
        }
        return;
      }

      // ── REST: POST /api/tenants/:tenantId/suspend ──
      const suspendMatch = url.pathname.match(/^\/api\/tenants\/([a-z0-9][a-z0-9-]*[a-z0-9])\/suspend$/);
      if (suspendMatch && req.method === "POST") {
        try {
          await suspendTenant(suspendMatch[1], config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "suspended", tenantId: suspendMatch[1] }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Suspend failed" }));
        }
        return;
      }

      // ── REST: DELETE /api/tenants/:tenantId ──
      const deleteMatch = url.pathname.match(/^\/api\/tenants\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
      if (deleteMatch && req.method === "DELETE") {
        try {
          await deleteTenant(deleteMatch[1], config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE, config.AZURE_KEYVAULT_URL, config.AZURE_KEK_VAULT_URL, config.AKS_RESOURCE_GROUP);
          // Returns immediately — cleanup runs async
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "deleting", tenantId: deleteMatch[1] }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Delete failed" }));
        }
        return;
      }

      // ── REST: DELETE /api/tenants/:tenantId/record ──
      const removeMatch = url.pathname.match(/^\/api\/tenants\/([a-z0-9][a-z0-9-]*[a-z0-9])\/record$/);
      if (removeMatch && req.method === "DELETE") {
        try {
          await removeTenantRecord(removeMatch[1], config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          res.writeHead(204);
          res.end();
        } catch (err) {
          const status = (err instanceof Error && err.message.includes("not Deleted")) ? 409 : 404;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Remove failed" }));
        }
        return;
      }

      // ── REST: POST /api/tenants/:tenantId/pairing-approve ──
      const pairMatch = url.pathname.match(/^\/api\/tenants\/([a-z0-9][a-z0-9-]*[a-z0-9])\/pairing-approve$/);
      if (pairMatch && req.method === "POST") {
        const tenantId = pairMatch[1];
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const { code } = JSON.parse(body);
          if (!code || typeof code !== "string" || code.length < 4) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "A valid pairing code is required" }));
            return;
          }

          const { execAsync } = await import("./tools/config-sync.js");
          const namespace = `tenant-${tenantId}`;
          const podName = `openclaw-${tenantId}-0`;
          const containerName = "openclaw-gateway";

          // Execute the pairing approve command inside the pod
          const { stdout, stderr } = await execAsync(
            `kubectl exec ${podName} -n ${namespace} -c ${containerName} -- openclaw pairing approve telegram ${code}`,
          );
          console.log(`[pairing] approve ${tenantId} code=${code}: ${stdout.trim()}`);

          // Update Cosmos record
          const { getCosmosDb } = await import("./middleware/cosmos.js");
          const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          const container = db.container("tenants");
          const { resources } = await container.items.query({
            query: "SELECT * FROM c WHERE c.tenantId = @tid AND c.type = 'telegram-channel'",
            parameters: [{ name: "@tid", value: tenantId }],
          }).fetchAll();
          const pairedAt = new Date().toISOString();
          if (resources[0]) {
            resources[0].pairingStatus = "approved";
            resources[0].pairedAt = pairedAt;
            await container.items.upsert(resources[0]);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            message: `Pairing approved for code ${code}`,
            pairingStatus: "approved",
            pairedAt,
            podOutput: stdout.trim(),
          }));
        } catch (err) {
          console.error(`[pairing] error for ${tenantId}:`, err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Pairing failed" }));
        }
        return;
      }

      // ── REST: POST /api/tenants/:tenantId/telegram-config ──
      const tgCfgMatch = url.pathname.match(/^\/api\/tenants\/([a-z0-9][a-z0-9-]*[a-z0-9])\/telegram-config$/);
      if (tgCfgMatch && (req.method === "GET" || req.method === "POST")) {
        const tenantId = tgCfgMatch[1];
        const kekVaultUrl = config.AZURE_KEK_VAULT_URL;
        const kekSecretName = `kek-${tenantId}`;
        try {
          const { envelopeEncrypt, envelopeDecrypt } = await import("./middleware/envelope-crypto.js");
          const { getCosmosDb } = await import("./middleware/cosmos.js");
          const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          const container = db.container("tenants");

          if (req.method === "GET") {
            const { resources } = await container.items.query({
              query: "SELECT * FROM c WHERE c.tenantId = @tid AND c.type = 'telegram-channel'",
              parameters: [{ name: "@tid", value: tenantId }],
            }).fetchAll();
            const doc = resources[0];
            if (!doc) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ tenantId, botToken: "", pairingStatus: "pending" }));
              return;
            }
            // Decrypt if encrypted; backward compat for plaintext
            let plainToken = "";
            if (doc.encryptedBotToken) {
              plainToken = await envelopeDecrypt(doc.encryptedBotToken, kekVaultUrl);
            } else if (doc.botToken) {
              plainToken = doc.botToken;
            }
            const masked = plainToken
              ? plainToken.slice(0, 6) + "••••••" + plainToken.slice(-4)
              : "";
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              tenantId: doc.tenantId,
              botToken: masked,
              botUsername: doc.botUsername,
              pairingStatus: doc.pairingStatus ?? "pending",
              pairedAt: doc.pairedAt,
            }));
          } else {
            // POST — encrypt and save
            let body = "";
            for await (const chunk of req) body += chunk;
            const { botToken, botUsername } = JSON.parse(body);
            if (!botToken || typeof botToken !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "botToken is required" }));
              return;
            }
            const encryptedBotToken = await envelopeEncrypt(botToken, kekVaultUrl, kekSecretName);
            // Read existing doc if any
            const { resources } = await container.items.query({
              query: "SELECT * FROM c WHERE c.tenantId = @tid AND c.type = 'telegram-channel'",
              parameters: [{ name: "@tid", value: tenantId }],
            }).fetchAll();
            const existing = resources[0] ?? {};
            const doc = {
              ...existing,
              id: `telegram-${tenantId}`,
              type: "telegram-channel",
              tenantId,
              encryptedBotToken,
              botToken: "",          // clear plaintext
              botUsername: botUsername ?? existing.botUsername,
            };
            const { resource } = await container.items.upsert(doc);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              tenantId: resource!.tenantId,
              botToken: botToken.slice(0, 6) + "••••••" + botToken.slice(-4),
              botUsername: resource!.botUsername,
              pairingStatus: resource!.pairingStatus ?? "pending",
            }));
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Telegram config failed" }));
        }
        return;
      }

      // ── REST: POST /api/tenants/:tenantId/sync-config ──
      const syncMatch = url.pathname.match(/^\/api\/tenants\/([a-z0-9][a-z0-9-]*[a-z0-9])\/sync-config$/);
      if (syncMatch && req.method === "POST") {
        const tenantId = syncMatch[1];
        try {
          const { syncChannelConfig } = await import("./tools/config-sync.js");
          const result = await syncChannelConfig(
            tenantId,
            config.AZURE_COSMOS_ENDPOINT,
            config.AZURE_COSMOS_DATABASE,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Sync failed" }));
        }
        return;
      }

      // ── REST: GET /api/tenants/:tenantId/pod-config ──
      const podCfgMatch = url.pathname.match(/^\/api\/tenants\/([a-z0-9][a-z0-9-]*[a-z0-9])\/pod-config$/);
      if (podCfgMatch && req.method === "GET") {
        const tenantId = podCfgMatch[1];
        try {
          const { execAsync } = await import("./tools/config-sync.js");
          const ns = `tenant-${tenantId}`;
          const pod = `openclaw-${tenantId}-0`;
          const { stdout } = await execAsync(
            `kubectl exec ${pod} -n ${ns} -c openclaw-gateway -- cat /data/state/openclaw.json`,
          );
          // Redact sensitive fields
          const cfg = JSON.parse(stdout || "{}");
          if (cfg.models?.providers?.litellm?.apiKey) {
            cfg.models.providers.litellm.apiKey = "••••••";
          }
          if (cfg.gateway?.auth?.token) {
            cfg.gateway.auth.token = "••••••";
          }
          if (cfg.channels?.telegram?.botToken) {
            const t = cfg.channels.telegram.botToken;
            cfg.channels.telegram.botToken = t.slice(0, 6) + "••••••" + t.slice(-4);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(cfg, null, 2));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to read pod config" }));
        }
        return;
      }

      // ── REST: PUT /api/tenants/:tenantId/dlp-config ──
      const dlpCfgMatch = url.pathname.match(/^\/api\/tenants\/([a-z0-9][a-z0-9-]*[a-z0-9])\/dlp-config$/);
      if (dlpCfgMatch && req.method === "PUT") {
        const tenantId = dlpCfgMatch[1];
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const input = JSON.parse(body);
          const { getCosmosDb } = await import("./middleware/cosmos.js");
          const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          const container = db.container("instances");
          const instanceId = `oc-${tenantId}`;
          const { resource: existing } = await container.item(instanceId, tenantId).read();
          if (!existing) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Instance not found" }));
            return;
          }
          existing.dlpConfig = {
            ...(existing.dlpConfig ?? {}),
            ...input,
          };
          await container.item(instanceId, tenantId).replace(existing);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, dlpConfig: existing.dlpConfig }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to update DLP config" }));
        }
        return;
      }

      // ── REST: GET /api/tenants/:tenantId/logs?container=&tail=&since=&previous= ──
      const logsMatch = url.pathname.match(/^\/api\/tenants\/([a-z0-9][a-z0-9-]*[a-z0-9])\/logs$/);
      if (logsMatch && req.method === "GET") {
        const tenantId = logsMatch[1];
        const containerName = url.searchParams.get("container") ?? "openclaw-gateway";
        const tailLines = Math.min(Math.max(parseInt(url.searchParams.get("tail") ?? "200", 10) || 200, 10), 2000);
        const sinceSeconds = parseInt(url.searchParams.get("since") ?? "3600", 10) || 3600;
        const previous = url.searchParams.get("previous") === "true";
        try {
          const { getK8sClients } = await import("./middleware/k8s.js");
          const k8s = await import("@kubernetes/client-node");
          const { core } = getK8sClients();
          const namespace = `tenant-${tenantId}`;
          // Find pods via label selector
          const pods = await core.listNamespacedPod({ namespace, labelSelector: `app.kubernetes.io/instance=${tenantId}` });
          if (!pods.items.length) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No pods found", logs: "" }));
            return;
          }
          const podName = pods.items[0].metadata!.name!;
          // Use kubectl directly — the K8s JS client has issues with text/plain log responses
          // and Node.js https.request hangs with AKS kubelogin auth.
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          const args = [
            "logs", podName,
            "-n", namespace,
            "-c", containerName,
            `--tail=${tailLines}`,
          ];
          if (previous) {
            args.push("--previous");
          } else {
            args.push(`--since=${sinceSeconds}s`);
          }
          const { stdout: logText } = await execFileAsync("kubectl", args, { maxBuffer: 2 * 1024 * 1024 });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ podName, container: containerName, lines: tailLines, logs: logText }));
        } catch (err: any) {
          const status = err?.statusCode === 404 ? 404 : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message ?? "Failed to fetch logs" }));
        }
        return;
      }

      // ── REST: GET/PUT /api/settings/global ──
      if (url.pathname === "/api/settings/global") {
        const { getCosmosDb } = await import("./middleware/cosmos.js");
        const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
        // Ensure settings container exists (idempotent)
        await db.containers.createIfNotExists({
          id: "settings",
          partitionKey: { paths: ["/partitionKey"] },
        });
        const container = db.container("settings");

        if (req.method === "GET") {
          try {
            const { resource } = await container.item("global", "global").read();
            if (!resource) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({}));
              return;
            }
            // Strip Cosmos metadata
            const { _rid, _self, _etag, _attachments, _ts, ...settings } = resource;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(settings));
          } catch (err: any) {
            if (err.code === 404) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({}));
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message ?? "Failed to read settings" }));
            }
          }
          return;
        }

        if (req.method === "PUT") {
          try {
            let body = "";
            for await (const chunk of req) body += chunk;
            const input = JSON.parse(body);
            const doc = {
              id: "global",
              partitionKey: "global",
              ...input,
              updatedAt: new Date().toISOString(),
            };
            await container.items.upsert(doc);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(doc));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message ?? "Failed to save settings" }));
          }
          return;
        }
      }

      // ── REST: POST /api/settings/e5-admin-app ──
      if (url.pathname === "/api/settings/e5-admin-app" && req.method === "POST") {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const input = JSON.parse(body);
          if (!input.clientId || !input.clientSecret) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "clientId and clientSecret are required" }));
            return;
          }
          const { envelopeEncrypt } = await import("./middleware/envelope-crypto.js");
          const { generateKekValue } = await import("./middleware/envelope-crypto.js");
          const { getCosmosDb } = await import("./middleware/cosmos.js");
          const kekVaultUrl = config.AZURE_KEK_VAULT_URL;
          const kekSecretName = "kek-e5-admin";
          // Ensure the KEK exists in Key Vault (create if missing)
          const { SecretClient } = await import("@azure/keyvault-secrets");
          const { DefaultAzureCredential } = await import("@azure/identity");
          const kvClient = new SecretClient(kekVaultUrl, new DefaultAzureCredential());
          try {
            await kvClient.getSecret(kekSecretName);
          } catch (kekErr: any) {
            if (kekErr.statusCode === 404 || kekErr.code === "SecretNotFound") {
              await kvClient.setSecret(kekSecretName, generateKekValue());
            } else {
              throw kekErr;
            }
          }
          const encryptedClientSecret = await envelopeEncrypt(input.clientSecret, kekVaultUrl, kekSecretName);
          // Read current global settings, patch in adminApp
          const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          await db.containers.createIfNotExists({ id: "settings", partitionKey: { paths: ["/partitionKey"] } });
          const container = db.container("settings");
          let existing: any = {};
          try {
            const { resource } = await container.item("global", "global").read();
            if (resource) {
              const { _rid, _self, _etag, _attachments, _ts, ...rest } = resource;
              existing = rest;
            }
          } catch (err: any) {
            if (err.code !== 404) throw err;
          }
          const adminApp = {
            clientId: input.clientId,
            encryptedClientSecret,
            configuredAt: new Date().toISOString(),
          };
          const doc = {
            ...existing,
            id: "global",
            partitionKey: "global",
            e5Tenant: { ...(existing.e5Tenant ?? {}), adminApp },
            updatedAt: new Date().toISOString(),
          };
          await container.items.upsert(doc);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, clientId: input.clientId, configuredAt: adminApp.configuredAt }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message ?? "Failed to save E5 admin app" }));
        }
        return;
      }

      // ── REST: POST /api/settings/e5-admin-app/test ──
      if (url.pathname === "/api/settings/e5-admin-app/test" && req.method === "POST") {
        try {
          const { envelopeDecrypt } = await import("./middleware/envelope-crypto.js");
          const { getCosmosDb } = await import("./middleware/cosmos.js");
          const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          const container = db.container("settings");
          const { resource } = await container.item("global", "global").read();
          if (!resource?.e5Tenant?.adminApp || !resource?.e5Tenant?.purviewTenantId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "E5 admin app or tenant ID not configured" }));
            return;
          }
          const kekVaultUrl = config.AZURE_KEK_VAULT_URL;
          const clientSecret = await envelopeDecrypt(resource.e5Tenant.adminApp.encryptedClientSecret, kekVaultUrl);
          const { ClientSecretCredential } = await import("@azure/identity");
          const credential = new ClientSecretCredential(
            resource.e5Tenant.purviewTenantId,
            resource.e5Tenant.adminApp.clientId,
            clientSecret,
          );
          const token = await credential.getToken("https://graph.microsoft.com/.default");
          if (token) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, message: "Successfully authenticated to E5 tenant Graph API" }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to acquire token" }));
          }
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message ?? "Connection test failed" }));
        }
        return;
      }

      // ── REST: POST /api/settings/scc-app ──
      if (url.pathname === "/api/settings/scc-app" && req.method === "POST") {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const input = JSON.parse(body);
          if (!input.clientId || !input.certificateThumbprint || !input.e5OrgDomain) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "clientId, certificateThumbprint, and e5OrgDomain are required" }));
            return;
          }
          const { getCosmosDb } = await import("./middleware/cosmos.js");
          const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          await db.containers.createIfNotExists({ id: "settings", partitionKey: { paths: ["/partitionKey"] } });
          const container = db.container("settings");
          let existing: any = {};
          try {
            const { resource } = await container.item("global", "global").read();
            if (resource) {
              const { _rid, _self, _etag, _attachments, _ts, ...rest } = resource;
              existing = rest;
            }
          } catch (err: any) {
            if (err.code !== 404) throw err;
          }
          const sccApp = {
            clientId: input.clientId,
            certificateThumbprint: input.certificateThumbprint,
            e5OrgDomain: input.e5OrgDomain,
            configuredAt: new Date().toISOString(),
          };
          const doc = {
            ...existing,
            id: "global",
            partitionKey: "global",
            e5Tenant: { ...(existing.e5Tenant ?? {}), sccApp },
            updatedAt: new Date().toISOString(),
          };
          await container.items.upsert(doc);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, clientId: input.clientId, configuredAt: sccApp.configuredAt }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message ?? "Failed to save SCC app" }));
        }
        return;
      }

      // ── REST: GET /api/dlp-policies ──
      if (url.pathname === "/api/dlp-policies" && req.method === "GET") {
        try {
          const policies = await listDLPPolicies(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(policies));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message ?? "Failed to list policies" }));
        }
        return;
      }

      // ── REST: POST /api/dlp-policies (create) ──
      if (url.pathname === "/api/dlp-policies" && req.method === "POST") {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const input = JSON.parse(body);
          if (!input.id || !input.name) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "id and name are required" }));
            return;
          }
          const { getCosmosDb } = await import("./middleware/cosmos.js");
          const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          await db.containers.createIfNotExists({ id: "dlp-policies", partitionKey: { paths: ["/id"] } });
          const { resource } = await db.container("dlp-policies").items.upsert(input);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resource));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message ?? "Failed to create policy" }));
        }
        return;
      }

      // ── REST: PUT /api/dlp-policies/:id (update) ──
      const policyUpdateMatch = url.pathname.match(/^\/api\/dlp-policies\/([a-z0-9_-]+)$/i);
      if (policyUpdateMatch && req.method === "PUT") {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const input = JSON.parse(body);
          input.id = policyUpdateMatch[1];
          const { getCosmosDb } = await import("./middleware/cosmos.js");
          const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          const { resource } = await db.container("dlp-policies").items.upsert(input);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resource));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message ?? "Failed to update policy" }));
        }
        return;
      }

      // ── REST: DELETE /api/dlp-policies/:id ──
      if (policyUpdateMatch && req.method === "DELETE") {
        try {
          const policyId = policyUpdateMatch[1];
          const { getCosmosDb } = await import("./middleware/cosmos.js");
          const db = await getCosmosDb(config.AZURE_COSMOS_ENDPOINT, config.AZURE_COSMOS_DATABASE);
          await db.container("dlp-policies").item(policyId, policyId).delete();
          res.writeHead(204);
          res.end();
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message ?? "Failed to delete policy" }));
        }
        return;
      }

      // ── MCP Streamable HTTP transport (default) ──
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      transport.onerror = (err) => {
        console.error("[MCP transport error]", err);
      };
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error("[MCP request error]", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      } finally {
        await transport.close();
      }
    });

    httpServer.listen(port, () => {
      console.error(`Agent Warden Server running on HTTP port ${port}`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`Agent Warden Server running (stdio transport)`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
