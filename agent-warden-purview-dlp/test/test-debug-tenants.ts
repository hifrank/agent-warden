/**
 * Debug: Compare processContent raw responses between two tenant+user combos.
 *
 * Usage:
 *   export PURVIEW_DLP_CLIENT_SECRET="$(kubectl get secret openclaw-demo-tenant-secrets \
 *     -n tenant-demo-tenant -o jsonpath='{.data.PURVIEW_DLP_CLIENT_SECRET}' | base64 -d)"
 *   node --experimental-strip-types test/test-debug-tenants.ts
 */

import { ClientSecretCredential } from "@azure/identity";

const CLIENT_ID = "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET;

if (!CLIENT_SECRET) {
  console.error("ERROR: PURVIEW_DLP_CLIENT_SECRET env var is required");
  process.exit(1);
}

// The two configs to compare
const configs = [
  {
    label: "WORKING: tenant 2cf24558 + user 7ade9412",
    tenantId: "2cf24558-0d31-439b-9c8d-6fdce3931ae7",
    userId: "7ade9412-3a6e-4b37-a3a8-51d8f81de596",
  },
  {
    label: "TARGET: tenant dab94ed2 (aprforazure) + Frank 21bbd518",
    tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3",
    userId: "21bbd518-a20d-41a6-a5da-78e097fda3e5",
  },
];

const TEST_TEXT = `Name: Michael Anderson
SSN: 234-67-8901
Credit card number: 4242424242424242
This is a test message.`;

async function testConfig(cfg: typeof configs[0]) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${cfg.label}`);
  console.log(`  Tenant: ${cfg.tenantId}`);
  console.log(`  User:   ${cfg.userId}`);
  console.log(`${"═".repeat(70)}`);

  // Get token for THIS tenant
  const credential = new ClientSecretCredential(cfg.tenantId, CLIENT_ID, CLIENT_SECRET!);

  let token: string;
  try {
    const result = await credential.getToken("https://graph.microsoft.com/.default");
    if (!result) throw new Error("No token");
    token = result.token;
    console.log("  ✓ Token acquired");

    // Decode JWT to check app roles/permissions
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    console.log(`  Token aud: ${payload.aud}`);
    console.log(`  Token app_displayname: ${payload.app_displayname ?? "N/A"}`);
    console.log(`  Token tid: ${payload.tid}`);
    console.log(`  Token roles: ${JSON.stringify(payload.roles ?? [])}`);
  } catch (err: any) {
    console.error(`  ✗ Token acquisition failed: ${err.message}`);
    return;
  }

  // ── Step 1: protectionScopes/compute ──
  const scopeUrl = `https://graph.microsoft.com/v1.0/users/${cfg.userId}/dataSecurityAndGovernance/protectionScopes/compute`;
  console.log(`\n  --- protectionScopes/compute ---`);
  try {
    const scopeResp = await fetch(scopeUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        activities: "uploadText,downloadText",
        locations: [
          {
            "@odata.type": "microsoft.graph.policyLocationApplication",
            value: CLIENT_ID,
          },
        ],
      }),
    });
    const scopeText = await scopeResp.text();
    console.log(`  HTTP: ${scopeResp.status}`);
    console.log(`  ETag: ${scopeResp.headers.get("etag")}`);
    try {
      const scopeData = JSON.parse(scopeText);
      console.log(`  Scopes: ${JSON.stringify(scopeData, null, 2).split("\n").map(l => `    ${l}`).join("\n")}`);
    } catch {
      console.log(`  Raw: ${scopeText.slice(0, 500)}`);
    }
  } catch (err: any) {
    console.log(`  ERROR: ${err.message}`);
  }

  // ── Step 2: processContent ──
  const url = `https://graph.microsoft.com/v1.0/users/${cfg.userId}/dataSecurityAndGovernance/processContent`;
  console.log(`\n  --- processContent ---`);
  console.log(`  URL: ${url}`);

  const body = {
    contentToProcess: {
      contentEntries: [
        {
          "@odata.type": "microsoft.graph.processConversationMetadata",
          identifier: crypto.randomUUID(),
          content: {
            "@odata.type": "microsoft.graph.textContent",
            data: TEST_TEXT,
          },
          name: "debug-tenant-comparison",
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
          operatingSystemVersion: "test",
        },
      },
      protectedAppMetadata: {
        name: "Agent Warden",
        version: "0.5.5",
        applicationLocation: {
          "@odata.type": "#microsoft.graph.policyLocationApplication",
          value: CLIENT_ID,
        },
      },
      integratedAppMetadata: {
        name: "Agent Warden",
        version: "0.5.5",
      },
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await resp.text();
  console.log(`\n  HTTP Status: ${resp.status}`);
  console.log(`  Response headers: content-type=${resp.headers.get("content-type")}`);

  if (!resp.ok) {
    console.log(`  ✗ ERROR Response:\n${responseText.slice(0, 1000)}`);
    return;
  }

  const data = JSON.parse(responseText);
  console.log(`\n  Full Response:`);
  console.log(JSON.stringify(data, null, 2).split("\n").map(l => `    ${l}`).join("\n"));

  const actions = data.policyActions ?? [];
  const errors = data.processingErrors ?? [];
  console.log(`\n  policyActions count: ${actions.length}`);
  console.log(`  processingErrors count: ${errors.length}`);
  if (errors.length > 0) {
    console.log(`  Errors: ${JSON.stringify(errors)}`);
  }
  console.log(`  Result: ${actions.length > 0 ? "BLOCK" : "ALLOW"}`);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║   DEBUG: Compare processContent between two tenant+user configs ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`\nTest text:\n  ${TEST_TEXT.replace(/\n/g, "\n  ")}`);

  for (const cfg of configs) {
    await testConfig(cfg);
  }
}

main().catch(console.error);
