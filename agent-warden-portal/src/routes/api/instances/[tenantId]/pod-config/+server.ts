import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEnv } from "$lib/server/env";

export const GET: RequestHandler = async ({ params }) => {
  const env = getEnv();

  if (!env.isLive) {
    return json({ mock: true, models: {}, channels: {} });
  }

  const serverUrl = env.wardenServerUrl;
  const res = await fetch(
    `${serverUrl}/api/tenants/${encodeURIComponent(params.tenantId)}/pod-config`,
  );
  const data = await res.json();
  return json(data, { status: res.status });
};
