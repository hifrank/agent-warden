import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getActivityMetrics } from "$lib/server/traces";

export const GET: RequestHandler = async ({ params, url }) => {
  const daysBack = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "1", 10) || 1, 1), 90);
  const metrics = await getActivityMetrics(params.tenantId, daysBack);
  if (!metrics) {
    return json({ totalRequests: 0, avgLatencyMs: 0, errorRate: 0, activeSkills: 0, requestsChart: [], latencyChart: [], errorsChart: [], topSkills: [] });
  }
  return json(metrics);
};
