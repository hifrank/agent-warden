/**
 * Create a DLP policy in the Purview tenant via Graph API.
 *
 * This script:
 *   1. Acquires a token for the Purview tenant
 *   2. Creates a DLP policy targeting the processContent API with SSN + Credit Card rules
 *
 * Usage:
 *   PURVIEW_DLP_CLIENT_SECRET="..." node --experimental-strip-types test/create-dlp-policy.ts
 */

import { ClientSecretCredential } from "@azure/identity";

const TENANT_ID = process.env.PURVIEW_DLP_TENANT_ID ?? "2cf24558-0d31-439b-9c8d-6fdce3931ae7";
const CLIENT_ID = process.env.PURVIEW_DLP_CLIENT_ID ?? "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET;
const USER_ID = process.env.PURVIEW_DLP_USER_ID ?? "7ade9412-3a6e-4b37-a3a8-51d8f81de596";

if (!CLIENT_SECRET) {
  console.error("ERROR: PURVIEW_DLP_CLIENT_SECRET env var required");
  process.exit(1);
}

const credential = new ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET);
const tokenResult = await credential.getToken("https://graph.microsoft.com/.default");
const token = tokenResult!.token;
console.log("Token acquired.\n");

async function graphCall(method: string, path: string, body?: any) {
  const url = `https://graph.microsoft.com${path}`;
  console.log(`${method} ${url}`);
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  console.log(`  → ${resp.status}`);
  if (text) {
    try {
      const json = JSON.parse(text);
      console.log(`  → ${JSON.stringify(json, null, 2).slice(0, 1000)}`);
      return { status: resp.status, data: json };
    } catch {
      console.log(`  → ${text.slice(0, 500)}`);
      return { status: resp.status, data: text };
    }
  }
  return { status: resp.status, data: null };
}

// Step 1: Check if we can list existing DLP policies
console.log("=== Step 1: Check existing DLP policies ===");
await graphCall("GET", "/beta/security/informationProtection/policy/dlp");

// Step 2: Try to check protection scopes for the user
console.log("\n=== Step 2: Check protection scopes for user ===");
await graphCall("POST", `/v1.0/users/${USER_ID}/dataSecurityAndGovernance/protectionScopes/compute`, {});

// Step 3: List sensitive information types available
console.log("\n=== Step 3: List sensitive information types ===");
await graphCall("GET", "/beta/security/informationProtection/sensitivityLabels");

// Step 4: Try to create a DLP policy via compliance endpoint
console.log("\n=== Step 4: Attempt to create DLP policy ===");
const policyBody = {
  displayName: "Agent Warden - Block PII in AI Agents",
  description: "Blocks SSN and Credit Card numbers from being processed by AI agents via processContent API",
  isEnabled: true,
  mode: "enable",
};
await graphCall("POST", "/beta/security/informationProtection/policy/dlp", policyBody);

console.log("\n=== Done ===");
console.log("\nIf Graph API creation failed, create the policy manually:");
console.log("1. Go to: https://purview.microsoft.com/datalossprevention/policies");
console.log("2. Sign in as admin of tenant 2cf24558");
console.log("3. Create policy → Custom → Custom policy");
console.log("4. Name: 'Agent Warden - Block PII in AI Agents'");
console.log("5. Locations: select 'AI apps with Microsoft Purview content processing'");
console.log("6. Rules:");
console.log("   - Condition: Content contains → U.S. Social Security Number (SSN)");
console.log("   - Condition: Content contains → Credit Card Number");
console.log("   - Action: Restrict access → Block everyone");
console.log("7. Apply to: user " + USER_ID);
console.log("8. Enable policy immediately");
