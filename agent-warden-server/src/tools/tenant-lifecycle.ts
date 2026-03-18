import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getCosmosDb } from "../middleware/cosmos.js";
import { getK8sClients } from "../middleware/k8s.js";
import type {
  TenantProvisionInput,
  InstanceRecord,
} from "../config/types.js";

const execAsync = promisify(exec);

/**
 * Provision a new tenant: create Key Vault, Managed Identity,
 * Workload Identity federation, and deploy Helm chart.
 */
export async function provisionTenant(
  input: TenantProvisionInput,
  cosmosEndpoint: string,
  cosmosDatabase: string,
  acrLoginServer: string,
  helmChartPath: string
): Promise<InstanceRecord> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const namespace = `tenant-${input.tenantId}`;
  const instanceId = `oc-${input.tenantId}`;

  // 1. Create instance record in Cosmos DB
  const record: InstanceRecord = {
    tenantId: input.tenantId,
    instanceId,
    state: "Provisioning",
    version: "0.9.28",
    tier: input.tier,
    region: input.region,
    createdAt: new Date().toISOString(),
    activeChannels: input.channels
      .filter((c) => c.enabled)
      .map((c) => c.type),
    skillCount: 0,
    podCount: 0,
    messagesLast24h: 0,
    llmTokensLast24h: 0,
    ownerIdentity: input.adminEmail,
    tags: {},
  };
  await db.container("instances").items.create(record);

  // 2. Create per-tenant Key Vault via Azure CLI
  // (Terraform manages the platform vault; per-tenant vaults are dynamic)
  const kvName = `kv-${input.tenantId}`.substring(0, 24); // Key Vault name max 24 chars
  await execAsync(
    `az keyvault create --name ${kvName} --resource-group rg-agent-agentwarden-${input.region} ` +
      `--location ${input.region} --sku premium --enable-purge-protection true ` +
      `--enable-rbac-authorization true --no-wait`
  );

  // 3. Create per-tenant Managed Identity + Workload Identity federation
  const miName = `mi-${input.tenantId}`;
  const miResult = await execAsync(
    `az identity create --name ${miName} --resource-group rg-agent-agentwarden-${input.region} ` +
      `--location ${input.region} -o json`
  );
  const mi = JSON.parse(miResult.stdout) as {
    clientId: string;
    principalId: string;
  };

  // 4. Grant MI access to its Key Vault
  await execAsync(
    `az role assignment create --assignee ${mi.principalId} ` +
      `--role "Key Vault Secrets User" --scope $(az keyvault show --name ${kvName} --query id -o tsv)`
  );

  // 5. Deploy via Helm
  await execAsync(
    `helm upgrade --install ${instanceId} ${helmChartPath} ` +
      `--namespace ${namespace} --create-namespace ` +
      `--set tenantId=${input.tenantId} ` +
      `--set tier=${input.tier} ` +
      `--set keyVault.name=${kvName} ` +
      `--set keyVault.clientId=${mi.clientId} ` +
      `--set image.repository=${acrLoginServer}/openclaw ` +
      `--wait --timeout 5m`
  );

  // 6. Create Workload Identity federation (link K8s SA → Entra MI)
  const aksOidcIssuer = await execAsync(
    `az aks show --name $AKS_CLUSTER_NAME --resource-group $AKS_RESOURCE_GROUP --query oidcIssuerProfile.issuerUrl -o tsv`
  );
  await execAsync(
    `az identity federated-credential create --name fed-${input.tenantId} ` +
      `--identity-name ${miName} --resource-group rg-agent-agentwarden-${input.region} ` +
      `--issuer ${aksOidcIssuer.stdout.trim()} ` +
      `--subject system:serviceaccount:${namespace}:openclaw-${input.tenantId}`
  );

  // 7. Update state to Active
  record.state = "Active";
  record.podCount = 1;
  await db
    .container("instances")
    .item(record.instanceId, record.tenantId)
    .replace(record);

  return record;
}

/**
 * Suspend a tenant — scale StatefulSet to 0, retain PVCs.
 */
export async function suspendTenant(
  tenantId: string,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<void> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const k8s = getK8sClients();
  const namespace = `tenant-${tenantId}`;

  // Scale StatefulSet to 0
  await k8s.apps.patchNamespacedStatefulSet({
    name: `openclaw-${tenantId}`,
    namespace,
    body: { spec: { replicas: 0 } },
  } as any);

  // Update Cosmos DB
  const { resource } = await db
    .container("instances")
    .item(`oc-${tenantId}`, tenantId)
    .read<InstanceRecord>();
  if (resource) {
    resource.state = "Suspended";
    resource.podCount = 0;
    await db
      .container("instances")
      .item(resource.instanceId, tenantId)
      .replace(resource);
  }
}

/**
 * Delete a tenant — crypto-shred + remove resources.
 */
export async function deleteTenant(
  tenantId: string,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<void> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const namespace = `tenant-${tenantId}`;
  const kvName = `kv-${tenantId}`.substring(0, 24);

  // 1. Crypto-shred: purge the Key Vault (makes all secrets unrecoverable)
  await execAsync(`az keyvault delete --name ${kvName}`);
  // Note: purge protection means the vault enters soft-delete.
  // Actual purge happens after retention period. KEK is gone → data is unreadable.

  // 2. Delete Helm release (removes StatefulSet, pods)
  await execAsync(
    `helm uninstall oc-${tenantId} --namespace ${namespace} --wait`
  );

  // 3. Delete PVCs explicitly (Retain policy means they persist after uninstall)
  const k8s = getK8sClients();
  const pvcs = await k8s.core.listNamespacedPersistentVolumeClaim({ namespace });
  for (const pvc of pvcs.items) {
    await k8s.core.deleteNamespacedPersistentVolumeClaim({
      name: pvc.metadata!.name!,
      namespace,
    });
  }

  // 4. Delete namespace
  await k8s.core.deleteNamespace({ name: namespace });

  // 5. Delete Managed Identity
  await execAsync(
    `az identity delete --name mi-${tenantId} --resource-group rg-agent-agentwarden-eastus2`
  );

  // 6. Update Cosmos DB
  const { resource } = await db
    .container("instances")
    .item(`oc-${tenantId}`, tenantId)
    .read<InstanceRecord>();
  if (resource) {
    resource.state = "Deleted";
    await db
      .container("instances")
      .item(resource.instanceId, tenantId)
      .replace(resource);
  }
}
