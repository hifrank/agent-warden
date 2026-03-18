import { getCosmosDb } from "../middleware/cosmos.js";

// ──────────────────────────────────────────────────────────
// Governance Query Tools — L3/L4 queries against the
// Cosmos governance container for scope usage, anomalies,
// and data map views.
// ──────────────────────────────────────────────────────────

export interface ScopeUsageReport {
  provider: string;
  period: string;
  usedScopes: string[];
  resourcesAccessed: Array<{
    resource: string;
    readCount: number;
    writeCount: number;
    deleteCount: number;
  }>;
  anomalies: Array<{ type: string; description: string; severity: string; timestamp: string }>;
}

export interface DataMapEntry {
  provider: string;
  resourceType: string;
  readCount: number;
  writeCount: number;
  deleteCount: number;
  lastAccessed: string;
}

export interface DataMapView {
  tenantId: string;
  period: { from: string; to: string };
  sources: DataMapEntry[];
  destinations: DataMapEntry[];
  llmUsage: {
    model: string;
    provider: string;
    totalCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
  } | null;
  dlpViolations: number;
  anomalies: Array<{ type: string; description: string; severity: string; timestamp: string }>;
}

export interface AnomalyRecord {
  type: string;
  description: string;
  severity: string;
  tenantId: string;
  provider: string;
  timestamp: string;
}

/**
 * Query scope usage reports for a tenant/provider from Cosmos.
 */
export async function queryScopeUsage(
  cosmosEndpoint: string,
  cosmosDatabase: string,
  tenantId: string,
  options: { provider?: string; days?: number } = {},
): Promise<ScopeUsageReport[]> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const container = db.container("governance");
  const days = options.days ?? 7;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  const providerFilter = options.provider ? "AND c.provider = @provider" : "";
  const query = {
    query: `SELECT * FROM c WHERE c.type = 'scope.usage' AND c.tenantId = @tenantId AND c.timestamp >= @cutoff ${providerFilter} ORDER BY c.timestamp DESC`,
    parameters: [
      { name: "@tenantId", value: tenantId },
      { name: "@cutoff", value: cutoff },
      ...(options.provider ? [{ name: "@provider", value: options.provider }] : []),
    ],
  };

  const { resources } = await container.items.query(query).fetchAll();
  return resources as ScopeUsageReport[];
}

/**
 * Build a data map view for a tenant — all sources read from, destinations written to.
 */
export async function buildDataMap(
  cosmosEndpoint: string,
  cosmosDatabase: string,
  tenantId: string,
  options: { days?: number } = {},
): Promise<DataMapView> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const container = db.container("governance");
  const days = options.days ?? 30;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  // Query activities
  const activityQuery = {
    query: `SELECT c.provider, c.operation, c.resourceType, c.timestamp FROM c WHERE c.type = 'data.activity' AND c.tenantId = @tenantId AND c.timestamp >= @cutoff`,
    parameters: [
      { name: "@tenantId", value: tenantId },
      { name: "@cutoff", value: cutoff },
    ],
  };
  const { resources: activities } = await container.items.query(activityQuery).fetchAll();

  // Aggregate by provider:resourceType
  const resourceMap = new Map<string, { read: number; write: number; delete: number; lastAccessed: string }>();
  for (const a of activities) {
    const key = `${a.provider}:${a.resourceType}`;
    if (!resourceMap.has(key)) {
      resourceMap.set(key, { read: 0, write: 0, delete: 0, lastAccessed: a.timestamp });
    }
    const entry = resourceMap.get(key)!;
    if (a.operation === "read" || a.operation === "list") entry.read++;
    else if (a.operation === "write") entry.write++;
    else if (a.operation === "delete") entry.delete++;
    if (a.timestamp > entry.lastAccessed) entry.lastAccessed = a.timestamp;
  }

  const sources: DataMapEntry[] = [];
  const destinations: DataMapEntry[] = [];
  for (const [key, counts] of resourceMap.entries()) {
    const [provider, resourceType] = key.split(":", 2);
    const entry: DataMapEntry = {
      provider,
      resourceType,
      readCount: counts.read,
      writeCount: counts.write,
      deleteCount: counts.delete,
      lastAccessed: counts.lastAccessed,
    };
    if (counts.read > 0) sources.push(entry);
    if (counts.write > 0 || counts.delete > 0) destinations.push(entry);
  }

  // Query LLM usage
  const llmQuery = {
    query: `SELECT c.model, c.provider, c.promptTokens, c.completionTokens FROM c WHERE c.type = 'data.llm' AND c.tenantId = @tenantId AND c.timestamp >= @cutoff`,
    parameters: [
      { name: "@tenantId", value: tenantId },
      { name: "@cutoff", value: cutoff },
    ],
  };
  const { resources: llmCalls } = await container.items.query(llmQuery).fetchAll();

  let llmUsage = null;
  if (llmCalls.length > 0) {
    llmUsage = {
      model: llmCalls[0].model,
      provider: llmCalls[0].provider,
      totalCalls: llmCalls.length,
      totalPromptTokens: llmCalls.reduce((s: number, c: { promptTokens: number }) => s + (c.promptTokens || 0), 0),
      totalCompletionTokens: llmCalls.reduce((s: number, c: { completionTokens: number }) => s + (c.completionTokens || 0), 0),
    };
  }

  // Query anomalies
  const anomalyQuery = {
    query: `SELECT * FROM c WHERE c.type = 'scope.usage' AND c.tenantId = @tenantId AND c.timestamp >= @cutoff AND ARRAY_LENGTH(c.anomalies) > 0`,
    parameters: [
      { name: "@tenantId", value: tenantId },
      { name: "@cutoff", value: cutoff },
    ],
  };
  const { resources: scopeReports } = await container.items.query(anomalyQuery).fetchAll();
  const allAnomalies = scopeReports.flatMap((r: { anomalies: AnomalyRecord[] }) => r.anomalies || []);

  // DLP violations (from lineage summaries)
  const dlpQuery = {
    query: `SELECT VALUE SUM(c.dlpViolations) FROM c WHERE c.type = 'data.lineage' AND c.tenantId = @tenantId AND c.timestamp >= @cutoff`,
    parameters: [
      { name: "@tenantId", value: tenantId },
      { name: "@cutoff", value: cutoff },
    ],
  };
  const { resources: dlpResults } = await container.items.query(dlpQuery).fetchAll();
  const dlpViolations = dlpResults[0] ?? 0;

  return {
    tenantId,
    period: { from: cutoff, to: new Date().toISOString() },
    sources: sources.sort((a, b) => b.readCount - a.readCount),
    destinations: destinations.sort((a, b) => (b.writeCount + b.deleteCount) - (a.writeCount + a.deleteCount)),
    llmUsage,
    dlpViolations,
    anomalies: allAnomalies,
  };
}

/**
 * Query anomalies across all tenants or for a specific tenant.
 */
export async function queryAnomalies(
  cosmosEndpoint: string,
  cosmosDatabase: string,
  options: { tenantId?: string; days?: number; severity?: string } = {},
): Promise<AnomalyRecord[]> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const container = db.container("governance");
  const days = options.days ?? 7;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  const tenantFilter = options.tenantId ? "AND c.tenantId = @tenantId" : "";
  const query = {
    query: `SELECT c.tenantId, c.provider, c.anomalies, c.timestamp FROM c WHERE c.type = 'scope.usage' AND c.timestamp >= @cutoff AND ARRAY_LENGTH(c.anomalies) > 0 ${tenantFilter} ORDER BY c.timestamp DESC`,
    parameters: [
      { name: "@cutoff", value: cutoff },
      ...(options.tenantId ? [{ name: "@tenantId", value: options.tenantId }] : []),
    ],
  };

  const { resources } = await container.items.query(query).fetchAll();

  const anomalies: AnomalyRecord[] = [];
  for (const r of resources) {
    for (const a of (r.anomalies || [])) {
      if (options.severity && a.severity !== options.severity) continue;
      anomalies.push({
        ...a,
        tenantId: r.tenantId,
        provider: r.provider,
      });
    }
  }

  return anomalies.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
