/**
 * Microsoft Purview Graph API client — calls processContent for DLP evaluation.
 *
 * API: POST /users/{userId}/dataSecurityAndGovernance/processContent
 * API: POST /users/{userId}/dataSecurityAndGovernance/protectionScopes/compute
 * API: POST /users/{userId}/dataSecurityAndGovernance/contentActivities
 * Docs: https://learn.microsoft.com/en-us/purview/developer/use-the-api
 *
 * Auth:
 *   Same-tenant: Managed Identity → DefaultAzureCredential
 *   Cross-tenant: ClientSecretCredential (multi-tenant app registration)
 *
 * executionMode-driven scanning:
 *   evaluateInline  → sync processContent (block main thread)
 *   evaluateOffline → async processContent (non-blocking)
 *   (no scope)      → skip scanning, log via contentActivities
 */

import { DefaultAzureCredential, ClientSecretCredential, type TokenCredential } from "@azure/identity";
import { spawnSync } from "node:child_process";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const SCOPE_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes per API recommendation

// ── Types ──

export interface PurviewConfig {
  appName: string;
  appVersion: string;
  userId?: string; // Entra user ID — required for app-only auth (MI); /me/ used if omitted
  appId?: string;  // Entra app registration ID for policyLocationApplication
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
  /** If true, protection scopes changed — caller should re-compute */
  scopesModified?: boolean;
}

export type ExecutionMode = "evaluateInline" | "evaluateOffline" | "none";

export interface ProtectionScope {
  activities: string;
  executionMode: "evaluateInline" | "evaluateOffline";
  policyActions: PurviewAction[];
}

export interface ScopeCache {
  scopes: ProtectionScope[];
  etag: string;
  fetchedAt: number;
}

/** Options to pass per-conversation context into processContent calls. */
export interface ContentContext {
  correlationId: string;
  sequenceNumber: number;
}

export class PurviewClient {
  private credential: TokenCredential;
  private cfg: PurviewConfig;
  private cachedToken: { token: string; expiresOn: number } | null = null;
  private scopeCache: ScopeCache | null = null;
  private scopesFailed = false;
  /** Fallback executionMode when protectionScopes/compute is unavailable (e.g. missing permission). */
  defaultExecutionMode: ExecutionMode = "evaluateInline";

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

  // ── Graph Base Path ──

  private get userPath(): string {
    return this.cfg.userId
      ? `https://graph.microsoft.com/v1.0/users/${this.cfg.userId}`
      : "https://graph.microsoft.com/v1.0/me";
  }

  private get appLocationValue(): string {
    return this.cfg.appId
      ?? (this.cfg.crossTenant ? (process.env.PURVIEW_DLP_CLIENT_ID ?? this.cfg.appName) : this.cfg.appName);
  }

  // ── Token Management ──

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
        console.error("[purview-dlp] getTokenSync: no access_token in response");
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

  // ── Phase 1: Protection Scopes ──

  /**
   * Compute protection scopes for the current user to determine which activities
   * need inline vs offline evaluation. Caches results for 60 minutes.
   * Returns cached scopes if still fresh.
   */
  async computeProtectionScopes(
    activities: string = "uploadText,downloadText",
  ): Promise<ProtectionScope[]> {
    // Return cached if still fresh
    if (this.scopeCache && Date.now() - this.scopeCache.fetchedAt < SCOPE_CACHE_TTL_MS) {
      return this.scopeCache.scopes;
    }

    const token = await this.getToken();
    const url = `${this.userPath}/dataSecurityAndGovernance/protectionScopes/compute`;

    const body = {
      activities,
      locations: [
        {
          "@odata.type": "microsoft.graph.policyLocationApplication",
          value: this.appLocationValue,
        },
      ],
    };

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error(`[purview-dlp] protectionScopes/compute failed: ${resp.status} ${errText}`);
        this.scopesFailed = true;
        return this.scopeCache?.scopes ?? [];
      }

      const data = (await resp.json()) as {
        value?: ProtectionScope[];
      };

      const etag = resp.headers.get("ETag") ?? "";
      const scopes = data.value ?? [];

      this.scopeCache = { scopes, etag, fetchedAt: Date.now() };
      console.log(
        `[purview-dlp] protectionScopes/compute: ${scopes.length} scope(s), etag=${etag.slice(0, 16)}`,
      );

      return scopes;
    } catch (err) {
      console.error(`[purview-dlp] protectionScopes/compute error: ${err}`);
      this.scopesFailed = true;
      return this.scopeCache?.scopes ?? [];
    }
  }

  /** Invalidate the scope cache (e.g. after protectionScopeState: "modified"). */
  invalidateScopeCache(): void {
    this.scopeCache = null;
  }

  /** Get the current cached ETag for use in processContent If-None-Match header. */
  get scopeEtag(): string {
    return this.scopeCache?.etag ?? "";
  }

  /**
   * Resolve the most restrictive executionMode for a given activity.
   * If the activity appears in multiple scopes, evaluateInline wins over evaluateOffline.
   * Returns "none" if no scope covers this activity.
   */
  getExecutionMode(activity: string): ExecutionMode {
    if (!this.scopeCache) {
      // Scopes not loaded: if failed (403/error), use fallback; if not yet attempted, skip
      return this.scopesFailed ? this.defaultExecutionMode : "none";
    }
    if (this.scopeCache.scopes.length === 0) {
      // Scopes loaded but empty — no policies apply. Use fallback if scopes failed before.
      return this.scopesFailed ? this.defaultExecutionMode : "none";
    }

    let mode: ExecutionMode = "none";

    for (const scope of this.scopeCache.scopes) {
      const activities = scope.activities.split(",").map((a) => a.trim());
      if (!activities.includes(activity)) continue;

      if (scope.executionMode === "evaluateInline") {
        return "evaluateInline"; // most restrictive — return immediately
      }
      if (scope.executionMode === "evaluateOffline") {
        mode = "evaluateOffline";
      }
    }

    return mode;
  }

  // ── Phase 2 + 5: processContent with ETag, scopeState, correlationId ──

  /**
   * Call processContent API to evaluate text content against DLP policies.
   * Sends cached ETag in If-None-Match header. Handles protectionScopeState.
   */
  async processContent(
    text: string,
    activity: "uploadText" | "downloadText" = "uploadText",
    ctx?: ContentContext,
  ): Promise<ProcessContentResult> {
    const token = await this.getToken();

    const body = this.buildProcessContentBody(text, activity, ctx);
    const url = `${this.userPath}/dataSecurityAndGovernance/processContent`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (this.scopeEtag) {
      headers["If-None-Match"] = this.scopeEtag;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`[purview-dlp] processContent failed: ${resp.status} ${errText}`);
      return { allowed: true, actions: [], errors: [`HTTP ${resp.status}: ${errText}`] };
    }

    const data = (await resp.json()) as {
      policyActions?: PurviewAction[];
      processingErrors?: Array<{ message?: string }>;
      protectionScopeState?: string;
    };

    const scopesModified = data.protectionScopeState === "modified";
    if (scopesModified) {
      console.log("[purview-dlp] protectionScopeState=modified — invalidating scope cache");
      this.invalidateScopeCache();
    }

    const actions = data.policyActions ?? [];
    const errors = (data.processingErrors ?? []).map((e) => e.message ?? "unknown error");
    const blocked = actions.some(
      (a) => a.action === "restrictAccess" || a.action === "block",
    );

    return { allowed: !blocked, actions, errors, scopesModified };
  }

  /**
   * Synchronous version of processContent — for use in synchronous hooks (tool_result_persist).
   * Uses spawnSync + curl to make blocking HTTP calls.
   */
  processContentSync(
    text: string,
    activity: "uploadText" | "downloadText" = "downloadText",
    ctx?: ContentContext,
  ): ProcessContentResult {
    const token = this.getTokenSync();
    if (!token) {
      console.error("[purview-dlp] processContentSync: failed to acquire token");
      return { allowed: true, actions: [], errors: ["token acquisition failed"] };
    }

    const url = `${this.userPath}/dataSecurityAndGovernance/processContent`;
    const body = JSON.stringify(this.buildProcessContentBody(text, activity, ctx));

    const curlHeaders = [
      "-H", `Authorization: Bearer ${token}`,
      "-H", "Content-Type: application/json",
    ];
    if (this.scopeEtag) {
      curlHeaders.push("-H", `If-None-Match: ${this.scopeEtag}`);
    }

    const result = spawnSync("curl", [
      "-s", "-X", "POST", url,
      ...curlHeaders,
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
        protectionScopeState?: string;
        error?: { code?: string; message?: string };
      };

      if (data.error) {
        console.error(`[purview-dlp] processContentSync API error: ${data.error.message}`);
        return { allowed: true, actions: [], errors: [data.error.message ?? "API error"] };
      }

      const scopesModified = data.protectionScopeState === "modified";
      if (scopesModified) {
        console.log("[purview-dlp] protectionScopeState=modified — invalidating scope cache");
        this.invalidateScopeCache();
      }

      const actions = data.policyActions ?? [];
      const errors = (data.processingErrors ?? []).map((e) => e.message ?? "unknown error");
      const blocked = actions.some(
        (a) => a.action === "restrictAccess" || a.action === "block",
      );
      return { allowed: !blocked, actions, errors, scopesModified };
    } catch {
      console.error(`[purview-dlp] processContentSync parse failed: ${result.stdout.slice(0, 200)}`);
      return { allowed: true, actions: [], errors: ["response parse failed"] };
    }
  }

  // ── Phase 4: Content Activity Logging ──

  /**
   * Log a content activity for audit compliance when no protection scopes apply.
   * Per API recommendation, activities should still be logged for anomaly detection.
   */
  async logContentActivity(
    text: string,
    activity: "uploadText" | "downloadText",
    ctx?: ContentContext,
  ): Promise<void> {
    try {
      const token = await this.getToken();
      const url = `${this.userPath}/dataSecurityAndGovernance/contentActivities`;

      const body = {
        contentToProcess: {
          contentEntries: [
            {
              "@odata.type": "microsoft.graph.processConversationMetadata",
              identifier: crypto.randomUUID(),
              content: {
                "@odata.type": "microsoft.graph.textContent",
                data: text.slice(0, 50_000),
              },
              name: "Agent Warden DLP audit",
              correlationId: ctx?.correlationId ?? crypto.randomUUID(),
              sequenceNumber: ctx?.sequenceNumber ?? 0,
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
              value: this.appLocationValue,
            },
          },
          integratedAppMetadata: {
            name: this.cfg.appName,
            version: this.cfg.appVersion,
          },
        },
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error(`[purview-dlp] contentActivities failed: ${resp.status} ${errText}`);
      } else {
        console.log(`[purview-dlp] contentActivities logged: activity=${activity}`);
      }
    } catch (err) {
      console.error(`[purview-dlp] contentActivities error: ${err}`);
    }
  }

  // ── Shared Body Builder ──

  private buildProcessContentBody(
    text: string,
    activity: "uploadText" | "downloadText",
    ctx?: ContentContext,
  ) {
    return {
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
            correlationId: ctx?.correlationId ?? crypto.randomUUID(),
            sequenceNumber: ctx?.sequenceNumber ?? 0,
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
            value: this.appLocationValue,
          },
        },
        integratedAppMetadata: {
          name: this.cfg.appName,
          version: this.cfg.appVersion,
        },
      },
    };
  }
}
