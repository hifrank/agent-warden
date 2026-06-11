/**
 * Test: Can our agentic user's FIC token access Outlook Calendar via Graph?
 * 
 * Usage:
 *   A365_CLIENT_SECRET="Ciw..." node test/test-graph-calendar.mjs
 */
const CONFIG = {
  tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
  blueprintClientAppId: "60e56f90-f29e-4b97-ac94-6b0500106f77",
  blueprintClientSecret: process.env.A365_CLIENT_SECRET,
  aaInstanceId: "760d5a66-7a2d-4c58-b8f9-b89627429aeb",
  agentUpn: "a365072dfe@aprforazure.onmicrosoft.com",
  agentUserId: "a55f13fb-b27d-4421-832e-2f441bc6c9a0",
};

async function getToken(scope) {
  const ep = `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`;
  const h = { "Content-Type": "application/x-www-form-urlencoded" };

  // T1: Blueprint → AA instance
  const t1 = await (await fetch(ep, { method: "POST", headers: h, body: new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.blueprintClientAppId,
    grant_type: "client_credentials",
    client_secret: CONFIG.blueprintClientSecret,
    fmi_path: CONFIG.aaInstanceId,
  }).toString() })).json();
  if (t1.error) { console.error("T1 failed:", t1.error_description); return null; }

  // T2: AA self-assertion
  const t2 = await (await fetch(ep, { method: "POST", headers: h, body: new URLSearchParams({
    scope: "api://AzureAdTokenExchange/.default",
    client_id: CONFIG.aaInstanceId,
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
  }).toString() })).json();
  if (t2.error) { console.error("T2 failed:", t2.error_description); return null; }

  // FIC: Get token for target scope as agentic user
  const fic = await (await fetch(ep, { method: "POST", headers: h, body: new URLSearchParams({
    scope,
    client_id: CONFIG.aaInstanceId,
    grant_type: "user_fic",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: t1.access_token,
    username: CONFIG.agentUpn,
    user_federated_identity_credential: t2.access_token,
  }).toString() })).json();
  if (fic.error) { console.error(`FIC failed for scope ${scope}:`, fic.error_description); return null; }

  return fic.access_token;
}

function decodeJwt(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

async function run() {
  console.log("=== Test 1: FIC token with Graph scope ===");
  const graphToken = await getToken("https://graph.microsoft.com/.default");
  if (!graphToken) {
    console.log("Could not get Graph token via FIC. Trying Calendars.ReadWrite scope...\n");
    
    const graphToken2 = await getToken("https://graph.microsoft.com/Calendars.ReadWrite");
    if (!graphToken2) {
      console.log("Could not get Graph token with explicit scope either.\n");
    } else {
      const claims2 = decodeJwt(graphToken2);
      console.log("Token claims (explicit scope):", JSON.stringify({ aud: claims2.aud, scp: claims2.scp, roles: claims2.roles, upn: claims2.upn }, null, 2));
    }
  } else {
    const claims = decodeJwt(graphToken);
    console.log("Graph token claims:", JSON.stringify({ aud: claims.aud, scp: claims.scp, roles: claims.roles, upn: claims.upn, oid: claims.oid }, null, 2));

    // Try reading calendar events for the agentic user
    console.log("\n--- GET /me/events ---");
    const r1 = await fetch("https://graph.microsoft.com/v1.0/me/events?$top=5&$select=subject,start,end", {
      headers: { Authorization: `Bearer ${graphToken}` }
    });
    console.log(`Status: ${r1.status} ${r1.statusText}`);
    if (r1.ok) {
      const data = await r1.json();
      console.log(`Events: ${data.value?.length ?? 0}`);
      data.value?.forEach(e => console.log(`  - ${e.subject} (${e.start?.dateTime})`));
    } else {
      const err = await r1.text();
      console.log("Error:", err.slice(0, 300));
    }

    // Try via user ID
    console.log(`\n--- GET /users/${CONFIG.agentUserId}/events ---`);
    const r2 = await fetch(`https://graph.microsoft.com/v1.0/users/${CONFIG.agentUserId}/events?$top=5&$select=subject,start,end`, {
      headers: { Authorization: `Bearer ${graphToken}` }
    });
    console.log(`Status: ${r2.status} ${r2.statusText}`);
    if (r2.ok) {
      const data = await r2.json();
      console.log(`Events: ${data.value?.length ?? 0}`);
      data.value?.forEach(e => console.log(`  - ${e.subject} (${e.start?.dateTime})`));
    } else {
      const err = await r2.text();
      console.log("Error:", err.slice(0, 300));
    }

    // Try calendar list
    console.log(`\n--- GET /me/calendars ---`);
    const r3 = await fetch("https://graph.microsoft.com/v1.0/me/calendars", {
      headers: { Authorization: `Bearer ${graphToken}` }
    });
    console.log(`Status: ${r3.status} ${r3.statusText}`);
    if (r3.ok) {
      const data = await r3.json();
      console.log(`Calendars: ${data.value?.length ?? 0}`);
      data.value?.forEach(c => console.log(`  - ${c.name} (${c.id?.slice(0,20)}...)`));
    } else {
      const err = await r3.text();
      console.log("Error:", err.slice(0, 300));
    }
  }

  // Also test with PowerPlatform token for comparison
  console.log("\n=== Test 2: PowerPlatform token (existing) ===");
  const ppToken = await getToken("https://api.powerplatform.com/.default");
  if (ppToken) {
    const claims = decodeJwt(ppToken);
    console.log("PowerPlatform token scopes:", claims.scp || claims.roles || "none");
  }
}

run().catch(console.error);
