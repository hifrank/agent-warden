/**
 * Traces service — routes to App Insights or in-memory mock data.
 */
import { getEnv } from "./env.js";
import { queryTransactions, queryActivityMetrics } from "./appinsights.js";
import { getTransactions as getMockTransactions, activityMetrics as mockMetrics } from "./data.js";
import type { EndToEndTransaction, ActivityMetrics } from "$lib/types";

/** OTel traces use bare tenant names (e.g. "demo-tenant") while Cosmos records use "oc-" prefixed IDs. */
function toTraceTenantId(tenantId: string): string {
  return tenantId.startsWith("oc-") ? tenantId.slice(3) : tenantId;
}

export async function getTransactions(tenantId: string, daysBack = 30): Promise<EndToEndTransaction[]> {
  const env = getEnv();

  if (!env.isLive || !env.logAnalyticsWorkspaceId) {
    return getMockTransactions(tenantId);
  }

  try {
    const traceTenantId = toTraceTenantId(tenantId);
    const results = await queryTransactions(env.logAnalyticsWorkspaceId, traceTenantId, daysBack);
    // Fall back to mock if no real telemetry exists yet
    return results.length > 0 ? results : getMockTransactions(tenantId);
  } catch (err) {
    console.warn("[portal] App Insights query failed, using mock data:", (err as Error).message);
    return getMockTransactions(tenantId);
  }
}

export async function getActivityMetrics(tenantId: string, daysBack = 1): Promise<ActivityMetrics | null> {
  const env = getEnv();

  if (!env.isLive || !env.logAnalyticsWorkspaceId) {
    return mockMetrics[tenantId] ?? null;
  }

  try {
    const traceTenantId = toTraceTenantId(tenantId);
    const metrics = await queryActivityMetrics(env.logAnalyticsWorkspaceId, traceTenantId, daysBack);
    // Fall back to mock if no real telemetry exists yet
    return metrics.agentRuns.total > 0 ? metrics : (mockMetrics[tenantId] ?? null);
  } catch (err) {
    console.warn("[portal] Activity metrics query failed, using mock data:", (err as Error).message);
    return mockMetrics[tenantId] ?? null;
  }
}
