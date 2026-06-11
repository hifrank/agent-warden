import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listSkills } from "$lib/server/skills";

export const GET: RequestHandler = async ({ url }) => {
  const tenantId = url.searchParams.get("tenantId") ?? undefined;
  const skills = await listSkills(tenantId);
  return json(skills);
};
