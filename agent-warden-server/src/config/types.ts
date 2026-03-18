import { z } from "zod";

export const TierSchema = z.enum(["free", "pro", "enterprise"]);
export type Tier = z.infer<typeof TierSchema>;

export const TenantStateSchema = z.enum([
  "Requested",
  "Provisioning",
  "Active",
  "Degraded",
  "Suspended",
  "Archived",
  "Deleted",
]);
export type TenantState = z.infer<typeof TenantStateSchema>;

export const ChannelConfigSchema = z.object({
  type: z.string(),
  enabled: z.boolean(),
});

export const TenantProvisionInputSchema = z.object({
  tenantId: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  adminEmail: z.string().email(),
  tier: TierSchema,
  region: z.string().default("eastus2"),
  channels: z.array(ChannelConfigSchema).default([]),
});
export type TenantProvisionInput = z.infer<typeof TenantProvisionInputSchema>;

export const PolicyEvaluationInputSchema = z.object({
  tenantId: z.string(),
  action: z.string(),
  resource: z.string(),
  context: z.record(z.unknown()).default({}),
});
export type PolicyEvaluationInput = z.infer<typeof PolicyEvaluationInputSchema>;

export const PolicyEvaluationResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  warnings: z.array(z.string()),
});
export type PolicyEvaluationResult = z.infer<
  typeof PolicyEvaluationResultSchema
>;

export const AuditQueryInputSchema = z.object({
  tenantId: z.string().optional(),
  eventType: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  limit: z.number().int().min(1).max(1000).default(100),
});
export type AuditQueryInput = z.infer<typeof AuditQueryInputSchema>;

export const HealthCheckResultSchema = z.object({
  tenantId: z.string(),
  compositeScore: z.number().min(0).max(1),
  dimensions: z.record(z.number()),
  state: TenantStateSchema,
  timestamp: z.string().datetime(),
});
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

export const InstanceRecordSchema = z.object({
  tenantId: z.string(),
  instanceId: z.string(),
  state: TenantStateSchema,
  version: z.string(),
  tier: TierSchema,
  region: z.string(),
  createdAt: z.string().datetime(),
  lastHealthCheck: z.string().datetime().optional(),
  healthStatus: z.enum(["Healthy", "Degraded", "Unhealthy"]).optional(),
  activeChannels: z.array(z.string()).default([]),
  skillCount: z.number().int().default(0),
  podCount: z.number().int().default(0),
  cpuUsagePct: z.number().min(0).max(100).optional(),
  memoryUsagePct: z.number().min(0).max(100).optional(),
  messagesLast24h: z.number().int().default(0),
  llmTokensLast24h: z.number().int().default(0),
  ownerIdentity: z.string(),
  tags: z.record(z.string()).default({}),
});
export type InstanceRecord = z.infer<typeof InstanceRecordSchema>;
