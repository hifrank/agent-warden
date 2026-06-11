import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEnv } from "$lib/server/env";

export const POST: RequestHandler = async () => {
  const env = getEnv();
  if (!env.wardenServerUrl) {
    return json({ error: "Warden server not configured" }, { status: 503 });
  }
  try {
    const res = await fetch(`${env.wardenServerUrl}/api/settings/e5-admin-app/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    return json(data, { status: res.status });
  } catch (err: any) {
    return json({ error: err.message ?? "Failed to reach warden server" }, { status: 502 });
  }
};
