/**
 * Extended Purview processContent test — tests various SIT formats and dumps full responses.
 * Usage: PURVIEW_DLP_CLIENT_SECRET="..." node --experimental-strip-types test/test-purview-extended.ts
 */
import { ClientSecretCredential } from "@azure/identity";

const TENANT_ID = process.env.PURVIEW_DLP_TENANT_ID ?? "2cf24558-0d31-439b-9c8d-6fdce3931ae7";
const CLIENT_ID = process.env.PURVIEW_DLP_CLIENT_ID ?? "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET!;
const USER_ID = process.env.PURVIEW_DLP_USER_ID ?? "7ade9412-3a6e-4b37-a3a8-51d8f81de596";

if (!CLIENT_SECRET) { console.error("Set PURVIEW_DLP_CLIENT_SECRET"); process.exit(1); }

const credential = new ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET);
const { token } = (await credential.getToken("https://graph.microsoft.com/.default"))!;
console.log("Token acquired.\n");

const testCases = [
  { label: "benign",              text: "The weather is nice today." },
  // Credit card variants
  { label: "CC Visa",             text: "Payment card: 4111-1111-1111-1111" },
  { label: "CC Visa (no dash)",   text: "Card number 4111111111111111 on file" },
  { label: "CC MasterCard",       text: "My MasterCard is 5500-0000-0000-0004" },
  { label: "CC Amex",             text: "Use my Amex 3782-822463-10005" },
  // SSN variants
  { label: "SSN dashed",          text: "My social security number is 123-45-6789" },
  { label: "SSN dashed v2",       text: "SSN: 078-05-1120" },
  { label: "SSN no dash",         text: "SSN 123456789 is on the form" },
  { label: "SSN with context",    text: "Employee John Smith, Social Security Number: 219-09-9999, was hired on Jan 1." },
  { label: "SSN area/group real", text: "The applicant's SSN is 267-43-0927 as shown on the W-2 form." },
  // Multi-SIT
  { label: "CC + SSN together",   text: "Card 4111-1111-1111-1111 and SSN 267-43-0927" },
  // Edge cases
  { label: "fake SSN 000",        text: "SSN: 000-12-3456" },
  { label: "fake SSN 666",        text: "SSN: 666-12-3456" },
  { label: "fake SSN 9xx",        text: "SSN: 900-12-3456" },
];

for (const { label, text } of testCases) {
  const body = {
    contentToProcess: {
      contentEntries: [
        {
          "@odata.type": "microsoft.graph.processConversationMetadata",
          identifier: crypto.randomUUID(),
          content: { "@odata.type": "microsoft.graph.textContent", data: text },
          name: "DLP test",
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
        operatingSystemSpecifications: { operatingSystemPlatform: "macOS", operatingSystemVersion: "test" },
      },
      protectedAppMetadata: {
        name: "Agent Warden",
        version: "0.3.0",
        applicationLocation: { "@odata.type": "#microsoft.graph.policyLocationApplication", value: CLIENT_ID },
      },
      integratedAppMetadata: { name: "Agent Warden", version: "0.3.0" },
    },
  };

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${USER_ID}/dataSecurityAndGovernance/processContent`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );

  const raw = await resp.text();
  let data: any = {};
  try { data = JSON.parse(raw); } catch {}

  const actions = data.policyActions ?? [];
  const blocked = actions.some((a: any) => a.action === "restrictAccess" || a.action === "block");
  const status = blocked ? "BLOCKED" : "allowed";
  const icon = blocked ? "🚫" : "✅";

  console.log(`${icon} ${label.padEnd(22)} → ${status.padEnd(8)} actions=${JSON.stringify(actions)}`);
  if (data.processingErrors?.length) {
    console.log(`   errors: ${JSON.stringify(data.processingErrors)}`);
  }
}

console.log("\nDone.");
