/**
 * MCP servers service — queries Cosmos DB instances container or falls back to mock data.
 */
import { getEnv } from "./env.js";
import { getContainer } from "./cosmos.js";
import { mcpServers as mockServers } from "./data.js";
import type { McpServerRecord } from "$lib/types";

export async function listMcpServers(tenantId?: string): Promise<McpServerRecord[]> {
  const env = getEnv();

  if (!env.isLive) {
    return tenantId ? mockServers.filter((s) => s.tenantId === tenantId) : mockServers;
  }

  // MCP servers are stored as documents in the instances container
  // with a type discriminator
  const container = await getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "instances");
  const conditions = ["c.type = 'mcp-server'"];
  const params: { name: string; value: string }[] = [];

  if (tenantId) {
    conditions.push("c.tenantId = @tid");
    params.push({ name: "@tid", value: tenantId });
  }

  const { resources } = await container.items
    .query<McpServerRecord>({
      query: `SELECT * FROM c WHERE ${conditions.join(" AND ")}`,
      parameters: params,
    })
    .fetchAll();

  return resources;
}
