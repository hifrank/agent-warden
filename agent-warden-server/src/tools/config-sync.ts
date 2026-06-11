import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getCosmosDb } from "../middleware/cosmos.js";
import { envelopeDecrypt } from "../middleware/envelope-crypto.js";
import { loadConfig } from "../config/env.js";

export const execAsync = promisify(exec);

/**
 * Sync channel configuration from Cosmos DB into the pod's openclaw.json,
 * then send SIGUSR1 to the gateway process to hot-reload the config.
 *
 * Flow:
 *   1. Read telegram channel config from Cosmos tenants container
 *   2. kubectl exec to read current openclaw.json from the pod
 *   3. Merge channels.telegram into the config
 *   4. Write updated config back to the pod
 *   5. Send SIGUSR1 to PID 1 (gateway) inside the container for hot-reload
 */
export async function syncChannelConfig(
  tenantId: string,
  cosmosEndpoint: string,
  cosmosDatabase: string,
): Promise<{ synced: boolean; channels: string[] }> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const namespace = `tenant-${tenantId}`;
  const podName = `openclaw-${tenantId}-0`;
  const containerName = "openclaw-gateway";
  const configPath = "/data/state/openclaw.json";

  // 1. Read channel configs from Cosmos
  const { resources: telegramDocs } = await db
    .container("tenants")
    .items.query({
      query:
        "SELECT * FROM c WHERE c.tenantId = @tid AND c.type = 'telegram-channel'",
      parameters: [{ name: "@tid", value: tenantId }],
    })
    .fetchAll();

  const syncedChannels: string[] = [];

  // 2. Read current openclaw.json from pod; fall back to configmap if missing/corrupt
  const instanceId = `openclaw-${tenantId}`;
  let config: Record<string, unknown>;
  try {
    const { stdout: rawConfig } = await execAsync(
      `kubectl exec ${podName} -n ${namespace} -c ${containerName} -- cat ${configPath}`,
    );
    if (!rawConfig.trim()) throw new Error("empty config file");
    config = JSON.parse(rawConfig);
  } catch {
    // Config file missing or corrupt — restore from Helm configmap baseline
    const { stdout: cmJson } = await execAsync(
      `kubectl get configmap ${instanceId}-config -n ${namespace} -o jsonpath='{.data.openclaw\\.json}'`,
    );
    config = JSON.parse(cmJson);
  }

  // 2b. Always ensure the shared LiteLLM master key is set (resolve any placeholders)
  const { stdout: sharedKey } = await execAsync(
    `kubectl get secret litellm-proxy-secret -n agent-warden-system -o jsonpath='{.data.master-key}' | base64 -d`,
  );
  const masterKey = sharedKey.trim();
  const configStr = JSON.stringify(config);
  config = JSON.parse(
    configStr
      .replace(/LITELLM_MASTER_KEY_PLACEHOLDER/g, masterKey)
      .replace(/GATEWAY_TOKEN_PLACEHOLDER/g, ""),
  );
  // Also fix if apiKey is a stale per-tenant key (not the shared master key)
  const models = config.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;
  const litellm = providers?.litellm as Record<string, unknown> | undefined;
  if (litellm && litellm.apiKey !== masterKey) {
    litellm.apiKey = masterKey;
  }

  // 3. Merge telegram channel config (decrypt if encrypted)
  if (telegramDocs.length > 0) {
    const tg = telegramDocs[0];
    let plainToken = "";
    if (tg.encryptedBotToken) {
      const cfg = loadConfig();
      plainToken = await envelopeDecrypt(tg.encryptedBotToken, cfg.AZURE_KEK_VAULT_URL);
    } else if (tg.botToken) {
      plainToken = tg.botToken; // backward compat for legacy plaintext
    }
    if (plainToken) {
      if (!(config as any).channels) (config as any).channels = {};
      (config as any).channels.telegram = {
        enabled: true,
        botToken: plainToken,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        streaming: "off",
      };
      syncedChannels.push("telegram");
    }
  } else {
    // No telegram config — remove it if present
    if ((config as any).channels?.telegram) {
      delete (config as any).channels.telegram;
    }
  }

  // 4. Write updated config back to pod via base64-encoded stdin
  const updatedJson = JSON.stringify(config, null, 2);
  const b64 = Buffer.from(updatedJson).toString("base64");
  await execAsync(
    `kubectl exec ${podName} -n ${namespace} -c ${containerName} -- sh -c 'echo "${b64}" | base64 -d > ${configPath}'`,
  );

  // 5. Send SIGUSR1 to gateway process (PID 1) for hot-reload
  await execAsync(
    `kubectl exec ${podName} -n ${namespace} -c ${containerName} -- kill -USR1 1`,
  );

  return { synced: true, channels: syncedChannels };
}
