import { PublicClientApplication, type AuthenticationResult } from "@azure/msal-browser";
import { env } from "$env/dynamic/public";

const clientId = env.PUBLIC_ENTRA_CLIENT_ID;
const tenantId = env.PUBLIC_ENTRA_TENANT_ID;
const redirectUri =
  env.PUBLIC_ENTRA_REDIRECT_URI ??
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");

const hasConfig = !!(clientId && tenantId);

const msal = hasConfig
  ? new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri,
      },
      cache: {
        cacheLocation: "sessionStorage",
      },
    })
  : null;

function getScopes(): string[] {
  if (!clientId) return [];
  return [`api://${clientId}/Portal.Access`];
}

export async function ensureSignedIn(): Promise<void> {
  if (!msal) return;

  await msal.initialize();
  const redirect = await msal.handleRedirectPromise();

  const account = redirect?.account ?? msal.getAllAccounts()[0] ?? null;
  if (account) {
    msal.setActiveAccount(account);
    return;
  }

  await msal.loginRedirect({ scopes: getScopes() });
}

export async function acquireApiToken(): Promise<string> {
  if (!msal) return "";

  const active = msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
  if (!active) {
    await ensureSignedIn();
    throw new Error("No active account after sign-in redirect");
  }

  msal.setActiveAccount(active);

  let result: AuthenticationResult;
  try {
    result = await msal.acquireTokenSilent({ account: active, scopes: getScopes() });
  } catch {
    await msal.acquireTokenRedirect({ account: active, scopes: getScopes() });
    throw new Error("Redirecting for token acquisition");
  }

  return result.accessToken;
}
