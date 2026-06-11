import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getInstanceConfig, saveInstanceConfig } from "$lib/server/configs";

export const GET: RequestHandler = async ({ params }) => {
  const cfg = await getInstanceConfig(params.tenantId);
  return json(cfg);
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await request.json();
  const { soulMd, openclawMd } = body;
  const result = await saveInstanceConfig(
    params.tenantId,
    soulMd ?? "",
    openclawMd ?? "",
  );
  return json(result);
};
