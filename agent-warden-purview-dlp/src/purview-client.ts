/**
 * Microsoft Purview Graph API client — calls processContent for DLP evaluation.
 *
 * API: POST /users/{userId}/dataSecurityAndGovernance/processContent
 * Docs: https://learn.microsoft.com/en-us/graph/api/userdatasecurityandgovernance-processcontent
 *
 * Auth:
 *   Same-tenant: Managed Identity → DefaultAzureCredential
 *   Cross-tenant: ClientSecretCredential (multi-tenant app registration)
 */

import { DefaultAzureCredential, ClientSecretCredential, type TokenCredential } from "@azure/identity";
import { spawnSync } from "node:child_process";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export interface PurviewConfig {
  appName: string;
  appVersion: string;
  userId?: string; // Entra user ID — required for app-only auth (MI); /me/ used if omitted
  // Cross-tenant auth (reads from env vars PURVIEW_DLP_CLIENT_ID, PURVIEW_DLP_CLIENT_SECRET, PURVIEW_DLP_TENANT_ID)
  crossTenant?: boolean;
}

export type PurviewAction =
  | { action: "restrictAccess"; restrictionAction: string }
  | { action: "restrictWebGrounding" }
  | { action: string };

export interface ProcessContentResult {
  allowed: boolean;
  actions: PurviewAction[];
  errors: string[];
}

export class PurviewClient {
  private credential: TokenCredential;
  private cfg: PurviewConfig;
  private cachedToken: { token: string; expiresOn: number } | null = null;

  constructor(cfg: PurviewConfig, credential?: TokenCredential) {
    this.cfg = cfg;
    if (credential) {
      this.credential = credential;
    } else if (cfg.crossTenant) {
      const clientId = process.env.PURVIEW_DLP_CLIENT_ID;
      const clientSecret = process.env.PURVIEW_DLP_CLIENT_SECRET;
      const tenantId = process.env.PURVIEW_DLP_TENANT_ID;
      if (!clientId || !clientSecret || !tenantId) {
        throw new Error("Cross-tenant auth requires PURVIEW_DLP_CLIENT_ID, PURVIEW_DLP_CLIENT_SECRET, PURVIEW_DLP_TENANT_ID env vars");
      }
      this.credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
      console.log(`[purview-dlp] Using ClientSecretCredential for tenant ${tenantId}`);
    } else {
      this.credential = new DefaultAzureCredential();
    }
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresOn > now + 60_000) {
      return this.cachedToken.token;
    }
    const result = await this.credential.getToken(GRAPH_SCOPE);
    if (!result) throw new Error("Failed to acquire Graph token via MI");
    this.cachedToken = { token: result.token, expiresOn: result.expiresOnTimestamp };
    return result.token;
  }

  /**
   * Call processContent API to evaluate text content against DLP policies.
   * Uses /me endpoint with delegated permission, or /users/{id} with app permission.
   */
  async processContent(
    text: string,
    activity: "uploadText" | "downloadText" = "uploadText",
  ): Promise<ProcessContentResult> {
    const token = await this.getToken();

    const body = {
      contentToProcess: {
        contentEntries: [
          {
            "@odata.type": "microsoft.graph.processConversationMetadata",
            identifier: crypto.randomUUID(),
            content: {
              "@odata.type": "microsoft.graph.textContent",
              data: text,
            },
            name: "Agent Warden DLP scan",
            correlationId: crypto.randomUUID(),
            sequenceNumber: 0,
            isTruncated: text.length > 50_000,
            createdDateTime: new Date().toISOString(),
            modifiedDateTime: new Date().toISOString(),
          },
        ],
        activityMetadata: { activity },
        deviceMetadata: {
          deviceType: "Managed",
          operatingSystemSpecifications: {
            operatingSystemPlatform: "Linux",
            operatingSystemVersion: "AKS",
          },
        },
        protectedAppMetadata: {
          name: this.cfg.appName,
          version: this.cfg.appVersion,
          applicationLocation: {
            "@odata.type": "#microsoft.graph.policyLocationApplication",
            value: this.cfg.crossTenant ? (process.env.PURVIEW_DLP_CLIENT_ID ?? this.cfg.appName) : this.cfg.appName,
          },
        },
        integratedAppMetadata: {
          name: this.cfg.appName,
          version: this.cfg.appVersion,
        },
      },
    };

    const basePath = this.cfg.userId
      ? `https://graph.microsoft.com/v1.0/users/${this.cfg.userId}/dataSecurityAndGovernance/processContent`
      : "https://graph.microsoft.com/v1.0/me/dataSecurityAndGovernance/processContent";

    const resp = await fetch(
      basePath,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`[purview-dlp] processContent failed: ${resp.status} ${errText}`);
      // Fail open — don't block LLM if Purview is unavailable
      return { allowed: true, actions: [], errors: [`HTTP ${resp.status}: ${errText}`] };
    }

    const data = (await resp.json()) as {
      policyActions?: PurviewAction[];
      processingErrors?: Array<{ message?: string }>;
    };

    const actions = data.policyActions ?? [];
    const errors = (data.processingErrors ?? []).map((e) => e.message ?? "unknown error");
    const blocked = actions.some(
      (a) => a.action === "restrictAccess" || a.action === "block",
    );

    return { allowed: !blocked, actions, errors };
  }

  /**
   * Synchronous version of processContent — for use in synchronous hooks (tool_result_persist).
   * Uses spawnSync + curl to make blocking HTTP calls.
   * Token is cached and shared with the async version.
   */
  processContentSync(
    text: string,
    activity: "uploadText" | "downloadText" = "downloadText",
  ): ProcessContentResult {
    const token = this.getTokenSync();
    if (!token) {
      console.error("[purview-dlp] processContentSync: failed to acquire token");
      return { allowed: true, actions: [], errors: ["token acquisition failed"] };
    }

    const basePath = this.cfg.userId
      ? `https://graph.microsoft.com/v1.0/users/${this.cfg.userId}/dataSecurityAndGovernance/processContent`
      : "https://graph.microsoft.com/v1.0/me/dataSecurityAndGovernance/processContent";

    const body = JSON.stringify({
      contentToProcess: {
        contentEntries: [
          {
            "@odata.type": "microsoft.graph.processConversationMetadata",
            identifier: crypto.randomUUID(),
            content: {
              "@odata.type": "microsoft.graph.textContent",
              data: text,
            },
            name: "Agent Warden DLP scan",
            correlationId: crypto.randomUUID(),
            sequenceNumber: 0,
            isTruncated: text.length > 50_000,
            createdDateTime: new Date().toISOString(),
            modifiedDateTime: new Date().toISOString(),
          },
        ],
        activityMetadata: { activity },
        deviceMetadata: {
          deviceType: "Managed",
          operatingSystemSpecifications: {
            operatingSystemPlatform: "Linux",
            operatingSystemVersion: "AKS",
          },
        },
        protectedAppMetadata: {
          name: this.cfg.appName,
          version: this.cfg.appVersion,
          applicationLocation: {
            "@odata.type": "#microsoft.graph.policyLocationApplication",
            value: this.cfg.crossTenant ? (process.env.PURVIEW_DLP_CLIENT_ID ?? this.cfg.appName) : this.cfg.appName,
          },
        },
        integratedAppMetadata: {
          name: this.cfg.appName,
          version: this.cfg.appVersion,
        },
      },
    });

    const result = spawnSync("curl", [
      "-s", "-X", "POST", basePath,
      "-H", `Authorization: Bearer ${token}`,
      "-H", "Content-Type: application/json",
      "--data-binary", "@-",
      "--max-time", "10",
    ], { input: body, encoding: "utf-8", timeout: 15_000 });

    if (result.error || result.status !== 0) {
      console.error(`[purview-dlp] processContentSync curl failed: ${result.error ?? result.stderr}`);
      return { allowed: true, actions: [], errors: ["curl failed"] };
    }

    try {
      const data = JSON.parse(result.stdout) as {
        policyActions?: PurviewAction[];
        processingErrors?: Array<{ message?: string }>;
        error?: { code?: string; message?: string };
      };

      if (data.error) {
        console.error(`[purview-dlp] processContentSync API error: ${data.error.message}`);
        return { allowed: true, actions: [], errors: [data.error.message ?? "API error"] };
      }

      const actions = data.policyActions ?? [];
      const errors = (data.processingErrors ?? []).map((e) => e.message ?? "unknown error");
      const blocked = actions.some(
        (a) => a.action === "restrictAccess" || a.action === "block",
      );
      return { allowed: !blocked, actions, errors };
    } catch {
      console.error(`[purview-dlp] processContentSync parse failed: ${result.stdout.slice(0, 200)}`);
      return { allowed: true, actions: [], errors: ["response parse failed"] };
    }
  }

  /**
   * Synchronous token acquisition using curl to the OAuth2 token endpoint.
   * Falls back to cached token when available.
   */
  private getTokenSync(): string | null {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresOn > now + 60_000) {
      return this.cachedToken.token;
    }

    const tenantId = process.env.PURVIEW_DLP_TENANT_ID;
    const clientId = process.env.PURVIEW_DLP_CLIENT_ID;
    const clientSecret = process.env.PURVIEW_DLP_CLIENT_SECRET;
    if (!tenantId || !clientId || !clientSecret) {
      console.error("[purview-dlp] getTokenSync: missing cross-tenant env vars");
      return null;
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const formBody = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&scope=${encodeURIComponent("https://graph.microsoft.com/.default")}&grant_type=client_credentials`;

    const result = spawnSync("curl", [
      "-s", "-X", "POST", tokenUrl,
      "-H", "Content-Type: application/x-www-form-urlencoded",
      "--data-binary", "@-",
      "--max-time", "10",
    ], { input: formBody, encoding: "utf-8", timeout: 15_000 });

    if (result.error || result.status !== 0) {
      console.error(`[purview-dlp] getTokenSync curl failed: ${result.error ?? result.stderr}`);
      return null;
    }

    try {
      const data = JSON.parse(result.stdout) as { access_token?: string; expires_in?: number };
      if (!data.access_token) {
        console.error(`[purview-dlp] getTokenSync: no access_token in response`);
        return null;
      }
      this.cachedToken = {
        token: data.access_token,
        expiresOn: now + (data.expires_in ?? 3600) * 1000,
      };
      return data.access_token;
    } catch {
      console.error(`[purview-dlp] getTokenSync parse failed: ${result.stdout.slice(0, 200)}`);
      return null;
    }
  }
}
