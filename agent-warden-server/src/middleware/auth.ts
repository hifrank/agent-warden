import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Validate Bearer token from Authorization header.
 * Token is read from MCP_AUTH_TOKEN env var (sourced from K8s secret).
 * Returns true if authenticated, false if rejected (response already sent).
 */
export function authenticateRequest(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const token = process.env.MCP_AUTH_TOKEN;

  // If no token is configured, auth is disabled (development mode)
  if (!token) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid Authorization header" }));
    return false;
  }

  const provided = authHeader.slice(7);
  if (provided !== token) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return false;
  }

  return true;
}
