import { getCosmosDb } from "../middleware/cosmos.js";
import { pushTraceLineage } from "../middleware/purview-governance.js";

// ──────────────────────────────────────────────────────────
// Lineage Aggregator — Correlates data.activity + data.llm
// events by traceId and pushes lineage to Purview Data Map.
//
// Runs on-demand via MCP tool or periodically via timer.
// ──────────────────────────────────────────────────────────

interface ActivityEvent {
  id?: string;
  type: "data.activity";
  tenantId: string;
  traceId: string;
  provider: string;
  operation: string;
  resourceType: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  responseBytes: number;
  timestamp: string;
}

interface LLMEvent {
  id?: string;
  type: "data.llm";
  tenantId: string;
  traceId: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  timestamp: string;
}

interface AggregatedTrace {
  traceId: string;
  tenantId: string;
  activities: ActivityEvent[];
  llmCalls: LLMEvent[];
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
}

/**
 * Query Cosmos governance container for un-processed events,
 * group by traceId, and push lineage to Purview.
 */
export async function aggregateAndPushLineage(
  cosmosEndpoint: string,
  cosmosDatabase: string,
  purviewEndpoint: string,
  options: {
    tenantId?: string;
    lookbackMinutes?: number;
    maxTraces?: number;
  } = {},
): Promise<{
  tracesProcessed: number;
  entitiesPushed: number;
  errors: string[];
}> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const container = db.container("governance");
  const lookback = options.lookbackMinutes ?? 30;
  const maxTraces = options.maxTraces ?? 100;
  const cutoff = new Date(Date.now() - lookback * 60_000).toISOString();

  // Query un-aggregated events
  const tenantFilter = options.tenantId ? `AND c.tenantId = @tenantId` : "";
  const query = {
    query: `SELECT * FROM c WHERE c.timestamp >= @cutoff AND c.type IN ('data.activity', 'data.llm') AND (NOT IS_DEFINED(c._lineagePushed) OR c._lineagePushed = false) ${tenantFilter} ORDER BY c.timestamp ASC`,
    parameters: [
      { name: "@cutoff", value: cutoff },
      ...(options.tenantId ? [{ name: "@tenantId", value: options.tenantId }] : []),
    ],
  };

  const { resources: events } = await container.items.query(query).fetchAll();

  // Group by traceId
  const traceMap = new Map<string, AggregatedTrace>();
  for (const event of events) {
    const traceId = event.traceId;
    if (!traceId) continue;

    if (!traceMap.has(traceId)) {
      traceMap.set(traceId, {
        traceId,
        tenantId: event.tenantId,
        activities: [],
        llmCalls: [],
        startedAt: event.timestamp,
        completedAt: event.timestamp,
        totalDurationMs: 0,
      });
    }

    const trace = traceMap.get(traceId)!;
    if (event.type === "data.activity") {
      trace.activities.push(event as ActivityEvent);
    } else if (event.type === "data.llm") {
      trace.llmCalls.push(event as LLMEvent);
    }

    if (event.timestamp < trace.startedAt) trace.startedAt = event.timestamp;
    if (event.timestamp > trace.completedAt) trace.completedAt = event.timestamp;
    trace.totalDurationMs += event.durationMs ?? 0;
  }

  let tracesProcessed = 0;
  let entitiesPushed = 0;
  const errors: string[] = [];

  // Process each trace (up to maxTraces)
  const traces = Array.from(traceMap.values()).slice(0, maxTraces);

  for (const trace of traces) {
    // Build input/output resource lists from activities
    const inputs: Array<{ provider: string; resourceType: string; qualifiedName: string; name: string }> = [];
    const outputs: Array<{ provider: string; resourceType: string; qualifiedName: string; name: string }> = [];
    const toolsUsed = new Set<string>();

    for (const activity of trace.activities) {
      const qn = `agent-warden://${trace.tenantId}/${activity.provider}/${activity.resourceType}`;
      const entry = {
        provider: activity.provider,
        resourceType: activity.resourceType,
        qualifiedName: qn,
        name: `${activity.provider}: ${activity.resourceType}`,
      };

      if (activity.operation === "read" || activity.operation === "list") {
        if (!inputs.find((i) => i.qualifiedName === qn)) inputs.push(entry);
      } else {
        if (!outputs.find((o) => o.qualifiedName === qn)) outputs.push(entry);
      }
      toolsUsed.add(`${activity.provider}-${activity.resourceType}`);
    }

    // Skip traces with no real data flow
    if (inputs.length === 0 && outputs.length === 0) continue;

    // Build LLM info from first LLM call (if any)
    const llm = trace.llmCalls.length > 0
      ? {
          model: trace.llmCalls[0].model,
          provider: trace.llmCalls[0].provider,
          promptTokens: trace.llmCalls.reduce((sum, c) => sum + c.promptTokens, 0),
          completionTokens: trace.llmCalls.reduce((sum, c) => sum + c.completionTokens, 0),
        }
      : undefined;

    // Push to Purview
    const result = await pushTraceLineage(purviewEndpoint, {
      tenantId: trace.tenantId,
      traceId: trace.traceId,
      toolsUsed: Array.from(toolsUsed),
      durationMs: trace.totalDurationMs,
      dlpViolations: 0,
      inputs,
      outputs,
      llm,
    });

    if (result.ok) {
      tracesProcessed++;
      entitiesPushed += inputs.length + outputs.length + (llm ? 1 : 0) + 1; // +1 for agent_process

      // Mark events as processed
      for (const activity of trace.activities) {
        if (activity?.id) {
          await container.item(activity.id, trace.tenantId)
            .patch([{ op: "add", path: "/_lineagePushed", value: true }])
            .catch(() => {}); // Best-effort
        }
      }
      for (const llmEvent of trace.llmCalls) {
        if (llmEvent?.id) {
          await container.item(llmEvent.id, trace.tenantId)
            .patch([{ op: "add", path: "/_lineagePushed", value: true }])
            .catch(() => {});
        }
      }

      // Write lineage summary to Cosmos
      await container.items.create({
        id: `lineage-${trace.traceId}`,
        type: "data.lineage",
        tenantId: trace.tenantId,
        traceId: trace.traceId,
        inputs: inputs.map((i) => ({ provider: i.provider, resourceType: i.resourceType })),
        outputs: outputs.map((o) => ({ provider: o.provider, resourceType: o.resourceType })),
        llm: llm ? { model: llm.model, provider: llm.provider, totalTokens: llm.promptTokens + llm.completionTokens } : null,
        toolsUsed: Array.from(toolsUsed),
        totalDurationMs: trace.totalDurationMs,
        purviewPushed: true,
        timestamp: trace.completedAt,
      }).catch(() => {}); // Ignore duplicate
    } else {
      errors.push(`Trace ${trace.traceId}: Purview push failed (status ${(result.data as string) || "unknown"})`);
    }
  }

  return { tracesProcessed, entitiesPushed, errors };
}
