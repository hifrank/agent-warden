import { ClientSecretCredential } from "@azure/identity";

const CLIENT_ID = "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET!;

// Check protectionScopes AND processContent for both tenants
const configs = [
  { label: "aprforazure (target)", tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3", userId: "21bbd518-a20d-41a6-a5da-78e097fda3e5" },
  { label: "working tenant",      tenantId: "2cf24558-0d31-439b-9c8d-6fdce3931ae7", userId: "7ade9412-3a6e-4b37-a3a8-51d8f81de596" },
];

const testText = "My SSN is 234-67-8901 and my credit card number is 4242424242424242";

for (const cfg of configs) {
  console.log(`\n=== ${cfg.label} ===`);
  const cred = new ClientSecretCredential(cfg.tenantId, CLIENT_ID, CLIENT_SECRET);
  const token = await cred.getToken("https://graph.microsoft.com/.default");

  // 1. protectionScopes
  const psUrl = `https://graph.microsoft.com/v1.0/users/${cfg.userId}/dataSecurityAndGovernance/protectionScopes/compute`;
  const psRes = await fetch(psUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ chatEnabled: true }),
  });
  const psData = await psRes.json();
  console.log("protectionScopes:", JSON.stringify(psData.value?.[0], null, 2));

  // 2. processContent
  const pcUrl = `https://graph.microsoft.com/v1.0/users/${cfg.userId}/dataSecurityAndGovernance/processContent`;
  const pcBody = {
    contentToProcess: {
      contentEntries: [{
        "@odata.type": "microsoft.graph.processConversationMetadata",
        identifier: crypto.randomUUID(),
        content: { "@odata.type": "microsoft.graph.textContent", data: testText },
        name: "comparison test",
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
        version: "0.5.5",
        applicationLocation: { "@odata.type": "#microsoft.graph.policyLocationApplication", value: CLIENT_ID },
      },
      integratedAppMetadata: { name: "Agent Warden", version: "0.5.5" },
    },
  };

  const pcRes = await fetch(pcUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(pcBody),
  });
  const pcData = await pcRes.json();
  const actions = pcData.policyActions ?? [];
  console.log("processContent HTTP:", pcRes.status);
  console.log("policyActions count:", actions.length);
  if (actions.length > 0) console.log("policyActions:", JSON.stringify(actions, null, 2));
  console.log("RESULT:", actions.length > 0 ? "BLOCK" : "ALLOW");
}
