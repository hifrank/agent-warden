import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listDlpPolicies, createDlpPolicy } from "$lib/server/dlp-policies";

export const GET: RequestHandler = async () => {
  const policies = await listDlpPolicies();
  return json(policies);
};

export const POST: RequestHandler = async ({ request }) => {
  const input = await request.json();
  if (!input.id || !input.name) {
    return json({ error: "id and name are required" }, { status: 400 });
  }
  try {
    const result = await createDlpPolicy(input);
    return json(result, { status: 201 });
  } catch (err: any) {
    return json({ error: err.message }, { status: 500 });
  }
};
