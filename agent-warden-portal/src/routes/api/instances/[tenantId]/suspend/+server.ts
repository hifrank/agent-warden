import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { suspendInstance } from "$lib/server/instances";

export const POST: RequestHandler = async ({ params }) => {
  try {
    await suspendInstance(params.tenantId);
    return json({ message: `${params.tenantId} suspended` });
  } catch {
    return json({ error: "Not found" }, { status: 404 });
  }
};
