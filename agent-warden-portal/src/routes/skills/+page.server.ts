import type { PageServerLoad } from "./$types";
import { skills } from "$lib/server/data";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.authenticated) return { skills: [] };
  return { skills };
};
