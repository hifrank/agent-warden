import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getInstance, deleteInstance } from "$lib/server/instances";

export const GET: RequestHandler = async ({ params }) => {
  const inst = await getInstance(params.tenantId);
  if (!inst) return json({ error: "Not found" }, { status: 404 });
  return json(inst);
};

export const DELETE: RequestHandler = async ({ params }) => {
  try {
    await deleteInstance(params.tenantId);
    return json({ status: "deleting", tenantId: params.tenantId }, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed";
    return json({ error: msg }, { status: 404 });
  }
};
