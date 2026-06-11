import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { approvePairing } from "$lib/server/channels";
import { getEnv } from "$lib/server/env";

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json();
  const { code } = body;

  if (!code || typeof code !== "string" || code.length < 4) {
    return json({ error: "A valid pairing code is required" }, { status: 400 });
  }

  const env = getEnv();

  // Route through server to run kubectl exec on the pod
  if (env.isLive && env.wardenServerUrl) {
    try {
      const res = await fetch(
        `${env.wardenServerUrl}/api/tenants/${encodeURIComponent(params.tenantId)}/pairing-approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
        return json(err, { status: res.status });
      }
      return json(await res.json());
    } catch (err: any) {
      return json({ error: err.message ?? "Pairing failed" }, { status: 500 });
    }
  }

  try {
    const result = await approvePairing(params.tenantId, code);
    return json(result);
  } catch (err: any) {
    const status = err.message?.includes("not configured") ? 404 : 400;
    return json({ error: err.message }, { status });
  }
};
