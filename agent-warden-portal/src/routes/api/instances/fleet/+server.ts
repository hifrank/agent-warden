import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getFleetSummary } from "$lib/server/instances";

export const GET: RequestHandler = async () => {
  const summary = await getFleetSummary();
  return json(summary);
};
