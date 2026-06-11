import type { PageServerLoad } from "./$types";
import { mcpServers } from "$lib/server/data";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.authenticated) return { mcpServers: [] };
  return { mcpServers };
};
