/**
 * Sentinel SaaS Auth Proxy — Sidecar for OpenClaw tenant pods (§18.7)
 *
 * Intercepts outbound SaaS API calls from Pi Agent, injects OAuth tokens,
 * enforces path-level policies, and logs every request for audit.
 *
 * Pi Agent → http://localhost:9090/{provider}/{path}
 * Proxy   → https://{saas-api-host}/{path} with Authorization header
 */

import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

// ──────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.SAAS_PROXY_PORT || "9090", 10);
const SECRETS_DIR = process.env.SECRETS_DIR || "/mnt/secrets";
const TENANT_ID = process.env.TENANT_ID || "";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const POLICY_PATH = process.env.SAAS_POLICY_PATH || "/etc/saas-proxy/policy.json";
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || "";
const COSMOS_DATABASE = process.env.COSMOS_DATABASE || "agent-warden";
const COSMOS_CONTAINER = "governance";

// ──────────────────────────────────────────────────────────
// SaaS Provider Registry
// ──────────────────────────────────────────────────────────

interface ProviderConfig {
  /** Host for the upstream SaaS API */
  apiHost: string;
  /** Key Vault secret name prefix for the refresh token */
  secretName: string;
  /** OAuth2 token endpoint for refresh_token grant */
  tokenEndpoint: string;
  /** Client ID env var or path */
  clientIdEnvVar: string;
  /** Scopes to request on refresh (space-separated) */
  defaultScopes: string;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  google: {
    apiHost: "www.googleapis.com",
    secretName: "google-refresh",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    clientIdEnvVar: "GOOGLE_CLIENT_ID",
    defaultScopes: "",
  },
  graph: {
    apiHost: "graph.microsoft.com",
    secretName: "graph-refresh",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientIdEnvVar: "GRAPH_CLIENT_ID",
    defaultScopes: "offline_access",
  },
  sfdc: {
    apiHost: "login.salesforce.com",
    secretName: "sfdc-refresh",
    tokenEndpoint: "https://login.salesforce.com/services/oauth2/token",
    clientIdEnvVar: "SFDC_CLIENT_ID",
    defaultScopes: "",
  },
  slack: {
    apiHost: "slack.com",
    secretName: "slack-token",
    tokenEndpoint: "", // Slack uses bot token directly, no refresh
    clientIdEnvVar: "SLACK_CLIENT_ID",
    defaultScopes: "",
  },
  github: {
    apiHost: "api.github.com",
    secretName: "github-token",
    tokenEndpoint: "", // GitHub App tokens or PATs, no standard refresh
    clientIdEnvVar: "GITHUB_CLIENT_ID",
    defaultScopes: "",
  },
};

// ──────────────────────────────────────────────────────────
// Route Classification Table (§4 Activity Ledger)
//
// Maps (provider, method, pathPattern) → (operation, resourceType)
// Used to enrich data.activity events with semantic metadata.
// ──────────────────────────────────────────────────────────

interface RouteClassification {
  provider: string;
  method: string;        // HTTP method or "*" for any
  pathPattern: RegExp;   // Match against the API path
  operation: "read" | "write" | "delete" | "list";
  resourceType: string;  // Semantic resource type (e.g. "gmail.message")
}

const ROUTE_CLASSIFICATIONS: RouteClassification[] = [
  // ── Google ──
  { provider: "google", method: "GET",    pathPattern: /^\/gmail\/v1\/users\/[^/]+\/messages\/[^/]+$/,     operation: "read",   resourceType: "gmail.message" },
  { provider: "google", method: "GET",    pathPattern: /^\/gmail\/v1\/users\/[^/]+\/messages$/,            operation: "list",   resourceType: "gmail.message" },
  { provider: "google", method: "POST",   pathPattern: /^\/gmail\/v1\/users\/[^/]+\/messages\/send$/,      operation: "write",  resourceType: "gmail.message" },
  { provider: "google", method: "GET",    pathPattern: /^\/calendar\/v3\/calendars\/[^/]+\/events/,        operation: "list",   resourceType: "calendar.event" },
  { provider: "google", method: "POST",   pathPattern: /^\/calendar\/v3\/calendars\/[^/]+\/events$/,       operation: "write",  resourceType: "calendar.event" },
  { provider: "google", method: "GET",    pathPattern: /^\/drive\/v3\/files\/[^/]+$/,                      operation: "read",   resourceType: "drive.file" },
  { provider: "google", method: "GET",    pathPattern: /^\/drive\/v3\/files$/,                             operation: "list",   resourceType: "drive.file" },
  { provider: "google", method: "POST",   pathPattern: /^\/drive\/v3\/files/,                              operation: "write",  resourceType: "drive.file" },
  { provider: "google", method: "GET",    pathPattern: /^\/v4\/spreadsheets\/[^/]+$/,                      operation: "read",   resourceType: "sheets.spreadsheet" },
  { provider: "google", method: "POST",   pathPattern: /^\/v4\/spreadsheets\/[^/]+\/values/,               operation: "write",  resourceType: "sheets.spreadsheet" },
  { provider: "google", method: "GET",    pathPattern: /^\/v4\/spreadsheets\/[^/]+\/values/,               operation: "read",   resourceType: "sheets.spreadsheet" },

  // ── Microsoft Graph ──
  { provider: "graph",  method: "GET",    pathPattern: /^\/v1\.0\/me\/messages\/[^/]+$/,                   operation: "read",   resourceType: "outlook.message" },
  { provider: "graph",  method: "GET",    pathPattern: /^\/v1\.0\/me\/messages$/,                          operation: "list",   resourceType: "outlook.message" },
  { provider: "graph",  method: "POST",   pathPattern: /^\/v1\.0\/me\/sendMail$/,                          operation: "write",  resourceType: "outlook.message" },
  { provider: "graph",  method: "GET",    pathPattern: /^\/v1\.0\/me\/events/,                             operation: "list",   resourceType: "outlook.event" },
  { provider: "graph",  method: "GET",    pathPattern: /^\/v1\.0\/me\/drive\/items/,                       operation: "read",   resourceType: "onedrive.file" },
  { provider: "graph",  method: "PUT",    pathPattern: /^\/v1\.0\/me\/drive\/items/,                       operation: "write",  resourceType: "onedrive.file" },

  // ── GitHub ──
  { provider: "github", method: "GET",    pathPattern: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/,            operation: "read",   resourceType: "github.issue" },
  { provider: "github", method: "GET",    pathPattern: /^\/repos\/[^/]+\/[^/]+\/issues$/,                  operation: "list",   resourceType: "github.issue" },
  { provider: "github", method: "POST",   pathPattern: /^\/repos\/[^/]+\/[^/]+\/issues$/,                  operation: "write",  resourceType: "github.issue" },
  { provider: "github", method: "GET",    pathPattern: /^\/repos\/[^/]+\/[^/]+\/contents\//,               operation: "read",   resourceType: "github.file" },
  { provider: "github", method: "PUT",    pathPattern: /^\/repos\/[^/]+\/[^/]+\/contents\//,               operation: "write",  resourceType: "github.file" },

  // ── Slack ──
  { provider: "slack",  method: "POST",   pathPattern: /^\/api\/chat\.postMessage$/,                       operation: "write",  resourceType: "slack.message" },
  { provider: "slack",  method: "GET",    pathPattern: /^\/api\/conversations\.history$/,                   operation: "list",   resourceType: "slack.message" },
  { provider: "slack",  method: "GET",    pathPattern: /^\/api\/channels\.list$/,                           operation: "list",   resourceType: "slack.channel" },

  // ── Salesforce ──
  { provider: "sfdc",   method: "GET",    pathPattern: /^\/services\/data\/v\d+\.\d+\/sobjects\//,        operation: "read",   resourceType: "sfdc.record" },
  { provider: "sfdc",   method: "POST",   pathPattern: /^\/services\/data\/v\d+\.\d+\/sobjects\//,        operation: "write",  resourceType: "sfdc.record" },
  { provider: "sfdc",   method: "GET",    pathPattern: /^\/services\/data\/v\d+\.\d+\/query/,              operation: "list",   resourceType: "sfdc.query" },
];

function classifyRoute(
  provider: string,
  method: string,
  apiPath: string,
): { operation: string; resourceType: string } {
  for (const rule of ROUTE_CLASSIFICATIONS) {
    if (
      rule.provider === provider &&
      (rule.method === "*" || rule.method === method) &&
      rule.pathPattern.test(apiPath)
    ) {
      return { operation: rule.operation, resourceType: rule.resourceType };
    }
  }
  return { operation: method === "GET" ? "read" : "write", resourceType: "unknown" };
}

// ──────────────────────────────────────────────────────────
// Token Cache (in-memory, per-provider)
// ──────────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, CachedToken>();

function getCachedToken(provider: string): string | null {
  const cached = tokenCache.get(provider);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    // valid with 1min buffer
    return cached.accessToken;
  }
  return null;
}

function setCachedToken(
  provider: string,
  accessToken: string,
  expiresInSec: number
): void {
  tokenCache.set(provider, {
    accessToken,
    expiresAt: Date.now() + expiresInSec * 1000,
  });
}

// ──────────────────────────────────────────────────────────
// Secret Loading (from Key Vault via CSI mount)
// ──────────────────────────────────────────────────────────

function loadSecret(secretName: string): string | null {
  const filePath = path.join(SECRETS_DIR, secretName);
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────
// OAuth2 Token Exchange
// ──────────────────────────────────────────────────────────

async function exchangeRefreshToken(
  provider: string,
  config: ProviderConfig
): Promise<string> {
  // Check cache first
  const cached = getCachedToken(provider);
  if (cached) return cached;

  const refreshToken = loadSecret(config.secretName);
  if (!refreshToken) {
    throw new Error(
      `No refresh token found for provider '${provider}' (secret: ${config.secretName})`
    );
  }

  // Providers that use bearer tokens directly (no refresh flow)
  if (!config.tokenEndpoint) {
    setCachedToken(provider, refreshToken, 3600);
    return refreshToken;
  }

  const clientId =
    process.env[config.clientIdEnvVar] ||
    loadSecret(`${provider}-client-id`) ||
    "";
  const clientSecret =
    loadSecret(`${provider}-client-secret`) || "";

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(config.defaultScopes ? { scope: config.defaultScopes } : {}),
  });

  const tokenResponse = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    throw new Error(
      `Token exchange failed for ${provider}: ${tokenResponse.status} ${errorBody}`
    );
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };

  // Cache the new access token
  setCachedToken(provider, tokenData.access_token, tokenData.expires_in || 3600);

  // If we got a new refresh token (rotation), update the secret file
  if (tokenData.refresh_token && tokenData.refresh_token !== refreshToken) {
    log("info", `Refresh token rotated for ${provider} — updating stored secret`);
    // Write to a rotation-pending file; a sidecar process syncs back to Key Vault
    const rotationPath = path.join(SECRETS_DIR, ".rotation", config.secretName);
    try {
      fs.mkdirSync(path.dirname(rotationPath), { recursive: true });
      fs.writeFileSync(rotationPath, tokenData.refresh_token);
    } catch (err) {
      log("warn", `Failed to write rotated refresh token: ${err}`);
    }
  }

  return tokenData.access_token;
}

// ──────────────────────────────────────────────────────────
// Path Policy Enforcement
// ──────────────────────────────────────────────────────────

interface PathPolicy {
  provider: string;
  allow: string[]; // Allowed path prefixes
  deny: string[]; // Denied path prefixes (checked first)
}

let policies: PathPolicy[] = [];

function loadPolicies(): void {
  try {
    const raw = fs.readFileSync(POLICY_PATH, "utf-8");
    policies = JSON.parse(raw) as PathPolicy[];
    log("info", `Loaded ${policies.length} SaaS path policies`);
  } catch {
    log("warn", `No path policy file at ${POLICY_PATH} — all paths allowed`);
    policies = [];
  }
}

function isPathAllowed(provider: string, apiPath: string): boolean {
  const policy = policies.find((p) => p.provider === provider);
  if (!policy) return true; // No policy = allow all

  // Deny rules first
  for (const denyPrefix of policy.deny) {
    if (apiPath.startsWith(denyPrefix)) return false;
  }

  // If allow list is empty, allow all (except denied)
  if (policy.allow.length === 0) return true;

  // Must match at least one allow prefix
  return policy.allow.some((prefix) => apiPath.startsWith(prefix));
}

// ──────────────────────────────────────────────────────────
// Audit Logging + Data Activity Events (§4 Activity Ledger)
// ──────────────────────────────────────────────────────────

function log(level: string, msg: string, meta?: Record<string, unknown>): void {
  if (level === "debug" && LOG_LEVEL !== "debug") return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: "saas-auth-proxy",
    tenantId: TENANT_ID,
    msg,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

function auditLog(
  provider: string,
  method: string,
  apiPath: string,
  statusCode: number,
  durationMs: number,
  blocked: boolean,
  reason?: string
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    type: "saas.proxy.request",
    tenantId: TENANT_ID,
    provider,
    method,
    path: apiPath,
    statusCode,
    durationMs,
    blocked,
    reason: reason || null,
  };
  // Written to stderr → Container Insights → Log Analytics → Sentinel SIEM
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ── Cosmos DB governance writer (Managed Identity) ──────

let _cosmosContainer: Container | null = null;

function getCosmosContainer(): Container | null {
  if (_cosmosContainer) return _cosmosContainer;
  if (!COSMOS_ENDPOINT) return null;
  try {
    const credential = new DefaultAzureCredential();
    const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: credential });
    _cosmosContainer = client.database(COSMOS_DATABASE).container(COSMOS_CONTAINER);
    return _cosmosContainer;
  } catch {
    return null;
  }
}

function writeEventToCosmos(event: Record<string, unknown>): void {
  const container = getCosmosContainer();
  if (!container) return;
  container.items.create(event).catch(() => {});
}

// ── Scope Usage Tracking ────────────────────────────────

/** Map provider → Set of inferred scopes used today */
const scopeUsage = new Map<string, Set<string>>();
/** Track resource access counts per provider+resourceType */
const resourceAccessCounts = new Map<string, { read: number; write: number; delete: number }>();
/** Track first-seen resource types for anomaly detection */
const knownResourceTypes = new Set<string>();
const anomalies: Array<{ type: string; description: string; severity: string; timestamp: string }> = [];
let scopeFlushDate = new Date().toISOString().slice(0, 10);

/** Infer OAuth scope from provider + route classification */
function inferScope(provider: string, operation: string, resourceType: string): string {
  const scopeMap: Record<string, Record<string, string>> = {
    google: {
      "gmail.message:read": "https://www.googleapis.com/auth/gmail.readonly",
      "gmail.message:list": "https://www.googleapis.com/auth/gmail.readonly",
      "gmail.message:write": "https://www.googleapis.com/auth/gmail.send",
      "calendar.event:read": "https://www.googleapis.com/auth/calendar.readonly",
      "calendar.event:list": "https://www.googleapis.com/auth/calendar.readonly",
      "calendar.event:write": "https://www.googleapis.com/auth/calendar",
      "drive.file:read": "https://www.googleapis.com/auth/drive.readonly",
      "drive.file:list": "https://www.googleapis.com/auth/drive.readonly",
      "drive.file:write": "https://www.googleapis.com/auth/drive",
      "sheets.spreadsheet:read": "https://www.googleapis.com/auth/spreadsheets.readonly",
      "sheets.spreadsheet:write": "https://www.googleapis.com/auth/spreadsheets",
    },
    graph: {
      "outlook.message:read": "Mail.Read",
      "outlook.message:list": "Mail.Read",
      "outlook.message:write": "Mail.Send",
      "outlook.event:list": "Calendars.Read",
      "onedrive.file:read": "Files.Read",
      "onedrive.file:write": "Files.ReadWrite",
    },
    github: {
      "github.issue:read": "repo",
      "github.issue:list": "repo",
      "github.issue:write": "repo",
      "github.file:read": "repo",
      "github.file:write": "repo",
    },
    slack: {
      "slack.message:write": "chat:write",
      "slack.message:list": "channels:history",
      "slack.channel:list": "channels:read",
    },
  };
  const key = `${resourceType}:${operation}`;
  return scopeMap[provider]?.[key] ?? `${provider}:${resourceType}:${operation}`;
}

function trackScopeUsage(provider: string, operation: string, resourceType: string): void {
  const scope = inferScope(provider, operation, resourceType);
  if (!scopeUsage.has(provider)) scopeUsage.set(provider, new Set());
  scopeUsage.get(provider)!.add(scope);

  // Track resource access counts
  const rKey = `${provider}:${resourceType}`;
  if (!resourceAccessCounts.has(rKey)) {
    resourceAccessCounts.set(rKey, { read: 0, write: 0, delete: 0 });
  }
  const counts = resourceAccessCounts.get(rKey)!;
  if (operation === "read" || operation === "list") counts.read++;
  else if (operation === "write") counts.write++;
  else if (operation === "delete") counts.delete++;

  // Anomaly detection: first-seen resource type
  if (!knownResourceTypes.has(rKey)) {
    if (knownResourceTypes.size > 0) {
      anomalies.push({
        type: "new_resource_type",
        description: `First access to ${provider}:${resourceType}`,
        severity: operation === "write" || operation === "delete" ? "medium" : "low",
        timestamp: new Date().toISOString(),
      });
    }
    knownResourceTypes.add(rKey);
  }
}

function flushScopeUsage(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today === scopeFlushDate && resourceAccessCounts.size === 0) return;

  for (const [provider, scopes] of scopeUsage.entries()) {
    const resources: Array<{ resource: string; readCount: number; writeCount: number; deleteCount: number }> = [];
    for (const [rKey, counts] of resourceAccessCounts.entries()) {
      if (rKey.startsWith(`${provider}:`)) {
        resources.push({
          resource: rKey.replace(`${provider}:`, ""),
          readCount: counts.read,
          writeCount: counts.write,
          deleteCount: counts.delete,
        });
      }
    }

    const report = {
      id: `scope-${TENANT_ID}-${provider}-${scopeFlushDate}`,
      type: "scope.usage",
      tenantId: TENANT_ID,
      provider,
      period: scopeFlushDate,
      usedScopes: Array.from(scopes),
      resourcesAccessed: resources,
      anomalies: anomalies.filter((a) => a.timestamp.startsWith(scopeFlushDate)),
      timestamp: new Date().toISOString(),
    };

    process.stdout.write(JSON.stringify(report) + "\n");
    writeEventToCosmos(report);
  }

  // Reset for next day
  if (today !== scopeFlushDate) {
    scopeUsage.clear();
    resourceAccessCounts.clear();
    anomalies.length = 0;
    scopeFlushDate = today;
  }
}

// Flush scope usage every hour
setInterval(flushScopeUsage, 3600_000);

/**
 * Emit a structured data.activity event for the governance activity ledger.
 * Written to stdout (Container Insights) AND directly to Cosmos DB (lineage aggregator).
 */
function emitDataActivity(
  provider: string,
  method: string,
  apiPath: string,
  statusCode: number,
  durationMs: number,
  responseBytes: number,
  traceId: string,
  blocked: boolean,
): void {
  const { operation, resourceType } = classifyRoute(provider, method, apiPath);
  const entry: Record<string, unknown> = {
    id: crypto.randomUUID(),
    type: "data.activity",
    timestamp: new Date().toISOString(),
    tenantId: TENANT_ID,
    traceId,
    provider,
    operation,
    resourceType,
    method,
    path: apiPath,
    statusCode,
    durationMs,
    responseBytes,
    blocked,
    _lineagePushed: false,
  };

  // stdout → Container Insights picks up as structured log
  process.stdout.write(JSON.stringify(entry) + "\n");

  // Cosmos DB → direct write for lineage aggregator
  writeEventToCosmos(entry);

  // Track scope usage (only for successful non-blocked requests)
  if (!blocked && statusCode >= 200 && statusCode < 400) {
    trackScopeUsage(provider, operation, resourceType);
  }
}

/**
 * Extract or generate a trace ID from the incoming request.
 */
function getTraceId(req: http.IncomingMessage): string {
  const header = req.headers["x-trace-id"];
  if (typeof header === "string" && header.length > 0) return header;
  return crypto.randomUUID();
}

// ──────────────────────────────────────────────────────────
// HTTP Proxy Server
// ──────────────────────────────────────────────────────────

function parseRoute(url: string): { provider: string; apiPath: string } | null {
  // URL format: /{provider}/{path...}
  // e.g., /google/calendar/v3/events → provider=google, path=/calendar/v3/events
  // e.g., /graph/v1.0/me/messages → provider=graph, path=/v1.0/me/messages
  const match = url.match(/^\/([a-z]+)(\/.*)?$/);
  if (!match) return null;
  return {
    provider: match[1],
    apiPath: match[2] || "/",
  };
}

function forwardToSaaS(
  targetHost: string,
  targetPath: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  res: http.ServerResponse
): void {
  const options: https.RequestOptions = {
    hostname: targetHost,
    port: 443,
    path: targetPath,
    method,
    headers: {
      ...headers,
      host: targetHost,
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    log("error", `Upstream error: ${err.message}`, { targetHost, targetPath });
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_error", message: err.message }));
  });

  if (body && body.length > 0) {
    proxyReq.write(body);
  }
  proxyReq.end();
}

const server = http.createServer((req, res) => {
  const startTime = Date.now();
  const traceId = getTraceId(req);

  // Health check
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", providers: Object.keys(PROVIDERS) }));
    return;
  }

  // Provider listing
  if (req.url === "/providers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const available: Record<string, boolean> = {};
    for (const [name, config] of Object.entries(PROVIDERS)) {
      available[name] = loadSecret(config.secretName) !== null;
    }
    res.end(JSON.stringify({ providers: available }));
    return;
  }

  // Parse route
  const route = parseRoute(req.url || "");
  if (!route) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "invalid_route",
        message: "Expected /{provider}/{api-path}",
      })
    );
    return;
  }

  const { provider, apiPath } = route;
  const config = PROVIDERS[provider];
  if (!config) {
    auditLog(provider, req.method || "GET", apiPath, 404, 0, true, "unknown_provider");
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown_provider", provider }));
    return;
  }

  // Policy check
  if (!isPathAllowed(provider, apiPath)) {
    const durationMs = Date.now() - startTime;
    auditLog(
      provider,
      req.method || "GET",
      apiPath,
      403,
      durationMs,
      true,
      "path_denied_by_policy"
    );
    emitDataActivity(provider, req.method || "GET", apiPath, 403, durationMs, 0, traceId, true);
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "path_denied",
        message: `Path ${apiPath} is not allowed for provider ${provider}`,
      })
    );
    return;
  }

  // Buffer request body
  const bodyChunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
  req.on("end", async () => {
    const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : null;

    try {
      // Get access token
      const accessToken = await exchangeRefreshToken(provider, config);

      // Build upstream headers (strip hop-by-hop, add auth)
      const upstreamHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          typeof value === "string" &&
          !["host", "connection", "authorization"].includes(key.toLowerCase())
        ) {
          upstreamHeaders[key] = value;
        }
      }
      upstreamHeaders["authorization"] = `Bearer ${accessToken}`;
      upstreamHeaders["x-trace-id"] = traceId;
      if (body) {
        upstreamHeaders["content-length"] = body.length.toString();
      }

      // Forward to SaaS
      const proxyOptions: https.RequestOptions = {
        hostname: config.apiHost,
        port: 443,
        path: apiPath,
        method: req.method || "GET",
        headers: upstreamHeaders,
      };

      const proxyReq = https.request(proxyOptions, (proxyRes) => {
        const statusCode = proxyRes.statusCode || 502;
        const durationMs = Date.now() - startTime;
        let responseBytes = 0;

        proxyRes.on("data", (chunk: Buffer) => {
          responseBytes += chunk.length;
        });
        proxyRes.on("end", () => {
          emitDataActivity(provider, req.method || "GET", apiPath, statusCode, durationMs, responseBytes, traceId, false);
        });

        auditLog(
          provider,
          req.method || "GET",
          apiPath,
          statusCode,
          durationMs,
          false
        );
        res.writeHead(statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on("error", (err) => {
        const errDuration = Date.now() - startTime;
        auditLog(
          provider,
          req.method || "GET",
          apiPath,
          502,
          errDuration,
          false,
          `upstream_error: ${err.message}`
        );
        emitDataActivity(provider, req.method || "GET", apiPath, 502, errDuration, 0, traceId, false);
        log("error", `Upstream error: ${err.message}`, {
          provider,
          apiPath,
        });
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "upstream_error",
            message: err.message,
          })
        );
      });

      if (body) proxyReq.write(body);
      proxyReq.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const authDuration = Date.now() - startTime;
      auditLog(
        provider,
        req.method || "GET",
        apiPath,
        401,
        authDuration,
        true,
        `auth_error: ${message}`
      );
      emitDataActivity(provider, req.method || "GET", apiPath, 401, authDuration, 0, traceId, true);
      log("error", `Auth error for ${provider}: ${message}`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "auth_error",
          message: `Failed to obtain access token for ${provider}`,
        })
      );
    }
  });
});

// ──────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────

loadPolicies();

server.listen(PORT, "0.0.0.0", () => {
  log("info", `SaaS Auth Proxy listening on 0.0.0.0:${PORT}`, {
    providers: Object.keys(PROVIDERS),
    tenantId: TENANT_ID,
    cosmosEnabled: !!COSMOS_ENDPOINT,
  });
});

// Flush scope usage on graceful shutdown
process.on("SIGTERM", () => {
  flushScopeUsage();
  server.close();
});
