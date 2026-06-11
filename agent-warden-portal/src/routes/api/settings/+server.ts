import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getGlobalSettings, saveGlobalSettings } from "$lib/server/settings";

export const GET: RequestHandler = async () => {
  const settings = await getGlobalSettings();
  return json(settings ?? {});
};

export const PUT: RequestHandler = async ({ request }) => {
  const input = await request.json();
  try {
    const result = await saveGlobalSettings(input);
    return json(result);
  } catch (err: any) {
    return json({ error: err.message }, { status: 500 });
  }
};
