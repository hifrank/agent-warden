import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getCosmosDb } from "../middleware/cosmos.js";
import { getK8sClients } from "../middleware/k8s.js";
import { generateKekValue } from "../middleware/envelope-crypto.js";
import type {
  TenantProvisionInput,
  InstanceRecord,
} from "../config/types.js";

const execAsync = promisify(exec);

/**
 * Provision a new tenant: create KEK in dedicated KEK Key Vault, Managed Identity,
 * Workload Identity federation, and deploy Helm chart via OCI registry.
 *
 * Two Key Vault architecture for tenant isolation:
 *   - sharedKvUrl: platform secrets (API keys, credentials) — vault-level RBAC
 *   - kekVaultUrl: per-tenant KEKs — secret-scoped RBAC (each MI sees only its own KEK)
 *
 * Server owns all Cosmos state transitions:
 *   → Provisioning (on start)
 *   → Active (on success)
 *   → Degraded + provisioningError (on failure)
 */
export async function provisionTenant(
  input: TenantProvisionInput,
  cosmosEndpoint: string,
  cosmosDatabase: string,
  acrLoginServer: string,
  helmChartVersion: string,
  sharedKvUrl: string,
  kekVaultUrl: string,
  resourceGroup: string,
  entraTenanId: string,
): Promise<InstanceRecord> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const namespace = `tenant-${input.tenantId}`;
  const instanceId = `oc-${input.tenantId}`;
  const region = input.region;
  const sharedKvName = new URL(sharedKvUrl).hostname.split(".")[0];
  const kekKvName = new URL(kekVaultUrl).hostname.split(".")[0];
  const kekSecretName = `kek-${input.tenantId}`;

  // Step labels for progress tracking
  const TOTAL_STEPS = 10;
  const stepLabels: Record<number, string> = {
    1: "Creating instance record",
    2: "Generating encryption key (KEK)",
    3: "Creating Managed Identity",
    4: "Creating DLP App Registration",
    5: "Assigning RBAC permissions",
    6: "Generating LiteLLM key",
    7: "Deploying Helm chart",
    8: "Creating Workload Identity federation",
    9: "Waiting for pods to become ready",
    10: "Finalizing",
  };

  async function updateStep(step: number) {
    record.provisioningStep = step;
    record.provisioningStepLabel = stepLabels[step];
    record.provisioningTotalSteps = TOTAL_STEPS;
    await db
      .container("instances")
      .item(record.instanceId, record.tenantId)
      .replace(record);
  }

  // 1. Create instance record in Cosmos DB (state: Provisioning)
  const record: InstanceRecord = {
    id: instanceId,
    tenantId: input.tenantId,
    instanceId,
    state: "Provisioning",
    version: helmChartVersion,
    tier: input.tier,
    region,
    createdAt: new Date().toISOString(),
    activeChannels: input.channels
      .filter((c) => c.enabled)
      .map((c) => c.type),
    skillCount: 0,
    podCount: 0,
    messagesLast24h: 0,
    llmTokensLast24h: 0,
    ownerIdentity: input.adminEmail,
    provisioningStep: 1,
    provisioningStepLabel: stepLabels[1],
    provisioningTotalSteps: TOTAL_STEPS,
    tags: {},
  };
  await db.container("instances").items.upsert(record);

  try {
    // 2. Generate KEK and store in dedicated KEK Key Vault
    await updateStep(2);
    //    If a soft-deleted secret with the same name exists, recover it first then overwrite.
    const kekValue = generateKekValue();
    try {
      await execAsync(
        `az keyvault secret set --vault-name ${kekKvName} ` +
          `--name ${kekSecretName} --value ${kekValue} -o none`
      );
    } catch (e: any) {
      if (e.message?.includes("ObjectIsDeletedButRecoverable")) {
        await execAsync(
          `az keyvault secret recover --vault-name ${kekKvName} --name ${kekSecretName} -o none`
        );
        // Wait briefly for recovery to complete
        await new Promise((r) => setTimeout(r, 5000));
        await execAsync(
          `az keyvault secret set --vault-name ${kekKvName} ` +
            `--name ${kekSecretName} --value ${kekValue} -o none`
        );
      } else {
        throw e;
      }
    }

    // 3. Create per-tenant Managed Identity
    await updateStep(3);
    const miName = `mi-${input.tenantId}`;
    const miResult = await execAsync(
      `az identity create --name ${miName} ` +
        `--resource-group ${resourceGroup} ` +
        `--location ${region} -o json`
    );
    const mi = JSON.parse(miResult.stdout) as {
      clientId: string;
      principalId: string;
    };

    // 4. Create per-agent DLP App Registration in E5 tenant (if admin app is configured)
    await updateStep(4);
    let dlpAppRegistration: any = null;
    try {
      const settingsContainer = db.container("settings");
      const { resource: globalSettingsForDlp } = await settingsContainer.item("global", "global").read();
      if (globalSettingsForDlp?.e5Tenant?.adminApp?.clientId && globalSettingsForDlp?.e5Tenant?.purviewTenantId) {
        const { provisionDlpAppRegistration } = await import("./e5-graph-client.js");
        dlpAppRegistration = await provisionDlpAppRegistration(
          input.tenantId,
          globalSettingsForDlp.e5Tenant.purviewTenantId,
          globalSettingsForDlp.e5Tenant.adminApp,
          kekVaultUrl,
        );
        // Store DLP app registration on the instance record
        await db.container("instances").item(record.instanceId, record.tenantId).patch([
          { op: "add", path: "/dlpAppRegistration", value: dlpAppRegistration },
        ]);
        // Also store the client secret in Key Vault for SecretProviderClass
        const { envelopeDecrypt } = await import("../middleware/envelope-crypto.js");
        const dlpClientSecret = await envelopeDecrypt(dlpAppRegistration.encryptedClientSecret, kekVaultUrl);
        await execAsync(
          `az keyvault secret set --vault-name ${sharedKvName} ` +
            `--name purview-dlp-client-id-${input.tenantId} --value ${dlpAppRegistration.appId} -o none`
        );
        await execAsync(
          `az keyvault secret set --vault-name ${sharedKvName} ` +
            `--name purview-dlp-client-secret-${input.tenantId} --value '${dlpClientSecret}' -o none`
        );
      }
    } catch (dlpErr) {
      // DLP app creation is non-fatal — log and continue
      console.error(`[provision] DLP app registration failed for ${input.tenantId}:`, dlpErr);
    }

    // 5. Grant MI RBAC — split across two Key Vaults for tenant isolation:
    await updateStep(5);
    //    - Shared KV: vault-level (all platform secrets are shared across tenants)
    //    - KEK KV: secret-scoped (each MI can only read its own KEK)
    //    Use --assignee-object-id + --assignee-principal-type to avoid Graph propagation delay
    const [sharedKvId, kekKvId] = await Promise.all([
      execAsync(`az keyvault show --name ${sharedKvName} --query id -o tsv`).then(r => r.stdout.trim()),
      execAsync(`az keyvault show --name ${kekKvName} --query id -o tsv`).then(r => r.stdout.trim()),
    ]);

    await Promise.all([
      // Vault-level on shared KV (platform secrets — same for all tenants)
      execAsync(
        `az role assignment create --assignee-object-id ${mi.principalId} ` +
          `--assignee-principal-type ServicePrincipal ` +
          `--role "Key Vault Secrets User" ` +
          `--scope ${sharedKvId}`
      ),
      // Secret-scoped on KEK KV (only this tenant's KEK)
      execAsync(
        `az role assignment create --assignee-object-id ${mi.principalId} ` +
          `--assignee-principal-type ServicePrincipal ` +
          `--role "Key Vault Secrets User" ` +
          `--scope ${kekKvId}/secrets/${kekSecretName}`
      ),
    ]);

    // 6. Fetch shared LiteLLM proxy master key
    await updateStep(6);
    const { stdout: litellmMasterKey } = await execAsync(
      `kubectl get secret litellm-proxy-secret -n agent-warden-system -o jsonpath='{.data.master-key}' | base64 -d`
    );

    // 7. Deploy via Helm (OCI registry) — without --wait first
    await updateStep(7);
    //    Login to ACR for OCI helm chart pull
    const acrName = acrLoginServer.split('.')[0];
    const acrToken = await execAsync(
      `az acr login --name ${acrName} --expose-token --query accessToken -o tsv`
    );
    await execAsync(
      `helm registry login ${acrLoginServer} --username 00000000-0000-0000-0000-000000000000 ` +
        `--password '${acrToken.stdout.trim()}'`
    );
    //    First, clean up any stuck release from a previous failed attempt
    const chartRef = `oci://${acrLoginServer}/helm/openclaw-tenant`;
    try {
      const status = await execAsync(
        `helm status ${instanceId} -n ${namespace} -o json 2>/dev/null`
      );
      const info = JSON.parse(status.stdout);
      if (info?.info?.status?.startsWith("pending-")) {
        await execAsync(
          `helm uninstall ${instanceId} -n ${namespace} --no-hooks`
        );
      }
    } catch {
      // No existing release — that's fine
    }
    //    Build shared --set flags (used in both step 7 and step 9)
    //    Read DLP settings from global settings in Cosmos
    let purviewUserId = "";
    let purviewTenantId = "";
    let dlpEnabled = true;
    let dlpMode = "enforce";
    let layerPromptGuard = true;
    let layerOutputScanner = true;
    let layerInputAudit = true;
    try {
      const settingsContainer = db.container("settings");
      const { resource: globalSettings } = await settingsContainer.item("global", "global").read();
      if (globalSettings?.e5Tenant) {
        purviewTenantId = globalSettings.e5Tenant.purviewTenantId ?? "";
        dlpEnabled = globalSettings.e5Tenant.enabledByDefault !== false;
        dlpMode = globalSettings.e5Tenant.defaultMode ?? "enforce";
        if (globalSettings.e5Tenant.defaultLayers) {
          layerPromptGuard = globalSettings.e5Tenant.defaultLayers.promptGuard !== false;
          layerOutputScanner = globalSettings.e5Tenant.defaultLayers.outputScanner !== false;
          layerInputAudit = globalSettings.e5Tenant.defaultLayers.inputAudit !== false;
        }
      }
    } catch {
      // settings container may not exist yet — fall back to defaults
    }

    // Per-agent userId: read from the instance record's dlpConfig (set via Instance Detail UI)
    purviewUserId = record.dlpConfig?.userId ?? "";

    const helmSets = [
      `--set tenantId=${input.tenantId}`,
      `--set tier=${input.tier}`,
      `--set keyVault.name=${sharedKvName}`,
      `--set keyVault.kekSecretName=${kekSecretName}`,
      `--set keyVault.clientId=${mi.clientId}`,
      `--set keyVault.tenantIdEntra=${entraTenanId}`,
      `--set image.repository=${acrLoginServer}/openclaw`,
      `--set litellmProxy.shared=true`,
      `--set litellmProxy.masterKey=${litellmMasterKey.trim()}`,
      `--set azureOpenAI.baseModel=${input.model}`,
      // Plugins — agents-view and purview-dlp are installed for every tenant
      `--set agentsViewPlugin.enabled=true`,
      `--set purviewDlpPlugin.enabled=${dlpEnabled}`,
      `--set purviewDlpPlugin.mode=${dlpMode}`,
      `--set purviewDlpPlugin.layers.promptGuard=${layerPromptGuard}`,
      `--set purviewDlpPlugin.layers.outputScanner=${layerOutputScanner}`,
      `--set purviewDlpPlugin.layers.inputAudit=${layerInputAudit}`,
      ...(purviewUserId ? [`--set purviewDlpPlugin.purviewUserId=${purviewUserId}`] : []),
      ...(purviewTenantId ? [`--set purviewDlpPlugin.purviewTenantId=${purviewTenantId}`] : []),
      // Browser init for tool support
      `--set browserInit.enabled=true`,
    ].join(" ");

    await execAsync(
      `helm upgrade --install ${instanceId} ${chartRef} ` +
        `--version ${helmChartVersion} ` +
        `--namespace ${namespace} --create-namespace ` +
        `${helmSets} ` +
        `--timeout 5m`
    );

    // 8. Create Workload Identity federation (link K8s SA → Entra MI)
    await updateStep(8);
    //    Must happen AFTER helm creates the ServiceAccount but BEFORE pods need tokens
    const aksOidcIssuer = await execAsync(
      `az aks show --name $AKS_CLUSTER_NAME --resource-group $AKS_RESOURCE_GROUP ` +
        `--query oidcIssuerProfile.issuerUrl -o tsv`
    );
    await execAsync(
      `az identity federated-credential create --name fed-${input.tenantId} ` +
        `--identity-name ${miName} --resource-group ${resourceGroup} ` +
        `--issuer ${aksOidcIssuer.stdout.trim()} ` +
        `--subject system:serviceaccount:${namespace}:openclaw-${input.tenantId}`
    );

    // 9. Wait for rollout to complete
    await updateStep(9);
    await execAsync(
      `helm upgrade --install ${instanceId} ${chartRef} ` +
        `--version ${helmChartVersion} ` +
        `--namespace ${namespace} ` +
        `${helmSets} ` +
        `--wait --timeout 5m`
    );

    // 10. Update state to Active
    await updateStep(10);
    record.state = "Active";
    record.podCount = 1;
    delete record.provisioningStep;
    delete record.provisioningStepLabel;
    delete record.provisioningTotalSteps;
    await db
      .container("instances")
      .item(record.instanceId, record.tenantId)
      .replace(record);
  } catch (err) {
    // Provisioning failed — mark as Degraded with error details
    record.state = "Degraded";
    record.provisioningError =
      err instanceof Error ? err.message : String(err);
    await db
      .container("instances")
      .item(record.instanceId, record.tenantId)
      .replace(record);
  }

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
 * Delete a tenant — set state to Deleting, then async cleanup:
 * crypto-shred via KEK deletion + remove all Azure/K8s resources.
 * Sets state to Deleted when done (record remains for UI to show).
 */
export async function deleteTenant(
  tenantId: string,
  cosmosEndpoint: string,
  cosmosDatabase: string,
  sharedKvUrl: string,
  kekVaultUrl: string,
  resourceGroup: string,
): Promise<void> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const namespace = `tenant-${tenantId}`;

  // Read existing record
  const { resource } = await db
    .container("instances")
    .item(`oc-${tenantId}`, tenantId)
    .read<InstanceRecord>();
  if (!resource) throw new Error(`Instance ${tenantId} not found`);

  // Immediately set state to Deleting
  resource.state = "Deleting";
  resource.provisioningStep = 1;
  resource.provisioningStepLabel = "Starting cleanup";
  resource.provisioningTotalSteps = 5;
  delete resource.provisioningError;
  await db.container("instances").item(resource.instanceId, tenantId).replace(resource);

  // Run cleanup async — caller returns immediately
  const kekKvName = new URL(kekVaultUrl).hostname.split(".")[0];
  const kekSecretName = `kek-${tenantId}`;

  const updateDeleteStep = async (step: number, label: string) => {
    resource.provisioningStep = step;
    resource.provisioningStepLabel = label;
    await db.container("instances").item(resource.instanceId, tenantId).replace(resource);
  };

  // Fire-and-forget cleanup
  (async () => {
    try {
      // 1. Crypto-shred: delete KEK
      await updateDeleteStep(1, "Crypto-shredding encryption key");
      await execAsync(
        `az keyvault secret delete --vault-name ${kekKvName} --name ${kekSecretName} -o none`
      ).catch(() => {});

      // 2. Delete Helm release
      await updateDeleteStep(2, "Removing Helm release");
      await execAsync(
        `helm uninstall oc-${tenantId} --namespace ${namespace} --wait`
      ).catch(() => {});

      // 3. Delete PVCs + namespace
      await updateDeleteStep(3, "Cleaning up Kubernetes resources");
      const k8s = getK8sClients();
      try {
        const pvcs = await k8s.core.listNamespacedPersistentVolumeClaim({ namespace });
        for (const pvc of pvcs.items) {
          await k8s.core.deleteNamespacedPersistentVolumeClaim({
            name: pvc.metadata!.name!,
            namespace,
          });
        }
      } catch { /* namespace may not exist */ }
      await k8s.core.deleteNamespace({ name: namespace }).catch(() => {});

      // 4. Delete Managed Identity
      await updateDeleteStep(4, "Removing Managed Identity");
      await execAsync(
        `az identity delete --name mi-${tenantId} --resource-group ${resourceGroup}`
      ).catch(() => {});

      // 4b. Delete channel configs from Cosmos (telegram, etc.)
      try {
        const tenants = db.container("tenants");
        const { resources: channelDocs } = await tenants.items
          .query({
            query: "SELECT c.id FROM c WHERE c.tenantId = @tid AND c.type = 'telegram-channel'",
            parameters: [{ name: "@tid", value: tenantId }],
          })
          .fetchAll();
        for (const doc of channelDocs) {
          await tenants.item(doc.id, tenantId).delete().catch(() => {});
        }
      } catch { /* tenants container may not exist */ }

      // 5. Mark as Deleted
      await updateDeleteStep(5, "Cleanup complete");
      resource.state = "Deleted";
      delete resource.provisioningStep;
      delete resource.provisioningStepLabel;
      delete resource.provisioningTotalSteps;
      await db.container("instances").item(resource.instanceId, tenantId).replace(resource);
    } catch (err) {
      console.error(`[deleteTenant] Cleanup error for ${tenantId}:`, err);
      resource.state = "Degraded";
      resource.provisioningError = `Deletion failed: ${err instanceof Error ? err.message : String(err)}`;
      await db.container("instances").item(resource.instanceId, tenantId).replace(resource).catch(() => {});
    }
  })();
}

/**
 * Remove a deleted tenant's record from Cosmos DB (final cleanup).
 */
export async function removeTenantRecord(
  tenantId: string,
  cosmosEndpoint: string,
  cosmosDatabase: string,
): Promise<void> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const { resource } = await db
    .container("instances")
    .item(`oc-${tenantId}`, tenantId)
    .read<InstanceRecord>();
  if (!resource) throw new Error(`Instance ${tenantId} not found`);
  if (resource.state !== "Deleted") {
    throw new Error(`Cannot remove record: instance is ${resource.state}, not Deleted`);
  }
  await db.container("instances").item(resource.instanceId, tenantId).delete();
}
