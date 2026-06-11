/**
 * E5 Graph Client — cross-tenant Graph API operations.
 *
 * Uses the E5 Admin App credentials (ClientSecretCredential) to create
 * per-agent Entra app registrations in the E5 tenant for DLP processContent.
 */

import { ClientSecretCredential } from "@azure/identity";
import { Client as GraphClient } from "@microsoft/microsoft-graph-client";
// @ts-ignore — subpath import lacks exports map in v3.x
import {
  TokenCredentialAuthenticationProvider,
} from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import { envelopeDecrypt, envelopeEncrypt } from "../middleware/envelope-crypto.js";

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface DlpAppRegistration {
  e5TenantId: string;
  appId: string;
  objectId: string;
  displayName: string;
  encryptedClientSecret: {
    data: string;
    vault: string;
    kekName: string;
  };
  createdAt: string;
}

interface AdminAppConfig {
  clientId: string;
  encryptedClientSecret: {
    data: string;
    vault: string;
    kekName: string;
  };
}

// ────────────────────────────────────────────────────────────────────
// Graph Client Factory (cross-tenant via ClientSecretCredential)
// ────────────────────────────────────────────────────────────────────

function createE5GraphClient(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): GraphClient {
  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });
  return GraphClient.initWithMiddleware({ authProvider });
}

// ────────────────────────────────────────────────────────────────────
// Provision DLP App Registration in E5 Tenant
// ────────────────────────────────────────────────────────────────────

export async function provisionDlpAppRegistration(
  instanceId: string,
  e5TenantId: string,
  adminApp: AdminAppConfig,
  kekVaultUrl: string,
): Promise<DlpAppRegistration> {
  // 1. Decrypt admin app secret
  const adminSecret = await envelopeDecrypt(adminApp.encryptedClientSecret, kekVaultUrl);

  // 2. Create Graph client authenticated to E5 tenant
  const graph = createE5GraphClient(e5TenantId, adminApp.clientId, adminSecret);

  const appDisplayName = `openclaw-${instanceId}-dlp`;

  // 3. Create App Registration with DLP permissions
  const app = await graph.api("/applications").post({
    displayName: appDisplayName,
    signInAudience: "AzureADMyOrg",
    requiredResourceAccess: [
      {
        // Microsoft Graph
        resourceAppId: "00000003-0000-0000-c000-000000000000",
        resourceAccess: [
          // InformationProtectionPolicy.Read.All (Application)
          { id: "19da66cb-0571-4f3b-b25e-38e40acb57a3", type: "Role" },
          // InformationProtectionContent.Write.All (Application)
          { id: "287bd946-c396-4720-a609-b99db14bba97", type: "Role" },
          // ContentActivity.Write (Application)
          { id: "2f442609-59f3-4024-82fa-5ba9a5e0e829", type: "Role" },
        ],
      },
    ],
  });

  // 4. Create a client secret for the new app
  const passwordResult = await graph
    .api(`/applications/${app.id}/addPassword`)
    .post({
      passwordCredential: {
        displayName: "agent-warden-auto",
        endDateTime: new Date(Date.now() + 730 * 86400000).toISOString(), // 2 years
      },
    });

  // 5. Encrypt the client secret with KEK
  const encryptedClientSecret = await envelopeEncrypt(
    passwordResult.secretText,
    kekVaultUrl,
    `kek-${instanceId}`,
  );

  return {
    e5TenantId,
    appId: app.appId,
    objectId: app.id,
    displayName: appDisplayName,
    encryptedClientSecret,
    createdAt: new Date().toISOString(),
  };
}
