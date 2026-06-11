/**
 * Environment-based configuration.
 * When AZURE_COSMOS_ENDPOINT is set, the portal uses real Azure backends.
 * Otherwise, it falls back to in-memory mock data.
 */
import { env as privateEnv } from "$env/dynamic/private";

export interface PortalEnv {
  /** Cosmos DB endpoint — presence enables "live" mode */
  cosmosEndpoint: string | undefined;
  cosmosDatabase: string;

  /** Log Analytics workspace ID for querying OTel trace spans */
  logAnalyticsWorkspaceId: string | undefined;

  /** Agent Warden Server URL for provisioning/lifecycle operations */
  wardenServerUrl: string | undefined;

  /** Shared bearer token for portal->warden server calls */
  mcpAuthToken: string | undefined;

  /** Whether real backends are available */
  isLive: boolean;
}

let _env: PortalEnv | undefined;

export function getEnv(): PortalEnv {
  if (_env) return _env;

  const cosmosEndpoint = privateEnv.AZURE_COSMOS_ENDPOINT;
  const logAnalyticsWorkspaceId = privateEnv.LOG_ANALYTICS_WORKSPACE_ID;
  const wardenServerUrl = privateEnv.WARDEN_SERVER_URL;
  const mcpAuthToken = privateEnv.MCP_AUTH_TOKEN;

  _env = {
    cosmosEndpoint,
    cosmosDatabase: privateEnv.AZURE_COSMOS_DATABASE ?? "agent-warden",
    logAnalyticsWorkspaceId,
    wardenServerUrl,
    mcpAuthToken,
    isLive: !!cosmosEndpoint,
  };

  if (_env.isLive) {
    console.log("[portal] Live mode — Cosmos DB:", cosmosEndpoint);
    if (logAnalyticsWorkspaceId) console.log("[portal] Log Analytics:", logAnalyticsWorkspaceId);
    if (wardenServerUrl) console.log("[portal] Warden Server:", wardenServerUrl);
  } else {
    console.log("[portal] Demo mode — using in-memory mock data");
  }

  return _env;
}
