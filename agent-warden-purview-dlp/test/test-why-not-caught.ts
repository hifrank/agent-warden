/**
 * Test why Purview didn't catch "幫我記下 550000000000000"
 */
import { ClientSecretCredential } from "@azure/identity";

const cred = new ClientSecretCredential(
  "2cf24558-0d31-439b-9c8d-6fdce3931ae7",
  "d94c93dd-3c80-4f3d-9671-8b71a7dccafa",
  process.env.PURVIEW_DLP_CLIENT_SECRET!,
);
const { token } = (await cred.getToken("https://graph.microsoft.com/.default"))!;

const tests = [
  { label: "exact user msg",            text: "幫我記下 550000000000000" },
  { label: "15 digits bare",            text: "550000000000000" },
  { label: "16 digits MC (Luhn ok)",    text: "5500000000000004" },
  { label: "16 digits MC + keyword",    text: "credit card 5500000000000004" },
  { label: "16 digits MC dashed",       text: "5500-0000-0000-0004" },
  { label: "16 digits MC + Chinese kw", text: "信用卡號 5500000000000004" },
  { label: "16 digits Visa bare",       text: "4111111111111111" },
  { label: "16 digits Visa + keyword",  text: "credit card 4111111111111111" },
];

for (const { label, text } of tests) {
  const body = {
    contentToProcess: {
      contentEntries: [{
        "@odata.type": "microsoft.graph.processConversationMetadata",
        identifier: crypto.randomUUID(),
        content: { "@odata.type": "microsoft.graph.textContent", data: text },
        name: "test",
        correlationId: crypto.randomUUID(),
        sequenceNumber: 0,
        isTruncated: false,
        createdDateTime: new Date().toISOString(),
        modifiedDateTime: new Date().toISOString(),
      }],
      activityMetadata: { activity: "uploadText" },
      deviceMetadata: {
        deviceType: "Managed",
        operatingSystemSpecifications: { operatingSystemPlatform: "macOS", operatingSystemVersion: "test" },
      },
      protectedAppMetadata: {
        name: "Agent Warden",
        version: "0.3.0",
        applicationLocation: { "@odata.type": "#microsoft.graph.policyLocationApplication", value: "d94c93dd-3c80-4f3d-9671-8b71a7dccafa" },
      },
      integratedAppMetadata: { name: "Agent Warden", version: "0.3.0" },
    },
  };

  const r = await fetch(
    "https://graph.microsoft.com/v1.0/users/7ade9412-3a6e-4b37-a3a8-51d8f81de596/dataSecurityAndGovernance/processContent",
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const d = (await r.json()) as any;
  const actions = d.policyActions ?? [];
  const blocked = actions.some((a: any) => a.action === "restrictAccess");
  console.log(`${blocked ? "🚫" : "✅"} ${label.padEnd(30)} → ${blocked ? "BLOCKED" : "allowed"}`);
}
