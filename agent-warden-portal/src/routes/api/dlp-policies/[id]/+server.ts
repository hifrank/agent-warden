import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { saveDlpPolicy, deleteDlpPolicy } from "$lib/server/dlp-policies";

export const PUT: RequestHandler = async ({ params, request }) => {
  const input = await request.json();
  input.id = params.id;
  try {
    const result = await saveDlpPolicy(input);
    return json(result);
  } catch (err: any) {
    return json({ error: err.message }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ params }) => {
  try {
    await deleteDlpPolicy(params.id);
    return new Response(null, { status: 204 });
  } catch (err: any) {
    return json({ error: err.message }, { status: 500 });
  }
};
