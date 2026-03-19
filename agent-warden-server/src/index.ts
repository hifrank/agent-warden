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
} from "./tools/tenant-lifecycle.js";
import { checkTenantHealth, checkAllTenantsHealth } from "./tools/health-check.js";
import { listInstances, getInstance, getFleetSummary } from "./tools/inventory.js";
import { dlpScan, listDLPPolicies, listDLPIncidents } from "./tools/dlp.js";
import { reportSandboxExecution, querySandboxAudit } from "./tools/sandbox.js";
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
      config.HELM_CHART_PATH
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
      config.AZURE_COSMOS_DATABASE
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
    const policies = listDLPPolicies();
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

// ─── Sandbox Monitoring Tools (§4.1.1) ────────────────────

server.tool(
  "warden.sandbox.report",
  "Process sandbox execution telemetry from sandbox-monitor (Kata microVM). Records audit trail and triggers incidents for high-risk executions.",
  {
    telemetry: z.object({
      version: z.string(),
      type: z.literal("sandbox.telemetry"),
      tenantId: z.string(),
      sessionId: z.string(),
      toolName: z.string(),
      skillName: z.string(),
      execution: z.object({
        command: z.string(),
        exitCode: z.number().nullable(),
        signal: z.string().nullable(),
        durationMs: z.number(),
        startedAt: z.string(),
        finishedAt: z.string(),
      }),
      processes: z.object({
        total: z.number(),
        tree: z.array(z.object({
          pid: z.number(),
          ppid: z.number(),
          comm: z.string(),
          args: z.string(),
        })),
        suspicious: z.array(z.string()),
      }),
      syscalls: z.object({
        blocked: z.array(z.object({ syscall: z.string(), count: z.number() })),
        totalAuditEvents: z.number(),
      }),
      filesystem: z.object({
        filesCreated: z.array(z.string()),
        filesModified: z.array(z.string()),
        totalBytesWritten: z.number(),
        suspiciousFiles: z.array(z.string()),
      }),
      network: z.object({
        connections: z.array(z.object({
          proto: z.string(),
          remoteAddr: z.string(),
          remotePort: z.number(),
          state: z.string(),
        })),
        dnsQueries: z.array(z.string()),
        totalBytesOut: z.number(),
        totalBytesIn: z.number(),
      }),
      resources: z.object({
        cpuMs: z.number(),
        memoryPeakMb: z.number(),
        ioBytesRead: z.number(),
        ioBytesWrite: z.number(),
      }),
      risk: z.object({
        score: z.number(),
        factors: z.array(z.string()),
        action: z.enum(["allow", "flag", "alert"]),
      }),
    }).describe("Telemetry JSON produced by sandbox-monitor inside Kata microVM"),
  },
  async ({ telemetry }) => {
    const result = await reportSandboxExecution(
      telemetry,
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
  "warden.sandbox.audit",
  "Query sandbox execution audit trail for a tenant — filter by risk score and action",
  {
    tenantId: z.string().describe("Tenant ID"),
    minRiskScore: z.number().int().min(0).max(100).optional().describe("Minimum risk score filter"),
    action: z.enum(["allow", "flag", "alert"]).optional().describe("Filter by risk action"),
    limit: z.number().int().min(1).max(500).default(50).describe("Max results"),
  },
  async ({ tenantId, minRiskScore, action, limit }) => {
    const results = await querySandboxAudit(
      { tenantId, minRiskScore, action, limit },
      config.AZURE_COSMOS_ENDPOINT,
      config.AZURE_COSMOS_DATABASE
    );
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(results, null, 2) },
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
      // Stateless mode requires a fresh transport per request
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
