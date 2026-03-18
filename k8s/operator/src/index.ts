import * as k8s from "@kubernetes/client-node";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const GROUP = "openclaw.io";
const VERSION = "v1alpha1";
const PLURAL = "openclawtenants";
const HELM_CHART =
  process.env.HELM_CHART_PATH ?? "/app/charts/openclaw-tenant";
const ACR_SERVER = process.env.ACR_LOGIN_SERVER ?? "";

interface OpenClawTenantSpec {
  tenantId: string;
  tier: string;
  adminEmail: string;
  region: string;
  version: string;
  channels: Array<{ type: string; enabled: boolean }>;
  suspended: boolean;
  keyVault?: {
    name: string;
    clientId: string;
    tenantIdEntra: string;
  };
  gitSync?: {
    enabled: boolean;
    repo: string;
  };
}

interface OpenClawTenantStatus {
  state: string;
  healthScore?: number;
  healthStatus?: string;
  podCount?: number;
  message?: string;
}

interface OpenClawTenant {
  metadata: k8s.V1ObjectMeta;
  spec: OpenClawTenantSpec;
  status?: OpenClawTenantStatus;
}

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
const appsApi = kc.makeApiClient(k8s.AppsV1Api);

async function updateStatus(
  name: string,
  status: Partial<OpenClawTenantStatus>
): Promise<void> {
  await customApi.patchClusterCustomObjectStatus({
    group: GROUP,
    version: VERSION,
    plural: PLURAL,
    name,
    body: { status },
  } as any);
}

async function reconcile(tenant: OpenClawTenant): Promise<void> {
  const { spec, metadata } = tenant;
  const name = metadata.name!;
  const ns = `tenant-${spec.tenantId}`;
  const releaseName = `oc-${spec.tenantId}`;

  console.log(`Reconciling ${name} (state: ${tenant.status?.state ?? "unknown"})`);

  try {
    // Handle suspension
    if (spec.suspended) {
      await updateStatus(name, { state: "Suspended", message: "Tenant suspended by operator" });
      // Scale down
      try {
        await appsApi.patchNamespacedStatefulSet({
          name: `openclaw-${spec.tenantId}`,
          namespace: ns,
          body: { spec: { replicas: 0 } },
        } as any);
      } catch {
        // StatefulSet may not exist yet
      }
      return;
    }

    // Provision or update via Helm
    await updateStatus(name, { state: "Provisioning", message: "Running Helm upgrade" });

    const helmArgs = [
      `helm upgrade --install ${releaseName} ${HELM_CHART}`,
      `--namespace ${ns} --create-namespace`,
      `--set tenantId=${spec.tenantId}`,
      `--set tier=${spec.tier}`,
      `--set image.tag=${spec.version}`,
    ];

    if (ACR_SERVER) {
      helmArgs.push(`--set image.repository=${ACR_SERVER}/openclaw`);
    }

    if (spec.keyVault) {
      helmArgs.push(`--set keyVault.name=${spec.keyVault.name}`);
      helmArgs.push(`--set keyVault.clientId=${spec.keyVault.clientId}`);
      helmArgs.push(`--set keyVault.tenantIdEntra=${spec.keyVault.tenantIdEntra}`);
    }

    if (spec.gitSync?.enabled && spec.gitSync.repo) {
      helmArgs.push(`--set gitSync.enabled=true`);
      helmArgs.push(`--set gitSync.repo=${spec.gitSync.repo}`);
    }

    helmArgs.push("--wait --timeout 5m");

    await execAsync(helmArgs.join(" "));

    await updateStatus(name, {
      state: "Active",
      podCount: 1,
      message: "Tenant provisioned successfully",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to reconcile ${name}:`, message);
    await updateStatus(name, {
      state: "Degraded",
      message: `Reconciliation failed: ${message.substring(0, 200)}`,
    });
  }
}

async function main(): Promise<void> {
  console.log("Agent Warden Operator starting...");

  // Apply CRD in case it's not present
  try {
    await execAsync("kubectl apply -f /app/config/crd/");
    console.log("CRD applied.");
  } catch (err) {
    console.error("CRD apply failed (may already exist):", err);
  }

  // Watch for OpenClawTenant CRs
  const watch = new k8s.Watch(kc);

  const startWatch = () => {
    watch.watch(
      `/apis/${GROUP}/${VERSION}/${PLURAL}`,
      {},
      (type: string, obj: OpenClawTenant) => {
        console.log(`Event: ${type} for ${obj.metadata.name}`);
        if (type === "ADDED" || type === "MODIFIED") {
          reconcile(obj).catch(console.error);
        }
        // DELETED: namespace cleanup is handled by warden.tenant.delete MCP tool
      },
      (err: Error) => {
        console.error("Watch error, restarting in 5s:", err?.message);
        setTimeout(startWatch, 5000);
      }
    );
  };

  startWatch();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
