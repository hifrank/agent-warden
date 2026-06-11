/**
 * Instance service — routes to live Cosmos DB or in-memory mock data
 * based on environment configuration.
 */
import { getEnv } from "./env.js";
import { getContainer } from "./cosmos.js";
import { wardenFetch } from "./warden-client.js";
import type { InstanceRecord, FleetSummary } from "$lib/types";

// Re-export mock data for demo mode
import { instances as mockInstances } from "./data.js";

async function instancesContainer() {
  const env = getEnv();
  return getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "instances");
}

// ── List instances ──

export async function listInstances(filters?: {
  state?: string;
  tier?: string;
  region?: string;
  healthStatus?: string;
}): Promise<InstanceRecord[]> {
  const env = getEnv();

  if (!env.isLive) {
    let result = mockInstances;
    if (filters?.state) result = result.filter((i) => i.state === filters.state);
    if (filters?.tier) result = result.filter((i) => i.tier === filters.tier);
    if (filters?.region) result = result.filter((i) => i.region === filters.region);
    if (filters?.healthStatus) result = result.filter((i) => i.healthStatus === filters.healthStatus);
    return result;
  }

  const container = await instancesContainer();
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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { resources } = await container.items
    .query<InstanceRecord>({
      query: `SELECT * FROM c ${where} ORDER BY c.createdAt DESC`,
      parameters: params,
    })
    .fetchAll();

  return resources;
}

// ── Get single instance ──

export async function getInstance(tenantId: string): Promise<InstanceRecord | undefined> {
  const env = getEnv();

  if (!env.isLive) {
    return mockInstances.find((i) => i.tenantId === tenantId);
  }

  const container = await instancesContainer();
  const { resource } = await container
    .item(`oc-${tenantId}`, tenantId)
    .read<InstanceRecord>();
  return resource ?? undefined;
}

// ── Create instance (proxy to server) ──

export async function createInstance(input: {
  tenantId: string;
  adminEmail: string;
  model?: string;
  region?: string;
  channels?: { type: string; enabled: boolean }[];
}): Promise<{ tenantId: string; status: string }> {
  const env = getEnv();

  if (!env.isLive) {
    // Demo mode — push mock record locally
    const exists = mockInstances.find((i) => i.tenantId === input.tenantId);
    if (exists) throw new Error(`Instance ${input.tenantId} already exists`);
    const record: InstanceRecord = {
      tenantId: input.tenantId,
      instanceId: `oc-${input.tenantId}`,
      state: "Provisioning",
      version: "0.9.28",
      tier: "pro" as InstanceRecord["tier"],
      region: input.region ?? "eastus2",
      createdAt: new Date().toISOString(),
      activeChannels: (input.channels ?? []).filter((c) => c.enabled).map((c) => c.type),
      skillCount: 0,
      podCount: 0,
      messagesLast24h: 0,
      llmTokensLast24h: 0,
      ownerIdentity: input.adminEmail,
      tags: {},
    };
    mockInstances.push(record);
    // Simulate provisioning completing after 3 seconds
    setTimeout(() => { record.state = "Active"; record.podCount = 1; }, 3000);
    return { tenantId: input.tenantId, status: "accepted" };
  }

  // Live mode — forward to agent-warden-server
  const serverUrl = env.wardenServerUrl;
  if (!serverUrl) {
    throw new Error("WARDEN_SERVER_URL not configured; cannot provision instances");
  }

  const res = await wardenFetch(`${serverUrl}/api/tenants/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId: input.tenantId,
      adminEmail: input.adminEmail,
      model: input.model ?? "gpt-5.4",
      region: input.region ?? "eastus2",
      channels: input.channels ?? [],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Server unreachable" }));
    throw new Error(err.error ?? `Server returned ${res.status}`);
  }

  return await res.json();
}

// ── Suspend instance ──

export async function suspendInstance(tenantId: string): Promise<void> {
  const env = getEnv();

  if (!env.isLive) {
    const inst = mockInstances.find((i) => i.tenantId === tenantId);
    if (!inst) throw new Error("Not found");
    inst.state = "Suspended";
    inst.podCount = 0;
    return;
  }

  const container = await instancesContainer();
  const { resource } = await container
    .item(`oc-${tenantId}`, tenantId)
    .read<InstanceRecord>();
  if (!resource) throw new Error("Not found");
  resource.state = "Suspended";
  resource.podCount = 0;
  await container.item(resource.instanceId, tenantId).replace(resource);
}

// ── Delete instance (async — server returns 202) ──

export async function deleteInstance(tenantId: string): Promise<void> {
  const env = getEnv();

  if (!env.isLive) {
    const inst = mockInstances.find((i) => i.tenantId === tenantId);
    if (!inst) throw new Error("Not found");
    inst.state = "Deleting" as InstanceRecord["state"];
    // Simulate async cleanup completing after 5 seconds
    setTimeout(() => { inst.state = "Deleted" as InstanceRecord["state"]; }, 5000);
    return;
  }

  // Live mode — forward to server (returns 202 immediately)
  const serverUrl = env.wardenServerUrl;
  if (!serverUrl) throw new Error("WARDEN_SERVER_URL not configured");

  const res = await wardenFetch(`${serverUrl}/api/tenants/${encodeURIComponent(tenantId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
    throw new Error(err.error ?? `Delete failed: ${res.status}`);
  }
  // 202 accepted — cleanup runs async on the server
}

// ── Remove instance record (only for Deleted state) ──

export async function removeInstanceRecord(tenantId: string): Promise<void> {
  const env = getEnv();

  if (!env.isLive) {
    const idx = mockInstances.findIndex((i) => i.tenantId === tenantId);
    if (idx < 0) throw new Error("Not found");
    if (mockInstances[idx].state !== "Deleted") throw new Error("Instance is not Deleted");
    mockInstances.splice(idx, 1);
    return;
  }

  const serverUrl = env.wardenServerUrl;
  if (!serverUrl) throw new Error("WARDEN_SERVER_URL not configured");

  const res = await wardenFetch(`${serverUrl}/api/tenants/${encodeURIComponent(tenantId)}/record`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
    throw new Error(err.error ?? `Remove failed: ${res.status}`);
  }
}

// ── Fleet summary ──

export async function getFleetSummary(): Promise<FleetSummary> {
  const instances = await listInstances();
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
    avgHealthScore: 0.85,
  };
}
