import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";

export const PUT: RequestHandler = async ({ params, request }) => {
  const serverUrl = env.WARDEN_SERVER_URL ?? "http://localhost:3001";
  try {
    const body = await request.json();
    const res = await fetch(`${serverUrl}/api/tenants/${params.tenantId}/dlp-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return json(data, { status: res.status });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Proxy error" }, { status: 502 });
  }
};
