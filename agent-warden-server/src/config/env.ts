import { z } from "zod";

const EnvSchema = z.object({
  // Azure
  AZURE_COSMOS_ENDPOINT: z.string().url(),
  AZURE_COSMOS_DATABASE: z.string().default("agent-warden"),
  AZURE_KEYVAULT_URL: z.string().url().describe("Shared platform secrets Key Vault (API keys, credentials)"),
  AZURE_KEK_VAULT_URL: z.string().url().describe("Dedicated KEK Key Vault (tenant envelope encryption keys)"),
  AZURE_PURVIEW_ENDPOINT: z.string().url().describe("Microsoft Purview catalog endpoint (E5 tenant ecardpoc4ecv)"),
  AZURE_PURVIEW_GOVERNANCE_ENDPOINT: z.string().url().describe("Microsoft Purview Data Map API endpoint (E5 tenant ecardpoc4ecv)"),
  PURVIEW_ROOT_COLLECTION: z.string().default("agent-warden-platform").describe("Purview root collection name"),
  PURVIEW_DLP_USER_ID: z.string().optional().describe("E5-licensed user ID used for Graph Purview content activity writes"),
  EVIDENCE_BLOB_ACCOUNT_URL: z.string().url().optional().describe("Blob account URL for prompt-guard evidence archival"),
  EVIDENCE_BLOB_CONTAINER_PREFIX: z.string().default("evidence").describe("Container prefix for per-tenant evidence archival"),

  AZURE_TENANT_ID: z.string().describe("Entra (Azure AD) tenant ID for CSI Secrets Store"),

  // AKS
  AKS_CLUSTER_NAME: z.string(),
  AKS_RESOURCE_GROUP: z.string(),

  // ACR
  ACR_LOGIN_SERVER: z.string(),

  // Helm
  HELM_CHART_VERSION: z.string().default("0.9.31"),

  // Server
  MCP_SERVER_PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): EnvConfig {
  return EnvSchema.parse(process.env);
}
