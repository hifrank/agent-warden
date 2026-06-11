import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEnv } from "$lib/server/env";

export const POST: RequestHandler = async ({ request }) => {
  const env = getEnv();
  if (!env.wardenServerUrl) {
    return json({ error: "Warden server not configured" }, { status: 503 });
  }
  try {
    const body = await request.json();
    const res = await fetch(`${env.wardenServerUrl}/api/settings/scc-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return json(data, { status: res.status });
  } catch (err: any) {
    return json({ error: err.message ?? "Failed to reach warden server" }, { status: 502 });
  }
};
