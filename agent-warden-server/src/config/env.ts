import { z } from "zod";

const EnvSchema = z.object({
  // Azure
  AZURE_COSMOS_ENDPOINT: z.string().url(),
  AZURE_COSMOS_DATABASE: z.string().default("agent-warden"),
  AZURE_KEYVAULT_URL: z.string().url(),
  AZURE_PURVIEW_ENDPOINT: z.string().url().describe("Microsoft Purview catalog endpoint (E5 tenant ecardpoc4ecv)"),
  AZURE_PURVIEW_GOVERNANCE_ENDPOINT: z.string().url().describe("Microsoft Purview Data Map API endpoint (E5 tenant ecardpoc4ecv)"),
  PURVIEW_ROOT_COLLECTION: z.string().default("agent-warden-platform").describe("Purview root collection name"),

  // AKS
  AKS_CLUSTER_NAME: z.string(),
  AKS_RESOURCE_GROUP: z.string(),

  // ACR
  ACR_LOGIN_SERVER: z.string(),

  // Helm
  HELM_CHART_PATH: z.string().default("../../k8s/helm/openclaw-tenant"),

  // Server
  MCP_SERVER_PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): EnvConfig {
  return EnvSchema.parse(process.env);
}
