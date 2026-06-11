export type Tier = "free" | "pro" | "enterprise";

export type TenantState =
  | "Requested"
  | "Provisioning"
  | "Active"
  | "Degraded"
  | "Suspended"
  | "Archived"
  | "Deleting"
  | "Deleted";

export type HealthStatus = "Healthy" | "Degraded" | "Unhealthy";

export interface InstanceRecord {
  tenantId: string;
  instanceId: string;
  state: TenantState;
  version: string;
  tier: Tier;
  region: string;
  createdAt: string;
  lastHealthCheck?: string;
  healthStatus?: HealthStatus;
  activeChannels: string[];
  skillCount: number;
  podCount: number;
  cpuUsagePct?: number;
  memoryUsagePct?: number;
  messagesLast24h: number;
  llmTokensLast24h: number;
  ownerIdentity: string;
  provisioningError?: string;
  provisioningStep?: number;
  provisioningStepLabel?: string;
  provisioningTotalSteps?: number;
  tags: Record<string, string>;
  /** Per-instance Entra app registration in the E5 tenant (for DLP) */
  dlpAppRegistration?: DlpAppRegistration;
  /** Per-instance DLP configuration */
  dlpConfig?: AgentDlpConfig;
}

export interface CreateInstanceInput {
  tenantId: string;
  adminEmail: string;
  model: string;
  region: string;
  channels: { type: string; enabled: boolean }[];
}

export interface FleetSummary {
  total: number;
  byState: Record<string, number>;
  byTier: Record<string, number>;
  byHealth: Record<string, number>;
  avgHealthScore: number;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  tenantId: string;
}

export interface McpServerRecord {
  id: string;
  name: string;
  endpoint: string;
  status: "connected" | "disconnected" | "error";
  toolCount: number;
  tenantId: string;
}

// ─── Agent Trace (from agents-view OTel spans) ───────────

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: "invoke_agent" | "chat" | "execute_tool";
  agentName: string;
  model?: string;
  provider?: string;
  startTime: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  toolName?: string;
  status: "ok" | "error";
  errorMessage?: string;
  /** Custom OTel attributes */
  attributes?: Record<string, string>;
}

/** A top-level agent invocation grouping child spans */
export interface EndToEndTransaction {
  /** traceId shared by all spans in this transaction */
  traceId: string;
  /** Root invoke_agent span */
  rootSpan: TraceSpan;
  /** All child spans ordered by startTime */
  childSpans: TraceSpan[];
}

// ─── Activity Metrics (aggregated from traces) ───────────

export interface ToolCallStat {
  name: string;
  errors: number;
  avgDurationMs: number;
  calls: number;
  /** 14 daily values for sparkline */
  dailyCalls: number[];
}

export interface ModelStat {
  name: string;
  errors: number;
  avgDurationMs: number;
  calls: number;
  dailyCalls: number[];
}

export interface DailyPoint {
  date: string;
  value: number;
}

export interface TokensByModel {
  model: string;
  total: number;
  daily: DailyPoint[];
}

export interface ActivityMetrics {
  agentRuns: {
    total: number;
    agentName: string;
    daily: DailyPoint[];
  };
  genAiErrors: {
    total: number;
    hasErrors: boolean;
  };
  toolCalls: ToolCallStat[];
  models: ModelStat[];
  tokenConsumption: {
    byModel: TokensByModel[];
    inputTokensTotal: number;
    outputTokensTotal: number;
    dailyInput: DailyPoint[];
    dailyOutput: DailyPoint[];
  };
}

// ─── Telegram Channel Config ─────────────────────────────

export type PairingStatus = "pending" | "approved" | "rejected";

export interface TelegramChannelConfig {
  tenantId: string;
  botToken: string;
  botUsername?: string;
  pairingStatus: PairingStatus;
  pairedAt?: string;
}

// ─── Instance Config Files ───────────────────────────────

export interface InstanceConfigFiles {
  soulMd: string;
  openclawMd: string;
}

// ─── Encryption ──────────────────────────────────────────

/** KEK-encrypted blob stored in Cosmos DB */
export interface EncryptedBlob {
  /** Base64-encoded IV + ciphertext + auth tag */
  data: string;
  /** Key vault name (for provenance) */
  vault: string;
  /** KEK secret name in Key Vault */
  kekName: string;
}

// ─── Global Settings ─────────────────────────────────────

/** E5 Admin App — used for cross-tenant app registration via Graph API */
export interface AdminAppConfig {
  clientId: string;
  encryptedClientSecret: EncryptedBlob;
  configuredAt: string;
}

/** SCC PowerShell App — used for DLP policy management via Security & Compliance PowerShell */
export interface SccAppConfig {
  clientId: string;
  certificateThumbprint: string;
  e5OrgDomain: string;
  configuredAt: string;
}

export interface PurviewDlpSettings {
  /** E5 tenant ID for Purview DLP (the tenant that has E5/compliance licenses) */
  purviewTenantId: string;
  /** @deprecated — moved to per-agent AgentDlpConfig.userId */
  purviewUserId?: string;
  /** Whether DLP is enabled for new tenants by default */
  enabledByDefault: boolean;
  /** Default DLP mode: "enforce" or "audit" */
  defaultMode: "enforce" | "audit";
  /** Default DLP layers enabled for new tenants */
  defaultLayers: {
    /** L1: Inject DLP security policy into agent context */
    promptGuard: boolean;
    /** L2: Scan tool output + outbound responses via Purview processContent */
    outputScanner: boolean;
    /** L3: Audit inbound user messages via Purview processContent */
    inputAudit: boolean;
  };
  /** E5 Admin App credentials for cross-tenant Graph API calls */
  adminApp?: AdminAppConfig;
  /** SCC PowerShell App credentials for DLP policy management */
  sccApp?: SccAppConfig;
}

export interface ComputeTenantSettings {
  /** Entra tenant ID where AKS, ACR, Key Vaults, etc. live */
  entraTenanId: string;
  /** AKS cluster name */
  aksClusterName: string;
  /** AKS resource group */
  aksResourceGroup: string;
  /** ACR login server */
  acrLoginServer: string;
  /** Shared Key Vault name (platform secrets) */
  sharedKeyVaultName: string;
  /** KEK Key Vault name (per-tenant envelope encryption) */
  kekKeyVaultName: string;
}

export interface GlobalSettings {
  computeTenant: ComputeTenantSettings;
  e5Tenant: PurviewDlpSettings;
}

// ─── Per-Instance DLP ────────────────────────────────────

/** Entra app registration created in the E5 tenant for a specific OpenClaw instance */
export interface DlpAppRegistration {
  /** E5 tenant ID where the app was registered */
  e5TenantId: string;
  /** Application (client) ID */
  appId: string;
  /** Object ID of the app registration */
  objectId: string;
  /** Display name (e.g. "openclaw-<instanceId>-dlp") */
  displayName: string;
  /** KEK-encrypted client secret */
  encryptedClientSecret: EncryptedBlob;
  /** When the app was created */
  createdAt: string;
}

/** Per-instance DLP configuration */
export interface AgentDlpConfig {
  /** E5-licensed user Object ID — used for processContent API calls (per-agent isolation) */
  userId?: string;
  /** Assigned DLP policy name (if any) */
  policyName?: string;
  /** Mode override: "enforce" | "audit" | "inherit" (use global default) */
  mode: "enforce" | "audit" | "inherit";
  /** Layer overrides (null = inherit from global default) */
  layers?: {
    promptGuard: boolean;
    outputScanner: boolean;
    inputAudit: boolean;
  };
}
