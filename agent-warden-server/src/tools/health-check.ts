import { getCosmosDb } from "../middleware/cosmos.js";
import { getK8sClients } from "../middleware/k8s.js";
import type { HealthCheckResult, InstanceRecord } from "../config/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Writable } from "node:stream";

const execAsync = promisify(exec);

// Health dimension weights (§21.3.3)
const WEIGHTS: Record<string, number> = {
  pod: 0.2,
  gateway: 0.15,
  channel: 0.15,
  llm: 0.15,
  resources: 0.1,
  messageProcessing: 0.1,
  skill: 0.05,
  disk: 0.05,
  cert: 0.025,
  doctor: 0.025,
};

/**
 * Run health check for a single tenant instance.
 */
export async function checkTenantHealth(
  tenantId: string,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<HealthCheckResult> {
  const k8s = getK8sClients();
  const namespace = `tenant-${tenantId}`;
  const dimensions: Record<string, number> = {};

  // 1. Pod status
  try {
    const pods = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `app.kubernetes.io/instance=${tenantId}`,
    });
    const allRunning = pods.items.every(
      (p) => p.status?.phase === "Running"
    );
    const anyCrashLoop = pods.items.some((p) =>
      p.status?.containerStatuses?.some(
        (cs) => (cs.restartCount ?? 0) > 5
      )
    );
    dimensions.pod = anyCrashLoop ? 0 : allRunning ? 1 : 0.5;
  } catch {
    dimensions.pod = 0;
  }

  // 2. Gateway connectivity (WebSocket ping)
  try {
    const svc = await k8s.core.readNamespacedService({
      name: `openclaw-${tenantId}`,
      namespace,
    });
    // Service exists — we assume connectivity if pod is running
    dimensions.gateway = svc ? (dimensions.pod >= 1 ? 1 : 0.5) : 0;
  } catch {
    dimensions.gateway = 0;
  }

  // 3. openclaw doctor (exec into pod)
  try {
    const pods = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `app.kubernetes.io/instance=${tenantId}`,
    });
    const podName = pods.items[0]?.metadata?.name;
    if (podName) {
      let stdout = "";
      const outStream = new Writable({
        write(chunk, _encoding, callback) {
          stdout += chunk.toString();
          callback();
        },
      });
      await k8s.exec.exec(
        namespace,
        podName,
        "openclaw-gateway",
        ["openclaw", "doctor", "--json"],
        outStream,
        null,
        null,
        false
      );
      const result = JSON.parse(stdout);
      const allPass = result.checks?.every(
        (c: { status: string }) => c.status === "pass"
      );
      dimensions.doctor = allPass ? 1 : 0.5;
    } else {
      dimensions.doctor = 0;
    }
  } catch {
    dimensions.doctor = 0;
  }

  // Simplified remaining dimensions based on pod health
  dimensions.channel = dimensions.pod >= 1 ? 1 : 0;
  dimensions.llm = dimensions.pod >= 1 ? 1 : 0.5;
  dimensions.resources = dimensions.pod >= 0.5 ? 1 : 0;
  dimensions.messageProcessing = dimensions.pod >= 1 ? 1 : 0.5;
  dimensions.skill = dimensions.pod >= 1 ? 1 : 0.5;
  dimensions.disk = 1; // TODO: check PVC usage via metrics API
  dimensions.cert = 1; // TODO: check TLS cert expiry

  // Calculate composite score
  let compositeScore = 0;
  for (const [dim, weight] of Object.entries(WEIGHTS)) {
    compositeScore += (dimensions[dim] ?? 0) * weight;
  }

  // Determine state
  let state: HealthCheckResult["state"];
  if (compositeScore >= 0.8) state = "Active";
  else if (compositeScore >= 0.5) state = "Degraded";
  else state = "Suspended"; // Will be overridden to escalation

  const result: HealthCheckResult = {
    tenantId,
    compositeScore: Math.round(compositeScore * 100) / 100,
    dimensions,
    state,
    timestamp: new Date().toISOString(),
  };

  // Update instance registry
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  try {
    const { resource } = await db
      .container("instances")
      .item(`oc-${tenantId}`, tenantId)
      .read<InstanceRecord>();
    if (resource) {
      resource.lastHealthCheck = result.timestamp;
      resource.healthStatus =
        compositeScore >= 0.8
          ? "Healthy"
          : compositeScore >= 0.5
            ? "Degraded"
            : "Unhealthy";
      if (resource.state === "Active" || resource.state === "Degraded") {
        resource.state = result.state;
      }
      await db
        .container("instances")
        .item(resource.instanceId, tenantId)
        .replace(resource);
    }
  } catch {
    // Instance not found — skip update
  }

  return result;
}

/**
 * Run health checks for all active tenant instances.
 */
export async function checkAllTenantsHealth(
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<HealthCheckResult[]> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const { resources } = await db
    .container("instances")
    .items.query<InstanceRecord>({
      query:
        "SELECT * FROM c WHERE c.state IN ('Active', 'Degraded')",
    })
    .fetchAll();

  const results: HealthCheckResult[] = [];
  for (const instance of resources) {
    const result = await checkTenantHealth(
      instance.tenantId,
      cosmosEndpoint,
      cosmosDatabase
    );
    results.push(result);
  }
  return results;
}
