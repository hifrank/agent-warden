import { ClientSecretCredential } from "@azure/identity";

const CLIENT_ID = "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET!;

const configs = [
  { label: "aprforazure (target)", tenantId: "dab94ed2-4cee-4b36-b007-6618f570b4a3", userId: "21bbd518-a20d-41a6-a5da-78e097fda3e5" },
  { label: "working tenant",      tenantId: "2cf24558-0d31-439b-9c8d-6fdce3931ae7", userId: "7ade9412-3a6e-4b37-a3a8-51d8f81de596" },
];

for (const cfg of configs) {
  const cred = new ClientSecretCredential(cfg.tenantId, CLIENT_ID, CLIENT_SECRET);
  const token = await cred.getToken("https://graph.microsoft.com/.default");

  const url = `https://graph.microsoft.com/v1.0/users/${cfg.userId}/dataSecurityAndGovernance/protectionScopes/compute`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ chatEnabled: true }),
  });
  const data = await res.json();
  const scope = data.value?.[0];
  console.log(`${cfg.label}:`);
  console.log(`  executionMode: ${scope?.executionMode}`);
  console.log(`  activities: ${scope?.activities}`);
  console.log(`  policyActions: ${JSON.stringify(scope?.policyActions)}`);
  console.log();
}
