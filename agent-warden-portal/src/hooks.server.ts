import type { Handle } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";
import { env as publicEnv } from "$env/dynamic/public";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

function getConfig() {
  const tenantId = publicEnv.PUBLIC_ENTRA_TENANT_ID;
  const clientId = publicEnv.PUBLIC_ENTRA_CLIENT_ID;
  return { tenantId, clientId };
}

async function verifyBearer(token: string): Promise<JWTPayload> {
  const { tenantId, clientId } = getConfig();
  if (!tenantId || !clientId) {
    throw new Error("Auth config is not set");
  }

  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
  );

  const verified = await jwtVerify(token, jwks, {
    issuer,
    audience: [clientId, `api://${clientId}`],
  });

  const tokenTenant = String(verified.payload.tid ?? "");
  if (tokenTenant !== tenantId) {
    throw new Error("Token tenant mismatch");
  }

  return verified.payload;
}

/** Paths that must be publicly accessible (static assets, health checks). */
function isPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith("/_app/") ||
    pathname.startsWith("/favicon") ||
    pathname === "/health" ||
    pathname === "/healthz"
  );
}

export const handle: Handle = async ({ event, resolve }) => {
  const { tenantId, clientId } = getConfig();

  // Development mode — no auth configured, allow everything.
  if (!tenantId || !clientId) {
    return resolve(event);
  }

  const pathname = event.url.pathname;

  // Static assets and health checks are always public.
  if (isPublicPath(pathname)) {
    return resolve(event);
  }

  // ── API routes: require Bearer token ──
  if (pathname.startsWith("/api/")) {
    const authHeader = event.request.headers.get("authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ error: "Missing bearer token" }, { status: 401 });
    }

    const token = authHeader.slice(7).trim();
    try {
      await verifyBearer(token);
      return resolve(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid token";
      return json({ error: message }, { status: 401 });
    }
  }

  // ── Page routes ──
  // Mark the request as unauthenticated so page loaders can skip
  // data fetching. The SvelteKit shell still renders (with MSAL
  // bundled in +layout.svelte), which handles the Entra ID login
  // redirect and sets the aw-session cookie on success.
  const cookies = event.request.headers.get("cookie") ?? "";
  const hasSession = cookies.includes("aw-session=");
  event.locals.authenticated = hasSession;

  return resolve(event);
};
