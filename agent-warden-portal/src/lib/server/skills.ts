/**
 * Skills service — routes to Cosmos DB or in-memory mock data.
 */
import { getEnv } from "./env.js";
import { getContainer } from "./cosmos.js";
import { skills as mockSkills } from "./data.js";
import type { SkillRecord } from "$lib/types";

export async function listSkills(tenantId?: string): Promise<SkillRecord[]> {
  const env = getEnv();

  if (!env.isLive) {
    return tenantId ? mockSkills.filter((s) => s.tenantId === tenantId) : mockSkills;
  }

  const container = await getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "skills");
  const conditions: string[] = [];
  const params: { name: string; value: string }[] = [];

  if (tenantId) {
    conditions.push("c.tenantId = @tid");
    params.push({ name: "@tid", value: tenantId });
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { resources } = await container.items
    .query<SkillRecord>({
      query: `SELECT * FROM c ${where}`,
      parameters: params,
    })
    .fetchAll();

  return resources;
}
