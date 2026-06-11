import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEnv } from "$lib/server/env";

export const POST: RequestHandler = async ({ params }) => {
  const env = getEnv();

  if (!env.isLive) {
    return json({ synced: true, channels: ["telegram"] });
  }

  const serverUrl = env.wardenServerUrl;
  if (!serverUrl) {
    return json({ error: "WARDEN_SERVER_URL not configured" }, { status: 500 });
  }

  const res = await fetch(
    `${serverUrl}/api/tenants/${encodeURIComponent(params.tenantId)}/sync-config`,
    { method: "POST" },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
    return json(err, { status: res.status });
  }

  return json(await res.json());
};
