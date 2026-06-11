/**
 * agent-warden-a365 — A365 Observability SDK client wrapper
 *
 * Configures the Agent 365 Observability SDK (Builder pattern) and provides
 * typed helpers for creating scopes from OpenClaw hook events.
 *
 * Token acquisition uses the T1/T2/FIC (Federated Identity Credential) flow
 * to authenticate as the agent's own identity, matching the pattern from
 * SidU/openclaw-a365's token.ts.
 *
 * SDK: @microsoft/agents-a365-observability
 * Docs: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability
 */

import {
  ObservabilityManager,
  BaggageBuilder,
  InvokeAgentScope,
  ExecuteToolScope,
  InferenceScope,
  type AgentDetails,
  type Request,
  type InvokeAgentScopeDetails,
  type ToolCallDetails,
  type InferenceDetails,
  type InferenceOperationType,
} from "@microsoft/agents-a365-observability";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

// ── Types ──

export interface A365PluginConfig {
  agentId?: string;
  agentName?: string;
  agentBlueprintId?: string;
  agentUpn?: string;
  agenticUserId?: string;
  aaInstanceId?: string;
  tenantId?: string;
  channelName?: string;
  enableA365Exporter?: boolean;
  serviceName?: string;
  serviceNamespace?: string;
}

// ── T1/T2/FIC Token Acquisition ──

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;

/**
 * Resolve T1/T2/FIC credentials from config + environment.
 * Returns null if any required credential is missing.
 */
function resolveTokenCredentials(config: A365PluginConfig) {
  const tenantId =
    config.tenantId?.trim() ||
    process.env.A365_TENANT_ID?.trim();
  const blueprintClientAppId =
    config.agentBlueprintId?.trim() ||
    process.env.A365_CLIENT_ID?.trim();
  const blueprintClientSecret =
    process.env.A365_CLIENT_SECRET?.trim();
  const aaInstanceId =
    config.aaInstanceId?.trim() ||
    process.env.A365_AA_INSTANCE_ID?.trim();
  const agentUpn =
    config.agentUpn?.trim();

  if (!tenantId || !blueprintClientAppId || !blueprintClientSecret || !aaInstanceId) {
    return null;
  }
  return { tenantId, blueprintClientAppId, blueprintClientSecret, aaInstanceId, agentUpn };
}

/**
 * Acquire a token via the T1/T2/FIC flow (Federated Identity Credentials).
 *
 * Step 1 (T1): client_credentials + fmi_path → assertion token
 * Step 2 (T2): client_assertion with T1 → AA instance token
 * Step 3 (FIC): user_fic with T1 assertion + T2 federated credential → user token
 *
 * If FIC fails (no agentUpn), falls back to client_credentials with
 * scope=https://api.powerplatform.com/.default for app-level access.
 */
async function fetchT1T2FicToken(creds: NonNullable<ReturnType<typeof resolveTokenCredentials>>): Promise<CachedToken> {
  const tokenEndpoint = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;

  // Step 1: T1 Token
  const t1Body = new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: creds.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: creds.blueprintClientSecret,
    fmi_path: creds.aaInstanceId,
  });

  console.log(`[a365] T1 request: client_id=${creds.blueprintClientAppId}, fmi_path=${creds.aaInstanceId}`);
  const t1Resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: t1Body.toString(),
  });
  if (!t1Resp.ok) {
    const errText = await t1Resp.text();
    throw new Error(`T1 token failed: ${t1Resp.status} ${errText}`);
  }
  const t1Data = (await t1Resp.json()) as { access_token: string };
  console.log("[a365] T1 token acquired");

  // Step 2: T2 Token
  const t2Body = new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: creds.aaInstanceId,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1Data.access_token,
  });

  console.log(`[a365] T2 request: client_id=${creds.aaInstanceId}`);
  const t2Resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: t2Body.toString(),
  });
  if (!t2Resp.ok) {
    const errText = await t2Resp.text();
    throw new Error(`T2 token failed: ${t2Resp.status} ${errText}`);
  }
  const t2Data = (await t2Resp.json()) as { access_token: string };
  console.log("[a365] T2 token acquired");

  // Step 3: FIC (User token) — if agentUpn is available
  if (creds.agentUpn) {
    const ficBody = new URLSearchParams({
      scope: "https://api.powerplatform.com/.default",
      client_id: creds.aaInstanceId,
      grant_type: "user_fic",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: t1Data.access_token,
      username: creds.agentUpn,
      user_federated_identity_credential: t2Data.access_token,
    });

    console.log(`[a365] FIC request: username=${creds.agentUpn}`);
    const ficResp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: ficBody.toString(),
    });
    if (ficResp.ok) {
      const ficData = (await ficResp.json()) as { access_token: string; expires_in: number };
      console.log("[a365] FIC token acquired (agent identity)");
      return {
        accessToken: ficData.access_token,
        expiresAt: Date.now() + ficData.expires_in * 1000,
      };
    }
    const ficErr = await ficResp.text();
    console.warn(`[a365] FIC failed (${ficResp.status}), falling back to client_credentials: ${ficErr.slice(0, 200)}`);
  }

  // Fallback: app-level client_credentials (no agent identity)
  const ccBody = new URLSearchParams({
    scope: "https://api.powerplatform.com/.default",
    client_id: creds.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: creds.blueprintClientSecret,
  });

  console.log("[a365] Fallback client_credentials request");
  const ccResp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: ccBody.toString(),
  });
  if (!ccResp.ok) {
    const errText = await ccResp.text();
    throw new Error(`Client credentials fallback failed: ${ccResp.status} ${errText}`);
  }
  const ccData = (await ccResp.json()) as { access_token: string; expires_in: number };
  console.log("[a365] Fallback token acquired (app-level)");
  return {
    accessToken: ccData.access_token,
    expiresAt: Date.now() + ccData.expires_in * 1000,
  };
}

/**
 * Get a valid token, using cache when possible (5-min buffer before expiry).
 * Returns the access token string, or null on failure.
 */
async function getToken(config: A365PluginConfig): Promise<string | null> {
  // Return cached token if still valid (5-min buffer)
  if (tokenCache && tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return tokenCache.accessToken;
  }

  const creds = resolveTokenCredentials(config);
  if (!creds) {
    console.warn("[a365] Cannot acquire token — missing credentials (CLIENT_ID, CLIENT_SECRET, AA_INSTANCE_ID, or TENANT_ID)");
    return null;
  }

  try {
    tokenCache = await fetchT1T2FicToken(creds);
    return tokenCache.accessToken;
  } catch (err: any) {
    console.error(`[a365] Token acquisition failed: ${err.message}`);
    tokenCache = null;
    return null;
  }
}

// ── SDK Configuration ──

let configured = false;
let savedConfig: A365PluginConfig | null = null;

/**
 * Initialize the A365 Observability SDK using ObservabilityManager (LangChain pattern).
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * Token acquisition uses T1/T2/FIC flow with credentials from config + env vars.
 * Falls back to console exporter if credentials are unavailable.
 */
export function configureA365(config: A365PluginConfig): void {
  if (configured) return;
  savedConfig = config;

  // Enable OTel diagnostic logging to catch BatchSpanProcessor/exporter errors
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

  // Determine exporter mode: check if we have credentials for T1/T2/FIC
  const creds = resolveTokenCredentials(config);
  const useA365Exporter = !!(config.enableA365Exporter && creds);

  if (!useA365Exporter) {
    process.env.ENABLE_A365_OBSERVABILITY_EXPORTER = "false";
    if (config.enableA365Exporter && !creds) {
      console.warn(
        "[a365] enableA365Exporter=true but missing credentials. Need: " +
        "A365_CLIENT_ID + A365_CLIENT_SECRET + A365_AA_INSTANCE_ID + A365_TENANT_ID. " +
        "Falling back to console exporter.",
      );
    }
  }

  const builder = ObservabilityManager.configure((b) => {
    b.withService(config.serviceName ?? "openclaw-gateway", "0.2.0")
      .withServiceNamespace(config.serviceNamespace ?? "agent-warden");

    if (useA365Exporter) {
      // tokenResolver is called by the SDK's BatchSpanProcessor before each export batch.
      // It must return a token string. We use the cached T1/T2/FIC token.
      b.withTokenResolver((_agentId: string, _tenantId: string) => {
        // SDK calls this synchronously — but our token fetch is async.
        // Pre-fetch token at startup, then return cached value here.
        // Cache refresh happens in the background via getToken().
        if (tokenCache && tokenCache.expiresAt > Date.now() + 60 * 1000) {
          return tokenCache.accessToken;
        }
        // Trigger async refresh (fire-and-forget), return stale token if available
        void getToken(config);
        return tokenCache?.accessToken ?? "";
      });
    }

    b.withCustomLogger({
      info: (msg: string, ...args: any[]) => console.log(`[a365-sdk] ${msg}`, ...args),
      warn: (msg: string, ...args: any[]) => console.warn(`[a365-sdk] ${msg}`, ...args),
      error: (msg: string, ...args: any[]) => console.error(`[a365-sdk] ${msg}`, ...args),
      event: (eventType: string, isSuccess: boolean, durationMs: number, message?: string, details?: any) => {
        const level = isSuccess ? "info" : "error";
        console[level](`[a365-sdk] event=${eventType} ok=${isSuccess} ${durationMs}ms ${message ?? ""}`, details ?? "");
      },
    });
  });

  builder.start();
  configured = true;

  // Pre-fetch token immediately so it's ready for the first export batch
  if (useA365Exporter) {
    void getToken(config).then((token) => {
      if (token) {
        console.log("[a365] Initial token acquired successfully");
      } else {
        console.error("[a365] Initial token acquisition failed — exports may fail until next retry");
      }
    });
  }

  console.log(
    `[a365] SDK configured (ObservabilityManager): service=${config.serviceName}, namespace=${config.serviceNamespace}, ` +
    `exporter=${useA365Exporter ? "a365 (T1/T2/FIC)" : "console"}`,
  );
}

// ── Agent Details Factory ──

/**
 * Build AgentDetails from plugin config.
 * These are passed to every scope and populate the required A365 attributes.
 */
export function buildAgentDetails(config: A365PluginConfig): AgentDetails {
  // agentId MUST be the blueprint app ID — it appears in the export URL path:
  // /observability/tenants/{tenantId}/agents/{agentId}/traces
  const agentId = config.agentBlueprintId ?? config.agentId ?? "openclaw-agent";
  return {
    agentId,
    agentName: config.agentName ?? "Agent Warden",
    agentDescription: "AI agent governance platform powered by OpenClaw",
    agentBlueprintId: config.agentBlueprintId,
    agentAUID: config.agenticUserId,
    agentEmail: config.agentUpn,
    tenantId: config.tenantId ?? "",
  };
}

// ── Baggage Context ──

/**
 * Set baggage context that flows through all spans in a request.
 * Call at the start of each agent invocation (before_agent_start).
 */
export function setBaggageContext(
  config: A365PluginConfig,
  conversationId?: string,
): BaggageBuilder {
  const builder = new BaggageBuilder();

  if (config.tenantId) builder.tenantId(config.tenantId);
  if (config.agentId) builder.agentId(config.agentId);
  if (conversationId) builder.conversationId(conversationId);
  if (config.channelName) builder.channelName(config.channelName);

  return builder;
}

// ── Scope Factories ──

/**
 * Start an InvokeAgentScope — wraps the entire agent invocation.
 * Maps to OpenClaw `before_agent_start` hook.
 */
export function startInvokeAgentScope(
  agentDetails: AgentDetails,
  conversationId: string,
  inputMessage: string,
  sessionId?: string,
  channelName?: string,
): InvokeAgentScope {
  const request: Request = {
    content: inputMessage,
    sessionId,
    conversationId,
    channel: channelName ? { name: channelName } : undefined,
  };

  const scopeDetails: InvokeAgentScopeDetails = {
    // endpoint is optional — set if agent has a public endpoint
  };

  return InvokeAgentScope.start(request, scopeDetails, agentDetails);
}

/**
 * Start an ExecuteToolScope — wraps a single tool execution.
 * Maps to OpenClaw `tool_result_persist` hook.
 */
export function startExecuteToolScope(
  agentDetails: AgentDetails,
  toolName: string,
  toolCallId: string,
  toolArguments: string,
  conversationId?: string,
  channelName?: string,
): ExecuteToolScope {
  const request: Request = {
    conversationId,
    channel: channelName ? { name: channelName } : undefined,
  };

  const details: ToolCallDetails = {
    toolName,
    toolType: "function",
    toolCallId,
    arguments: toolArguments,
  };

  return ExecuteToolScope.start(request, details, agentDetails);
}

/**
 * Start an InferenceScope — wraps a single LLM inference call.
 * Maps to OpenClaw `llm_input` / `llm_output` hooks.
 */
export function startInferenceScope(
  agentDetails: AgentDetails,
  model: string,
  providerName: string,
  inputMessage: string,
  conversationId?: string,
  channelName?: string,
): InferenceScope {
  const request: Request = {
    content: inputMessage,
    conversationId,
    channel: channelName ? { name: channelName } : undefined,
  };

  const details: InferenceDetails = {
    operationName: "Chat" as unknown as InferenceOperationType,
    model,
    providerName,
  };

  return InferenceScope.start(request, details, agentDetails);
}
