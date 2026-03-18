/**
 * Sandbox execution monitoring tools for Agent Warden Server.
 *
 * Processes telemetry produced by sandbox-monitor running inside Kata microVMs.
 * Writes audit records to Cosmos DB and triggers SIEM incidents for high-risk executions.
 *
 * See design doc §4.1.1 "Sandbox Execution Monitor" and §17.7 "Runtime Skill Monitoring".
 */

import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

// ────────────────────────────────────────────────────────────────────
// Types (matches sandbox-monitor output schema)
// ────────────────────────────────────────────────────────────────────

export interface SandboxTelemetry {
  version: string;
  type: "sandbox.telemetry";
  tenantId: string;
  sessionId: string;
  toolName: string;
  skillName: string;
  execution: {
    command: string;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
  };
  processes: {
    total: number;
    tree: { pid: number; ppid: number; comm: string; args: string }[];
    suspicious: string[];
  };
  syscalls: {
    blocked: { syscall: string; count: number }[];
    totalAuditEvents: number;
  };
  filesystem: {
    filesCreated: string[];
    filesModified: string[];
    totalBytesWritten: number;
    suspiciousFiles: string[];
  };
  network: {
    connections: {
      proto: string;
      remoteAddr: string;
      remotePort: number;
      state: string;
    }[];
    dnsQueries: string[];
    totalBytesOut: number;
    totalBytesIn: number;
  };
  resources: {
    cpuMs: number;
    memoryPeakMb: number;
    ioBytesRead: number;
    ioBytesWrite: number;
  };
  risk: {
    score: number;
    factors: string[];
    action: "allow" | "flag" | "alert";
  };
}

export interface SandboxReportResult {
  recorded: boolean;
  riskScore: number;
  action: "allow" | "flag" | "alert";
  incidentCreated: boolean;
  auditId: string;
  factors: string[];
}

export interface SandboxAuditQuery {
  tenantId: string;
  minRiskScore?: number;
  action?: "allow" | "flag" | "alert";
  limit?: number;
}

// ────────────────────────────────────────────────────────────────────
// warden.sandbox.report — process telemetry from sandbox-monitor
// ────────────────────────────────────────────────────────────────────

export async function reportSandboxExecution(
  telemetry: SandboxTelemetry,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<SandboxReportResult> {
  const credential = new DefaultAzureCredential();
  const client = new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
  const db = client.database(cosmosDatabase);
  const auditContainer = db.container("audit");

  const auditRecord = {
    id: `sandbox-${telemetry.tenantId}-${Date.now()}`,
    type: "sandbox.execution",
    tenantId: telemetry.tenantId,
    sessionId: telemetry.sessionId,
    toolName: telemetry.toolName,
    skillName: telemetry.skillName,
    timestamp: new Date().toISOString(),
    execution: {
      command: telemetry.execution.command,
      exitCode: telemetry.execution.exitCode,
      signal: telemetry.execution.signal,
      durationMs: telemetry.execution.durationMs,
    },
    risk: telemetry.risk,
    summary: {
      processCount: telemetry.processes.total,
      suspiciousProcesses: telemetry.processes.suspicious,
      networkConnections: telemetry.network.connections.length,
      filesCreated: telemetry.filesystem.filesCreated.length,
      suspiciousFiles: telemetry.filesystem.suspiciousFiles,
      seccompViolations: telemetry.syscalls.blocked.length,
      cpuMs: telemetry.resources.cpuMs,
      memoryPeakMb: telemetry.resources.memoryPeakMb,
    },
  };

  await auditContainer.items.create(auditRecord);

  // For high-risk executions, we'd trigger a SIEM incident via Sentinel API.
  // The Log Analytics → Sentinel analytics rule (KQL) also catches these
  // from the pod log stream, providing defense-in-depth.
  const incidentCreated = telemetry.risk.score > 50;

  return {
    recorded: true,
    riskScore: telemetry.risk.score,
    action: telemetry.risk.action,
    incidentCreated,
    auditId: auditRecord.id,
    factors: telemetry.risk.factors,
  };
}

// ────────────────────────────────────────────────────────────────────
// warden.sandbox.audit — query sandbox execution history
// ────────────────────────────────────────────────────────────────────

export async function querySandboxAudit(
  query: SandboxAuditQuery,
  cosmosEndpoint: string,
  cosmosDatabase: string
): Promise<unknown[]> {
  const credential = new DefaultAzureCredential();
  const client = new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
  const db = client.database(cosmosDatabase);
  const auditContainer = db.container("audit");

  const conditions = [
    "c.type = 'sandbox.execution'",
    `c.tenantId = '${query.tenantId}'`,
  ];
  const params: { name: string; value: unknown }[] = [];

  if (query.minRiskScore !== undefined) {
    conditions.push("c.risk.score >= @minRisk");
    params.push({ name: "@minRisk", value: query.minRiskScore });
  }
  if (query.action) {
    conditions.push("c.risk.action = @action");
    params.push({ name: "@action", value: query.action });
  }

  const limit = query.limit ?? 50;
  const sql = `SELECT * FROM c WHERE ${conditions.join(" AND ")} ORDER BY c.timestamp DESC OFFSET 0 LIMIT ${limit}`;

  const { resources } = await auditContainer.items
    .query({ query: sql, parameters: params as { name: string; value: string | number | boolean | null }[] })
    .fetchAll();

  return resources;
}
