/**
 * Telegram channel service — routes to Cosmos DB or in-memory mock data.
 */
import { getEnv } from "./env.js";
import { getContainer } from "./cosmos.js";
import { telegramConfigs as mockConfigs } from "./data.js";
import type { TelegramChannelConfig, PairingStatus } from "$lib/types";

async function channelsContainer() {
  const env = getEnv();
  return getContainer(env.cosmosEndpoint!, env.cosmosDatabase, "tenants");
}

export async function getTelegramConfig(tenantId: string): Promise<TelegramChannelConfig> {
  const env = getEnv();

  if (!env.isLive) {
    const cfg = mockConfigs.find((c) => c.tenantId === tenantId);
    return cfg ?? { tenantId, botToken: "", pairingStatus: "pending" };
  }

  const container = await channelsContainer();
  const { resources } = await container.items
    .query<TelegramChannelConfig>({
      query: "SELECT * FROM c WHERE c.tenantId = @tid AND c.type = 'telegram-channel'",
      parameters: [{ name: "@tid", value: tenantId }],
    })
    .fetchAll();

  return resources[0] ?? { tenantId, botToken: "", pairingStatus: "pending" };
}

export async function saveTelegramConfig(
  tenantId: string,
  botToken: string,
  botUsername?: string,
): Promise<TelegramChannelConfig> {
  const env = getEnv();

  if (!env.isLive) {
    const idx = mockConfigs.findIndex((c) => c.tenantId === tenantId);
    if (idx >= 0) {
      mockConfigs[idx].botToken = botToken;
      if (botUsername) mockConfigs[idx].botUsername = botUsername;
      return mockConfigs[idx];
    }
    const newCfg: TelegramChannelConfig = {
      tenantId,
      botToken,
      botUsername,
      pairingStatus: "pending",
    };
    mockConfigs.push(newCfg);
    return newCfg;
  }

  const container = await channelsContainer();
  const existing = await getTelegramConfig(tenantId);
  const doc = {
    ...existing,
    id: `telegram-${tenantId}`,
    type: "telegram-channel",
    tenantId,
    botToken,
    botUsername: botUsername ?? existing.botUsername,
  };
  const { resource } = await container.items.upsert(doc);
  return resource as TelegramChannelConfig;
}

export async function approvePairing(
  tenantId: string,
  code: string,
): Promise<{ message: string; pairingStatus: PairingStatus; pairedAt: string }> {
  const env = getEnv();
  const pairedAt = new Date().toISOString();

  if (!env.isLive) {
    const cfg = mockConfigs.find((c) => c.tenantId === tenantId);
    if (!cfg) throw new Error("Telegram not configured for this instance");
    if (!cfg.botToken) throw new Error("Bot token must be configured before pairing");
    cfg.pairingStatus = "approved";
    cfg.pairedAt = pairedAt;
    return { message: `Pairing approved for code ${code}`, pairingStatus: "approved", pairedAt };
  }

  const container = await channelsContainer();
  const { resources } = await container.items
    .query({
      query: "SELECT * FROM c WHERE c.tenantId = @tid AND c.type = 'telegram-channel'",
      parameters: [{ name: "@tid", value: tenantId }],
    })
    .fetchAll();

  if (!resources[0]) throw new Error("Telegram not configured for this instance");
  if (!resources[0].botToken) throw new Error("Bot token must be configured before pairing");

  resources[0].pairingStatus = "approved";
  resources[0].pairedAt = pairedAt;
  await container.items.upsert(resources[0]);

  return { message: `Pairing approved for code ${code}`, pairingStatus: "approved", pairedAt };
}
