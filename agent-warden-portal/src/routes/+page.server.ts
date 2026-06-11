import type { PageServerLoad } from "./$types";
import { listInstances } from "$lib/server/instances";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.authenticated) return { instances: [] };
  const instances = await listInstances();
  return { instances };
};
