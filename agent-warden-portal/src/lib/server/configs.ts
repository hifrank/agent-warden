/**
 * Configuration files service — routes to Cosmos DB or in-memory mock data.
 */
import { getEnv } from "./env.js";
import { getContainer } from "./cosmos.js";
import { instanceConfigs as mockConfigs } from "./data.js";
import type { InstanceConfigFiles } from "$lib/types";

async function configContainer() {
  const env = getEnv();
  return getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "tenants");
}

export async function getInstanceConfig(tenantId: string): Promise<InstanceConfigFiles> {
  const env = getEnv();

  if (!env.isLive) {
    return mockConfigs[tenantId] ?? { soulMd: "", openclawMd: "" };
  }

  const container = await configContainer();
  const { resources } = await container.items
    .query<InstanceConfigFiles & { id: string; type: string }>({
      query: "SELECT * FROM c WHERE c.tenantId = @tid AND c.type = 'config-files'",
      parameters: [{ name: "@tid", value: tenantId }],
    })
    .fetchAll();

  return resources[0] ?? { soulMd: "", openclawMd: "" };
}

export async function saveInstanceConfig(
  tenantId: string,
  soulMd: string,
  openclawMd: string,
): Promise<InstanceConfigFiles> {
  const env = getEnv();

  if (!env.isLive) {
    mockConfigs[tenantId] = { soulMd, openclawMd };
    return mockConfigs[tenantId];
  }

  const container = await configContainer();
  const doc = {
    id: `config-${tenantId}`,
    type: "config-files",
    tenantId,
    soulMd,
    openclawMd,
  };
  const { resource } = await container.items.upsert(doc);
  return { soulMd: resource!.soulMd, openclawMd: resource!.openclawMd };
}
