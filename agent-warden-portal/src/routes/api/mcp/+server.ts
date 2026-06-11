import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listMcpServers } from "$lib/server/mcp-servers";

export const GET: RequestHandler = async ({ url }) => {
  const tenantId = url.searchParams.get("tenantId") ?? undefined;
  const servers = await listMcpServers(tenantId);
  return json(servers);
};
