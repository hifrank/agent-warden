#!/usr/bin/env npx tsx
/**
 * Local test for Purview contentActivities API.
 *
 * Quick-run (reads secret from AKS pod):
 *   ./test/test-content-activities.ts
 *
 * Or with env vars already set:
 *   PURVIEW_DLP_CLIENT_SECRET="..." npx tsx test/test-content-activities.ts
 *
 * Tests:
 *   1. Token acquisition (cross-tenant ClientSecretCredential)
 *   2. contentActivities POST with docs-exact body format
 *   3. contentActivities POST with various body variations
 *
 * No AKS deployment needed — runs directly against Graph API.
 */

import { ClientSecretCredential } from "@azure/identity";

// ── Config (defaults match demo-tenant deployment) ──

const TENANT_ID = process.env.PURVIEW_DLP_TENANT_ID ?? "dab94ed2-4cee-4b36-b007-6618f570b4a3";
const CLIENT_ID = process.env.PURVIEW_DLP_CLIENT_ID ?? "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const USER_ID = process.env.PURVIEW_DLP_USER_ID ?? "3ed968e9-98cf-4e61-89f6-3ae3ec61614c";
let CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET;

// Auto-fetch secret from AKS pod if not set
if (!CLIENT_SECRET) {
  console.log("PURVIEW_DLP_CLIENT_SECRET not set — fetching from AKS pod...");
  const { execSync } = await import("node:child_process");
  try {
    CLIENT_SECRET = execSync(
      "kubectl exec -n tenant-demo-tenant openclaw-demo-tenant-0 -c openclaw-gateway -- printenv PURVIEW_DLP_CLIENT_SECRET",
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    console.log(`  Got secret (${CLIENT_SECRET.length} chars) from pod\n`);
  } catch {
    console.error("Failed to fetch secret from AKS pod.");
    console.error("Set PURVIEW_DLP_CLIENT_SECRET manually or ensure kubectl access.");
    process.exit(1);
  }
}

// ── Auth ──

const cred = new ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET);
const { token } = (await cred.getToken("https://graph.microsoft.com/.default"))!;
console.log(`Token acquired for tenant ${TENANT_ID}\n`);

const BASE = `https://graph.microsoft.com/v1.0/users/${USER_ID}/dataSecurityAndGovernance`;

// ── Helper ──

async function testContentActivity(label: string, body: object): Promise<{ status: number; body: string }> {
  const resp = await fetch(`${BASE}/activities/contentActivities`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, body: text };
}

function makeBody(overrides: {
  activity?: string;
  deviceType?: string;
  odataPrefix?: string;
  ipAddress?: string;
} = {}) {
  const { activity = "uploadText", deviceType, odataPrefix = "", ipAddress } = overrides;
  const deviceMetadata: any = {
    operatingSystemSpecifications: {
      operatingSystemPlatform: "Linux",
      operatingSystemVersion: "AKS",
    },
  };
  if (deviceType) deviceMetadata.deviceType = deviceType;
  if (ipAddress) deviceMetadata.ipAddress = ipAddress;

  return {
    contentToProcess: {
      contentEntries: [{
        "@odata.type": "microsoft.graph.processConversationMetadata",
        identifier: crypto.randomUUID(),
        name: "Agent Warden DLP audit",
        correlationId: crypto.randomUUID(),
        sequenceNumber: 0,
        isTruncated: false,
        createdDateTime: new Date().toISOString(),
        modifiedDateTime: new Date().toISOString(),
      }],
      activityMetadata: { activity },
      deviceMetadata,
      protectedAppMetadata: {
        name: "Agent Warden",
        version: "0.5.6",
        applicationLocation: {
          "@odata.type": `${odataPrefix}microsoft.graph.policyLocationApplication`,
          value: CLIENT_ID,
        },
      },
      integratedAppMetadata: {
        name: "Agent Warden",
        version: "0.5.6",
      },
    },
  };
}

// ── Tests ──

const tests = [
  { label: "docs-exact (no deviceType, no # prefix)", body: makeBody() },
  { label: "with deviceType=Managed", body: makeBody({ deviceType: "Managed" }) },
  { label: "with # prefix", body: makeBody({ odataPrefix: "#" }) },
  { label: "with deviceType + # prefix", body: makeBody({ deviceType: "Managed", odataPrefix: "#" }) },
  { label: "with ipAddress", body: makeBody({ ipAddress: "114.24.90.213" }) },
  { label: "downloadText activity", body: makeBody({ activity: "downloadText" }) },
  { label: "deviceType=Unmanaged", body: makeBody({ deviceType: "Unmanaged" }) },
];

console.log("Testing contentActivities API variations:\n");

for (const { label, body } of tests) {
  const result = await testContentActivity(label, body);
  const icon = result.status === 201 ? "✅" : result.status === 200 ? "✅" : "❌";
  const detail = result.status >= 400
    ? (() => { try { return JSON.parse(result.body)?.error?.message?.slice(0, 100) ?? ""; } catch { return result.body.slice(0, 100); } })()
    : "OK";
  console.log(`  ${icon} ${label.padEnd(45)} → HTTP ${result.status}  ${detail}`);
}

// ── Also verify processContent still works ──

console.log("\n--- Sanity check: processContent ---");
const pcResp = await fetch(`${BASE}/processContent`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    contentToProcess: {
      contentEntries: [{
        "@odata.type": "microsoft.graph.processConversationMetadata",
        identifier: crypto.randomUUID(),
        content: { "@odata.type": "microsoft.graph.textContent", data: "Card 4111-1111-1111-1111 and SSN 267-43-0927" },
        name: "DLP test",
        correlationId: crypto.randomUUID(),
        sequenceNumber: 0,
        isTruncated: false,
        createdDateTime: new Date().toISOString(),
        modifiedDateTime: new Date().toISOString(),
      }],
      activityMetadata: { activity: "uploadText" },
      deviceMetadata: { deviceType: "Managed", operatingSystemSpecifications: { operatingSystemPlatform: "Linux", operatingSystemVersion: "AKS" } },
      protectedAppMetadata: { name: "Agent Warden", version: "0.5.6", applicationLocation: { "@odata.type": "#microsoft.graph.policyLocationApplication", value: CLIENT_ID } },
      integratedAppMetadata: { name: "Agent Warden", version: "0.5.6" },
    },
  }),
});
const pcData = (await pcResp.json()) as any;
const blocked = (pcData.policyActions ?? []).some((a: any) => a.action === "restrictAccess");
const errors = (pcData.processingErrors ?? []).map((e: any) => e.message ?? "unknown");
console.log(`  ${blocked ? "🚫 BLOCKED" : "✅ allowed"}  HTTP ${pcResp.status}  actions=${JSON.stringify(pcData.policyActions ?? [])}`);
if (errors.length) console.log(`  errors: ${errors.join(", ")}`);

console.log("\nDone.");
