import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listInstances, createInstance } from "$lib/server/instances";

export const GET: RequestHandler = async ({ url }) => {
  const filters = {
    state: url.searchParams.get("state") ?? undefined,
    tier: url.searchParams.get("tier") ?? undefined,
    region: url.searchParams.get("region") ?? undefined,
    healthStatus: url.searchParams.get("healthStatus") ?? undefined,
  };
  const instances = await listInstances(filters);
  return json(instances);
};

export const POST: RequestHandler = async ({ request }) => {
  const input = await request.json();
  if (!input.tenantId || !input.adminEmail) {
    return json({ error: "tenantId and adminEmail are required" }, { status: 400 });
  }
  try {
    const result = await createInstance(input);
    return json(result, { status: 202 });
  } catch (err: any) {
    if (err.message?.includes("already exists")) {
      return json({ error: err.message }, { status: 409 });
    }
    return json({ error: err.message }, { status: 500 });
  }
};
