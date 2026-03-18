/**
 * Agent Identity tools for Agent Warden Server (§18.7)
 *
 * Manages Entra ID App Registrations for per-agent delegated identity.
 * Each OpenClaw agent gets its own App Registration so the user can grant
 * delegated permissions (Google Workspace, M365, Salesforce, etc.).
 */

import { DefaultAzureCredential } from "@azure/identity";
import { CosmosClient } from "@azure/cosmos";
import { Client as GraphClient } from "@microsoft/microsoft-graph-client";
// @ts-ignore — subpath import lacks exports map in v3.x
import {
  TokenCredentialAuthenticationProvider,
} from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface AgentAppRegistration {
  tenantId: string;
  appId: string;       // Application (client) ID
  objectId: string;    // Object ID of the App Registration
  displayName: string;
  redirectUri: string;
  createdAt: string;
  saasConnections: Record<string, SaaSConnection>;
}

export interface SaaSConnection {
  provider: string;
  connected: boolean;
  consentedScopes: string[];
  consentedAt: string | null;
  lastTokenRefresh: string | null;
}

export interface ProvisionIdentityInput {
  tenantId: string;
  displayName: string;
  portalBaseUrl: string;
  aksOidcIssuer: string;
}

export interface ProvisionIdentityResult {
  success: boolean;
  appRegistration: AgentAppRegistration | null;
  error?: string;
}

export interface ConnectSaaSInput {
  tenantId: string;
  provider: string;
  authorizationCode: string;
  redirectUri: string;
}

export interface ConnectSaaSResult {
  success: boolean;
  provider: string;
  scopes: string[];
  error?: string;
}

export interface ListConnectionsResult {
  tenantId: string;
  appId: string;
  connections: SaaSConnection[];
}

export interface RevokeConnectionResult {
  success: boolean;
  provider: string;
  error?: string;
}

// ────────────────────────────────────────────────────────────────────
// Graph Client Factory
// ────────────────────────────────────────────────────────────────────

function createGraphClient(): GraphClient {
  const credential = new DefaultAzureCredential();
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });
  return GraphClient.initWithMiddleware({ authProvider });
}

// ────────────────────────────────────────────────────────────────────
// Tool: Provision Agent Identity
// ────────────────────────────────────────────────────────────────────

export async function provisionAgentIdentity(
  input: ProvisionIdentityInput,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<ProvisionIdentityResult> {
  const graph = createGraphClient();

  const redirectUri = `${input.portalBaseUrl}/auth/callback/${input.tenantId}`;
  const appDisplayName = `OpenClaw Agent - ${input.displayName}`;

  try {
    // 1. Create App Registration
    const app = await graph.api("/applications").post({
      displayName: appDisplayName,
      signInAudience: "AzureADMyOrg",
      web: {
        redirectUris: [redirectUri],
        implicitGrantSettings: {
          enableIdTokenIssuance: false,
          enableAccessTokenIssuance: false,
        },
      },
      requiredResourceAccess: [
        {
          // Microsoft Graph — basic delegated permissions
          resourceAppId: "00000003-0000-0000-c000-000000000000",
          resourceAccess: [
            { id: "e1fe6dd8-ba31-4d61-89e7-88639da4683d", type: "Scope" }, // User.Read
            { id: "465a38f9-76ea-45b9-9f34-9e8b0d4b0b42", type: "Scope" }, // Calendars.ReadWrite
            { id: "570282fd-fa5c-430d-a7fd-fc8dc98a9dca", type: "Scope" }, // Mail.Read
          ],
        },
      ],
    });

    // 2. Create Federated Credential (AKS Workload Identity → App Registration)
    await graph
      .api(`/applications/${app.id}/federatedIdentityCredentials`)
      .post({
        name: `aks-wif-${input.tenantId}`,
        issuer: input.aksOidcIssuer,
        subject: `system:serviceaccount:tenant-${input.tenantId}:openclaw`,
        audiences: ["api://AzureADTokenExchange"],
      });

    // 3. Store in Cosmos DB
    const credential = new DefaultAzureCredential();
    const cosmos = new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    const container = cosmos.database(cosmosDatabase).container("tenants");

    const registration: AgentAppRegistration = {
      tenantId: input.tenantId,
      appId: app.appId,
      objectId: app.id,
      displayName: appDisplayName,
      redirectUri,
      createdAt: new Date().toISOString(),
      saasConnections: {},
    };

    // Patch the tenant record with appRegistration
    await container.item(input.tenantId, input.tenantId).patch([
      { op: "add", path: "/appRegistration", value: registration },
    ]);

    return { success: true, appRegistration: registration };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, appRegistration: null, error: message };
  }
}

// ────────────────────────────────────────────────────────────────────
// Tool: Connect SaaS Provider
// ────────────────────────────────────────────────────────────────────

export async function connectSaaSProvider(
  input: ConnectSaaSInput,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<ConnectSaaSResult> {
  // Look up the tenant's App Registration from Cosmos
  const credential = new DefaultAzureCredential();
  const cosmos = new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
  const container = cosmos.database(cosmosDatabase).container("tenants");

  try {
    const { resource: tenant } = await container
      .item(input.tenantId, input.tenantId)
      .read();

    if (!tenant?.appRegistration) {
      return {
        success: false,
        provider: input.provider,
        scopes: [],
        error: "No App Registration found for this tenant",
      };
    }

    // Exchange authorization code for tokens
    const tokenEndpoints: Record<string, string> = {
      google: "https://oauth2.googleapis.com/token",
      graph:
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      sfdc: "https://login.salesforce.com/services/oauth2/token",
      slack: "https://slack.com/api/oauth.v2.access",
      github: "https://github.com/login/oauth/access_token",
    };

    const tokenEndpoint = tokenEndpoints[input.provider];
    if (!tokenEndpoint) {
      return {
        success: false,
        provider: input.provider,
        scopes: [],
        error: `Unknown provider: ${input.provider}`,
      };
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.authorizationCode,
      redirect_uri: input.redirectUri,
      client_id: tenant.appRegistration.appId,
    });

    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      return {
        success: false,
        provider: input.provider,
        scopes: [],
        error: `Token exchange failed: ${tokenResponse.status} ${errorBody}`,
      };
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      scope?: string;
      expires_in?: number;
    };

    if (!tokenData.refresh_token) {
      return {
        success: false,
        provider: input.provider,
        scopes: [],
        error: "No refresh token returned — user may need to re-consent with offline access",
      };
    }

    // Store refresh token in Key Vault via Azure SDK
    const { SecretClient } = await import("@azure/keyvault-secrets");
    const vaultUrl = `https://kv-tenant-${input.tenantId}.vault.azure.net`;
    const secretClient = new SecretClient(vaultUrl, credential);
    await secretClient.setSecret(
      `${input.provider}-refresh`,
      tokenData.refresh_token
    );

    // Update Cosmos with connection status
    const scopes = (tokenData.scope || "").split(/[\s,]+/).filter(Boolean);
    const connection: SaaSConnection = {
      provider: input.provider,
      connected: true,
      consentedScopes: scopes,
      consentedAt: new Date().toISOString(),
      lastTokenRefresh: null,
    };

    await container.item(input.tenantId, input.tenantId).patch([
      {
        op: "add",
        path: `/appRegistration/saasConnections/${input.provider}`,
        value: connection,
      },
    ]);

    return {
      success: true,
      provider: input.provider,
      scopes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      provider: input.provider,
      scopes: [],
      error: message,
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Tool: List SaaS Connections
// ────────────────────────────────────────────────────────────────────

export async function listSaaSConnections(
  tenantId: string,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<ListConnectionsResult> {
  const credential = new DefaultAzureCredential();
  const cosmos = new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
  const container = cosmos.database(cosmosDatabase).container("tenants");

  const { resource: tenant } = await container
    .item(tenantId, tenantId)
    .read();

  const connections = tenant?.appRegistration?.saasConnections || {};

  return {
    tenantId,
    appId: tenant?.appRegistration?.appId || "",
    connections: Object.values(connections) as SaaSConnection[],
  };
}

// ────────────────────────────────────────────────────────────────────
// Tool: Revoke SaaS Connection
// ────────────────────────────────────────────────────────────────────

export async function revokeSaaSConnection(
  tenantId: string,
  provider: string,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<RevokeConnectionResult> {
  const credential = new DefaultAzureCredential();

  try {
    // 1. Delete the refresh token from Key Vault
    const { SecretClient } = await import("@azure/keyvault-secrets");
    const vaultUrl = `https://kv-tenant-${tenantId}.vault.azure.net`;
    const secretClient = new SecretClient(vaultUrl, credential);

    try {
      const poller = await secretClient.beginDeleteSecret(`${provider}-refresh`);
      await poller.pollUntilDone();
    } catch {
      // Secret may not exist — that's fine
    }

    // 2. Update Cosmos
    const cosmos = new CosmosClient({
      endpoint: cosmosEndpoint,
      aadCredentials: credential,
    });
    const container = cosmos.database(cosmosDatabase).container("tenants");

    await container.item(tenantId, tenantId).patch([
      {
        op: "remove",
        path: `/appRegistration/saasConnections/${provider}`,
      },
    ]);

    return { success: true, provider };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, provider, error: message };
  }
}
