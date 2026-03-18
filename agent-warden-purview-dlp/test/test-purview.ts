/**
 * Local test for Purview processContent API — cross-tenant.
 *
 * Usage:
 *   export PURVIEW_DLP_TENANT_ID="2cf24558-0d31-439b-9c8d-6fdce3931ae7"
 *   export PURVIEW_DLP_CLIENT_ID="d94c93dd-3c80-4f3d-9671-8b71a7dccafa"
 *   export PURVIEW_DLP_CLIENT_SECRET="<from keyvault>"
 *   node --experimental-strip-types test/test-purview.ts
 */

import { ClientSecretCredential } from "@azure/identity";

const TENANT_ID = process.env.PURVIEW_DLP_TENANT_ID ?? "2cf24558-0d31-439b-9c8d-6fdce3931ae7";
const CLIENT_ID = process.env.PURVIEW_DLP_CLIENT_ID ?? "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET;
const USER_ID = process.env.PURVIEW_DLP_USER_ID ?? "7ade9412-3a6e-4b37-a3a8-51d8f81de596";

if (!CLIENT_SECRET) {
  console.error("ERROR: PURVIEW_DLP_CLIENT_SECRET env var is required");
  console.error("  az keyvault secret show --vault-name kv-demo-tenant -n purview-dlp-client-secret --query value -o tsv");
  process.exit(1);
}

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

// ── Step 1: Acquire token ──

console.log("=== Step 1: Acquire Graph token ===");
console.log(`  Tenant:  ${TENANT_ID}`);
console.log(`  Client:  ${CLIENT_ID}`);
console.log(`  User:    ${USER_ID}`);

const credential = new ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET);

let token: string;
try {
  const result = await credential.getToken(GRAPH_SCOPE);
  if (!result) throw new Error("getToken returned null");
  token = result.token;
  console.log(`  Token acquired (expires: ${new Date(result.expiresOnTimestamp).toISOString()})`);
  console.log(`  Token prefix: ${token.slice(0, 30)}...`);
} catch (err: any) {
  console.error(`  FAILED to acquire token: ${err.message}`);
  if (err.message.includes("AADSTS700016")) {
    console.error("  → App registration does not exist in this tenant. Need to create it.");
  } else if (err.message.includes("AADSTS7000215")) {
    console.error("  → Invalid client secret.");
  } else if (err.message.includes("AADSTS90002")) {
    console.error("  → Tenant ID not found.");
  }
  process.exit(1);
}

// ── Step 2: Call processContent ──

console.log("\n=== Step 2: Call processContent ===");

const testTexts = [
  { label: "benign", text: "Hello, how are you today?" },
  { label: "SSN (test value - expect pass)", text: "My social security number is 123-45-6789" },
  { label: "SSN (realistic - expect block)", text: "The applicant's SSN is 267-43-0927 as shown on the W-2 form." },
  { label: "credit card (no dash)", text: "Payment card number 4111111111111111 on file" },
  { label: "credit card (with context)", text: "My credit card is 4111-1111-1111-1111 expiry 12/30 CVV 123" },
  { label: "CC + SSN combo", text: "Card 4111111111111111 and SSN 267-43-0927 on the application" },
];

for (const { label, text } of testTexts) {
  console.log(`\n--- Test: ${label} ---`);
  console.log(`  Input: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

  const body = {
    contentToProcess: {
      contentEntries: [
        {
          "@odata.type": "microsoft.graph.processConversationMetadata",
          identifier: crypto.randomUUID(),
          content: {
            "@odata.type": "microsoft.graph.textContent",
            data: text,
          },
          name: "Agent Warden DLP test",
          correlationId: crypto.randomUUID(),
          sequenceNumber: 0,
          isTruncated: false,
          createdDateTime: new Date().toISOString(),
          modifiedDateTime: new Date().toISOString(),
        },
      ],
      activityMetadata: { activity: "uploadText" },
      deviceMetadata: {
        deviceType: "Managed",
        operatingSystemSpecifications: {
          operatingSystemPlatform: "macOS",
          operatingSystemVersion: "local-test",
        },
      },
      protectedAppMetadata: {
        name: "Agent Warden",
        version: "0.2.0",
        applicationLocation: {
          "@odata.type": "#microsoft.graph.policyLocationApplication",
          value: CLIENT_ID,
        },
      },
      integratedAppMetadata: {
        name: "Agent Warden",
        version: "0.2.0",
      },
    },
  };

  const url = `https://graph.microsoft.com/v1.0/users/${USER_ID}/dataSecurityAndGovernance/processContent`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseText = await resp.text();

    if (!resp.ok) {
      console.log(`  HTTP ${resp.status}: ${responseText.slice(0, 500)}`);
      if (resp.status === 403) {
        console.log("  → Missing permissions. Need Content.DLP.Process.All or InformationProtectionPolicy.Read.All");
      } else if (resp.status === 404) {
        console.log("  → User not found or API not available. Check userId and E5 license.");
      } else if (resp.status === 401) {
        console.log("  → Token rejected. App may not have consent in this tenant.");
      }
      continue;
    }

    const data = JSON.parse(responseText);
    const actions = data.policyActions ?? [];
    const errors = (data.processingErrors ?? []).map((e: any) => e.message ?? "unknown");
    const blocked = actions.some(
      (a: any) => a.action === "restrictAccess" || a.action === "block",
    );

    console.log(`  Status: ${resp.status} OK`);
    console.log(`  Allowed: ${!blocked}`);
    console.log(`  Actions: ${JSON.stringify(actions)}`);
    if (errors.length > 0) console.log(`  Errors: ${errors.join(", ")}`);
  } catch (err: any) {
    console.log(`  Network error: ${err.message}`);
  }
}

console.log("\n=== Done ===");
