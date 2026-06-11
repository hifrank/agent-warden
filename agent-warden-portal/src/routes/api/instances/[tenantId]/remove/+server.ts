import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { removeInstanceRecord } from "$lib/server/instances";

export const DELETE: RequestHandler = async ({ params }) => {
  try {
    await removeInstanceRecord(params.tenantId);
    return new Response(null, { status: 204 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Remove failed";
    const status = msg.includes("not Deleted") ? 409 : 404;
    return json({ error: msg }, { status });
  }
};
