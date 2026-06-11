/**
 * Global settings service — routes to Warden server or falls back to Cosmos directly.
 */
import { getEnv } from "./env.js";
import { getContainer } from "./cosmos.js";
import { wardenFetch } from "./warden-client.js";
import type { GlobalSettings } from "$lib/types";

export async function getGlobalSettings(): Promise<GlobalSettings | null> {
  const env = getEnv();

  if (!env.isLive) {
    return null;
  }

  // Route through warden server if available
  if (env.wardenServerUrl) {
    const res = await wardenFetch(`${env.wardenServerUrl}/api/settings/global`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.computeTenant ? data : null;
  }

  // Direct Cosmos fallback
  const container = await getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "settings");
  try {
    const { resource } = await container.item("global", "global").read();
    return resource ?? null;
  } catch {
    return null;
  }
}

export async function saveGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings> {
  const env = getEnv();

  if (!env.isLive) {
    return settings;
  }

  if (env.wardenServerUrl) {
    const res = await wardenFetch(`${env.wardenServerUrl}/api/settings/global`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Save failed" }));
      throw new Error(err.error);
    }
    return await res.json();
  }

  // Direct Cosmos fallback
  const container = await getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "settings");
  const doc = {
    id: "global",
    partitionKey: "global",
    ...settings,
    updatedAt: new Date().toISOString(),
  };
  await container.items.upsert(doc);
  return settings;
}
