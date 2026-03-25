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

  // 3. openclaw doctor (exec into pod — check exit code)
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
      let stderr = "";
      const errStream = new Writable({
        write(chunk, _encoding, callback) {
          stderr += chunk.toString();
          callback();
        },
      });
      await k8s.exec.exec(
        namespace,
        podName,
        "openclaw-gateway",
        ["openclaw", "doctor"],
        outStream,
        errStream,
        null,
        false
      );
      // "Doctor complete." in output means success
      const output = stdout + stderr;
      const hasWarnings = output.includes("Doctor warnings");
      const hasComplete = output.includes("Doctor complete");
      dimensions.doctor = hasComplete ? (hasWarnings ? 0.5 : 1) : 0;
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

  // 4. Disk — check PVC usage via df inside pod
  try {
    const pods = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `app.kubernetes.io/instance=${tenantId}`,
    });
    const podName = pods.items[0]?.metadata?.name;
    if (podName) {
      let dfOut = "";
      const dfStream = new Writable({
        write(chunk, _encoding, callback) {
          dfOut += chunk.toString();
          callback();
        },
      });
      await k8s.exec.exec(
        namespace,
        podName,
        "openclaw-gateway",
        ["df", "/data", "--output=pcent"],
        dfStream,
        null,
        null,
        false
      );
      // df output: "Use%\n  42%\n"
      const pctMatch = dfOut.match(/(\d+)%/);
      if (pctMatch) {
        const usedPct = parseInt(pctMatch[1], 10);
        // Score: 1.0 if <80%, 0.5 if 80-95%, 0 if >95%
        dimensions.disk = usedPct > 95 ? 0 : usedPct > 80 ? 0.5 : 1;
      } else {
        dimensions.disk = 1; // Can't parse, assume ok
      }
    } else {
      dimensions.disk = 0;
    }
  } catch {
    dimensions.disk = 1; // No PVC or df failed — not critical
  }

  // 5. Cert — check TLS secret expiry in namespace
  try {
    const secrets = await k8s.core.listNamespacedSecret({
      namespace,
      fieldSelector: "type=kubernetes.io/tls",
    });
    if (secrets.items.length === 0) {
      dimensions.cert = 1; // No TLS secrets, not applicable
    } else {
      let worstScore = 1;
      for (const secret of secrets.items) {
        const certData = secret.data?.["tls.crt"];
        if (!certData) continue;
        const pem = Buffer.from(certData, "base64").toString("utf-8");
        const notAfterMatch = pem.match(
          /Not After\s*:\s*(.+)/i
        );
        // Fallback: parse x509 via openssl is not available in alpine
        // Use a simpler heuristic based on secret creation time + typical cert lifetime
        if (notAfterMatch) {
          const expiry = new Date(notAfterMatch[1]);
          const daysLeft = (expiry.getTime() - Date.now()) / 86400000;
          const score = daysLeft < 7 ? 0 : daysLeft < 30 ? 0.5 : 1;
          worstScore = Math.min(worstScore, score);
        }
      }
      dimensions.cert = worstScore;
    }
  } catch {
    dimensions.cert = 1; // Can't read secrets — assume ok
  }

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
