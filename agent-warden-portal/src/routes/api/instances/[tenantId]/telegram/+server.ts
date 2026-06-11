import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getTelegramConfig, saveTelegramConfig } from "$lib/server/channels";
import { getEnv } from "$lib/server/env";

export const GET: RequestHandler = async ({ params }) => {
  const env = getEnv();

  // Route through server for KEK decryption in live mode
  if (env.isLive && env.wardenServerUrl) {
    const res = await fetch(
      `${env.wardenServerUrl}/api/tenants/${encodeURIComponent(params.tenantId)}/telegram-config`,
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
      return json(err, { status: res.status });
    }
    return json(await res.json());
  }

  const cfg = await getTelegramConfig(params.tenantId);
  // Mask the bot token for GET responses
  const masked = cfg.botToken
    ? cfg.botToken.slice(0, 6) + "••••••" + cfg.botToken.slice(-4)
    : "";
  return json({ ...cfg, botToken: masked });
};

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json();
  const { botToken, botUsername } = body;

  if (!botToken || typeof botToken !== "string") {
    return json({ error: "botToken is required" }, { status: 400 });
  }

  const env = getEnv();

  // Route through server for KEK encryption in live mode
  if (env.isLive && env.wardenServerUrl) {
    const res = await fetch(
      `${env.wardenServerUrl}/api/tenants/${encodeURIComponent(params.tenantId)}/telegram-config`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken, botUsername }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
      return json(err, { status: res.status });
    }
    return json(await res.json());
  }

  const result = await saveTelegramConfig(params.tenantId, botToken, botUsername);
  return json(result);
};
