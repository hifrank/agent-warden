import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getTransactions } from "$lib/server/traces";

export const GET: RequestHandler = async ({ params, url }) => {
  const daysBack = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1), 90);
  const transactions = await getTransactions(params.tenantId, daysBack);
  return json(transactions);
};
