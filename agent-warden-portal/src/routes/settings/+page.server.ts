import type { PageServerLoad } from "./$types";
import { getGlobalSettings } from "$lib/server/settings";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.authenticated) return { globalSettings: null };
  const globalSettings = await getGlobalSettings();
  return { globalSettings };
};
