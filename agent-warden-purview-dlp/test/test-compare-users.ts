/**
 * Quick test: compare processContent results between pod userId and test userId.
 * Verifies both users are covered by the DLP policy.
 */
import { ClientSecretCredential } from "@azure/identity";

const TENANT_ID = "2cf24558-0d31-439b-9c8d-6fdce3931ae7";
const CLIENT_ID = "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET;

if (!CLIENT_SECRET) {
  console.error("ERROR: PURVIEW_DLP_CLIENT_SECRET required");
  process.exit(1);
}

const POD_USER_ID = "3ed968e9-98cf-4e61-89f6-3ae3ec61614c";
const TEST_USER_ID = "7ade9412-3a6e-4b37-a3a8-51d8f81de596";

const credential = new ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET);
const tokenResult = await credential.getToken("https://graph.microsoft.com/.default");
const token = tokenResult.token;

const text = "Credit card number: 4242424242424242, SSN: 234-67-8901";

for (const [label, userId] of [["POD user", POD_USER_ID], ["TEST user", TEST_USER_ID]] as const) {
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
        operatingSystemSpecifications: { operatingSystemPlatform: "Linux", operatingSystemVersion: "AKS" },
      },
      protectedAppMetadata: {
        name: "Agent Warden",
        version: "0.3.0",
        applicationLocation: { "@odata.type": "#microsoft.graph.policyLocationApplication", value: CLIENT_ID },
      },
      integratedAppMetadata: { name: "Agent Warden", version: "0.3.0" },
    },
  };

  const url = `https://graph.microsoft.com/v1.0/users/${userId}/dataSecurityAndGovernance/processContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json() as any;
  const actions = data.policyActions ?? [];
  const blocked = actions.some((a: any) => a.action === "restrictAccess");
  console.log(`${label} (${userId}): HTTP ${resp.status} → ${blocked ? "BLOCKED" : "ALLOWED"}`);
  if (resp.status >= 400) console.log(`  Error: ${JSON.stringify(data.error)}`);
  if (actions.length > 0) console.log(`  Actions: ${JSON.stringify(actions)}`);
}
