import { getEnv } from "./env.js";

export async function wardenFetch(input: string, init?: RequestInit): Promise<Response> {
  const env = getEnv();
  const headers = new Headers(init?.headers ?? {});

  if (env.mcpAuthToken) {
    headers.set("Authorization", `Bearer ${env.mcpAuthToken}`);
    headers.set("X-MCP-Token", env.mcpAuthToken);
  }

  return fetch(input, {
    ...init,
    headers,
  });
}
