/**
 * DLP Policies service — routes to Warden server for CRUD operations on DLP policies.
 */
import { getEnv } from "./env.js";
import { getContainer } from "./cosmos.js";
import { wardenFetch } from "./warden-client.js";
import type { DlpPolicy } from "$lib/types";

export async function listDlpPolicies(): Promise<DlpPolicy[]> {
  const env = getEnv();

  if (!env.isLive) return [];

  if (env.wardenServerUrl) {
    const res = await wardenFetch(`${env.wardenServerUrl}/api/dlp-policies`);
    if (!res.ok) return [];
    return await res.json();
  }

  const container = await getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "dlp-policies");
  const { resources } = await container.items
    .query<DlpPolicy>({ query: "SELECT * FROM c ORDER BY c.severity" })
    .fetchAll();
  return resources;
}

export async function saveDlpPolicy(policy: DlpPolicy): Promise<DlpPolicy> {
  const env = getEnv();
  if (!env.isLive) return policy;

  if (env.wardenServerUrl) {
    const res = await wardenFetch(`${env.wardenServerUrl}/api/dlp-policies/${encodeURIComponent(policy.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policy),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Save failed" }));
      throw new Error(err.error);
    }
    return await res.json();
  }

  const container = await getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "dlp-policies");
  const { resource } = await container.items.upsert(policy);
  return resource as DlpPolicy;
}

export async function createDlpPolicy(policy: DlpPolicy): Promise<DlpPolicy> {
  const env = getEnv();
  if (!env.isLive) return policy;

  if (env.wardenServerUrl) {
    const res = await wardenFetch(`${env.wardenServerUrl}/api/dlp-policies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policy),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Create failed" }));
      throw new Error(err.error);
    }
    return await res.json();
  }

  const container = await getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "dlp-policies");
  const { resource } = await container.items.upsert(policy);
  return resource as DlpPolicy;
}

export async function deleteDlpPolicy(policyId: string): Promise<void> {
  const env = getEnv();
  if (!env.isLive) return;

  if (env.wardenServerUrl) {
    const res = await wardenFetch(`${env.wardenServerUrl}/api/dlp-policies/${encodeURIComponent(policyId)}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      const err = await res.json().catch(() => ({ error: "Delete failed" }));
      throw new Error(err.error);
    }
    return;
  }

  const container = await getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "dlp-policies");
  await container.item(policyId, policyId).delete();
}
