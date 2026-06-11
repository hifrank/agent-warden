import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEnv } from "$lib/server/env";
import { queryDlpActivities } from "$lib/server/appinsights";

export const GET: RequestHandler = async ({ params, url }) => {
  const env = getEnv();
  if (!env.logAnalyticsWorkspaceId) {
    return json({ activities: [] });
  }

  const daysBack = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "14", 10) || 14, 1), 90);

  // Strip oc- prefix for Log Analytics tenant ID
  const tenantId = params.tenantId.startsWith("oc-") ? params.tenantId.slice(3) : params.tenantId;

  try {
    const activities = await queryDlpActivities(env.logAnalyticsWorkspaceId, tenantId, daysBack);
    return json({ activities });
  } catch (err) {
    console.warn("[portal] DLP activities query failed:", (err as Error).message);
    return json({ activities: [], error: (err as Error).message });
  }
};
