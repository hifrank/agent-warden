import { getCosmosDb } from "../middleware/cosmos.js";
import type { InstanceRecord, AuditQueryInput } from "../config/types.js";

/**
 * List all instances with optional filters.
 */
export async function listInstances(
  cosmosEndpoint: string,
  cosmosDatabase: string,
  filters?: {
    state?: string;
    tier?: string;
    region?: string;
    healthStatus?: string;
  }
): Promise<InstanceRecord[]> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);

  const conditions: string[] = [];
  const params: { name: string; value: string }[] = [];

  if (filters?.state) {
    conditions.push("c.state = @state");
    params.push({ name: "@state", value: filters.state });
  }
  if (filters?.tier) {
    conditions.push("c.tier = @tier");
    params.push({ name: "@tier", value: filters.tier });
  }
  if (filters?.region) {
    conditions.push("c.region = @region");
    params.push({ name: "@region", value: filters.region });
  }
  if (filters?.healthStatus) {
    conditions.push("c.healthStatus = @health");
    params.push({ name: "@health", value: filters.healthStatus });
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { resources } = await db
    .container("instances")
    .items.query<InstanceRecord>({
      query: `SELECT * FROM c ${where} ORDER BY c.createdAt DESC`,
      parameters: params,
    })
    .fetchAll();

  return resources;
}

/**
 * Get a single instance by tenantId.
 */
export async function getInstance(
  tenantId: string,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<InstanceRecord | undefined> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const { resource } = await db
    .container("instances")
    .item(`oc-${tenantId}`, tenantId)
    .read<InstanceRecord>();
  return resource;
}

/**
 * Get fleet-wide summary.
 */
export async function getFleetSummary(
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<{
  total: number;
  byState: Record<string, number>;
  byTier: Record<string, number>;
  byHealth: Record<string, number>;
  avgHealthScore: number;
}> {
  const instances = await listInstances(cosmosEndpoint, cosmosDatabase);

  const byState: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const byHealth: Record<string, number> = {};

  for (const inst of instances) {
    byState[inst.state] = (byState[inst.state] ?? 0) + 1;
    byTier[inst.tier] = (byTier[inst.tier] ?? 0) + 1;
    if (inst.healthStatus) {
      byHealth[inst.healthStatus] = (byHealth[inst.healthStatus] ?? 0) + 1;
    }
  }

  return {
    total: instances.length,
    byState,
    byTier,
    byHealth,
    avgHealthScore: 0, // Populated from latest health check runs
  };
}
