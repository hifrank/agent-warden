/**
 * Application Insights query client for OTel trace spans.
 * Uses the Logs query API against workspace-based App Insights
 * (table: AppDependencies, not classic "dependencies").
 */
import { LogsQueryClient } from "@azure/monitor-query";
import { DefaultAzureCredential } from "@azure/identity";
import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { execFile } from "child_process";
import { promisify } from "util";
import type { TraceSpan, EndToEndTransaction, ActivityMetrics, ToolCallStat, ModelStat, DailyPoint, TokensByModel } from "$lib/types";

const execFileAsync = promisify(execFile);

/**
 * Custom credential that uses `az account get-access-token --subscription <id>`.
 * Needed when Log Analytics is in a different tenant with a different az CLI identity.
 */
class AzCliSubscriptionCredential implements TokenCredential {
  constructor(private subscriptionId: string) {}

  async getToken(scopes: string | string[]): Promise<AccessToken> {
    const scope = Array.isArray(scopes) ? scopes[0] : scopes;
    const resource = scope.replace(/\/.default$/, "");
    const { stdout } = await execFileAsync("az", [
      "account", "get-access-token",
      "--subscription", this.subscriptionId,
      "--resource", resource,
      "-o", "json",
    ]);
    const result = JSON.parse(stdout);
    return {
      token: result.accessToken,
      expiresOnTimestamp: new Date(result.expiresOn).getTime(),
    };
  }
}

let _client: LogsQueryClient | undefined;

function getLogsClient(): LogsQueryClient {
  if (_client) return _client;
  // Log Analytics may be in a different subscription/tenant than Cosmos DB,
  // with a different az CLI identity. Use LOG_ANALYTICS_SUBSCRIPTION_ID to
  // route token acquisition through that subscription's cached identity.
  const subscriptionId = process.env.LOG_ANALYTICS_SUBSCRIPTION_ID;
  const credential: TokenCredential = subscriptionId
    ? new AzCliSubscriptionCredential(subscriptionId)
    : new DefaultAzureCredential();
  _client = new LogsQueryClient(credential);
  return _client;
}

/**
 * Query end-to-end transactions for a tenant from Application Insights.
 */
export async function queryTransactions(
  appId: string,
  tenantId: string,
  daysBack = 30,
): Promise<EndToEndTransaction[]> {
  const client = getLogsClient();

  const kusto = `
    AppDependencies
    | where TimeGenerated > ago(${daysBack}d)
    | extend props = todynamic(Properties)
    | where tostring(props["tenant.id"]) == "${tenantId}"
        or (tostring(props["tenant.id"]) == "" and tostring(props["host.name"]) startswith "openclaw-${tenantId}")
    | where tostring(props["gen_ai.operation.name"]) in ("invoke_agent", "chat", "execute_tool")
        or Name in ("openclaw.message.processed", "openclaw.model.usage")
    | project
        traceId = OperationId,
        spanId = Id,
        parentSpanId = ParentId,
        operationName = case(
            Name == "openclaw.message.processed", "invoke_agent",
            Name == "openclaw.model.usage", "chat",
            tostring(props["gen_ai.operation.name"])),
        agentName = coalesce(tostring(props["gen_ai.agent.name"]), "openclaw-agent"),
        model = coalesce(tostring(props["gen_ai.request.model"]), tostring(props["openclaw.model"])),
        provider = coalesce(tostring(props["gen_ai.provider.name"]), tostring(props["openclaw.provider"])),
        startTime = TimeGenerated,
        durationMs = DurationMs,
        inputTokens = coalesce(toint(props["gen_ai.usage.input_tokens"]), toint(props["openclaw.tokens.input"])),
        outputTokens = coalesce(toint(props["gen_ai.usage.output_tokens"]), toint(props["openclaw.tokens.output"])),
        toolName = tostring(props["gen_ai.tool.name"]),
        statusCode = tostring(props["otel.status_code"]),
        errorMessage = tostring(props["error.message"]),
        allDimensions = props
    | order by startTime desc
    | take 5000
  `;

  const result = await client.queryWorkspace(appId, kusto, {
    duration: `P${daysBack}D`,
  });

  if (result.status !== "Success" || !result.tables.length) return [];

  const table = result.tables[0];
  const spans: (TraceSpan & { _traceId: string })[] = [];

  for (const row of table.rows) {
    const cols = table.columns;
    const get = (name: string) => {
      const idx = cols.findIndex((c) => c.name === name);
      return idx >= 0 ? row[idx] : undefined;
    };

    const attrs: Record<string, string> = {};
    const dims = get("allDimensions");
    if (dims && typeof dims === "object") {
      for (const [k, v] of Object.entries(dims as Record<string, unknown>)) {
        attrs[k] = String(v);
      }
    } else if (typeof dims === "string") {
      try {
        const parsed = JSON.parse(dims);
        for (const [k, v] of Object.entries(parsed)) attrs[k] = String(v);
      } catch { /* skip */ }
    }

    spans.push({
      _traceId: String(get("traceId")),
      traceId: String(get("traceId")),
      spanId: String(get("spanId")),
      parentSpanId: get("parentSpanId") ? String(get("parentSpanId")) : undefined,
      operationName: get("operationName") as TraceSpan["operationName"],
      agentName: String(get("agentName") || "openclaw-agent"),
      model: get("model") ? String(get("model")) : undefined,
      provider: get("provider") ? String(get("provider")) : undefined,
      startTime: new Date(get("startTime") as string).toISOString(),
      durationMs: Number(get("durationMs")),
      inputTokens: get("inputTokens") != null ? Number(get("inputTokens")) : undefined,
      outputTokens: get("outputTokens") != null ? Number(get("outputTokens")) : undefined,
      toolName: get("toolName") ? String(get("toolName")) : undefined,
      status: String(get("statusCode")) === "STATUS_CODE_ERROR" ? "error" : "ok",
      errorMessage: get("errorMessage") ? String(get("errorMessage")) : undefined,
      attributes: attrs,
    });
  }

  // Group by traceId into end-to-end transactions
  const byTrace = new Map<string, (TraceSpan & { _traceId: string })[]>();
  for (const s of spans) {
    if (!byTrace.has(s._traceId)) byTrace.set(s._traceId, []);
    byTrace.get(s._traceId)!.push(s);
  }

  const txns: EndToEndTransaction[] = [];
  for (const [traceId, group] of byTrace) {
    const root = group.find((s) => s.operationName === "invoke_agent");
    if (!root) continue;
    const children = group
      .filter((s) => s.spanId !== root.spanId)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    txns.push({ traceId, rootSpan: root, childSpans: children });
  }

  txns.sort((a, b) => new Date(b.rootSpan.startTime).getTime() - new Date(a.rootSpan.startTime).getTime());
  return txns;
}

/**
 * Query aggregated activity metrics for a tenant from Application Insights.
 */
export async function queryActivityMetrics(
  appId: string,
  tenantId: string,
  daysBack = 28,
): Promise<ActivityMetrics> {
  const client = getLogsClient();

  // Query 1: daily agent runs
  // Supports both agents-view (gen_ai.operation.name) and diagnostics-otel (openclaw.message.processed) span formats
  const dailyRunsKusto = `
    AppDependencies
    | where TimeGenerated > ago(${daysBack}d)
    | extend props = todynamic(Properties)
    | where tostring(props["tenant.id"]) == "${tenantId}"
        or (tostring(props["tenant.id"]) == "" and tostring(props["host.name"]) startswith "openclaw-${tenantId}")
    | where tostring(props["gen_ai.operation.name"]) == "invoke_agent"
        or Name == "openclaw.message.processed"
    | summarize count() by bin(TimeGenerated, 1d)
    | order by TimeGenerated asc
  `;

  // Query 2: tool call stats
  const toolStatsKusto = `
    AppDependencies
    | where TimeGenerated > ago(${daysBack}d)
    | extend props = todynamic(Properties)
    | where tostring(props["tenant.id"]) == "${tenantId}"
        or (tostring(props["tenant.id"]) == "" and tostring(props["host.name"]) startswith "openclaw-${tenantId}")
    | where tostring(props["gen_ai.operation.name"]) == "execute_tool"
    | extend toolName = tostring(props["gen_ai.tool.name"]),
             isError = tostring(props["otel.status_code"]) == "STATUS_CODE_ERROR"
    | summarize
        calls = count(),
        errors = countif(isError),
        avgDurationMs = avg(DurationMs)
      by toolName
  `;

  // Query 3: model stats
  // Supports both gen_ai.operation.name=="chat" and openclaw.model.usage spans
  const modelStatsKusto = `
    AppDependencies
    | where TimeGenerated > ago(${daysBack}d)
    | extend props = todynamic(Properties)
    | where tostring(props["tenant.id"]) == "${tenantId}"
        or (tostring(props["tenant.id"]) == "" and tostring(props["host.name"]) startswith "openclaw-${tenantId}")
    | where tostring(props["gen_ai.operation.name"]) == "chat"
        or Name == "openclaw.model.usage"
    | extend modelName = coalesce(tostring(props["gen_ai.request.model"]), tostring(props["openclaw.model"])),
             isError = tostring(props["otel.status_code"]) == "STATUS_CODE_ERROR"
    | where modelName != ""
    | summarize
        calls = count(),
        errors = countif(isError),
        avgDurationMs = avg(DurationMs)
      by modelName
  `;

  // Query 4: gen AI errors count
  const errorsKusto = `
    AppDependencies
    | where TimeGenerated > ago(${daysBack}d)
    | extend props = todynamic(Properties)
    | where tostring(props["tenant.id"]) == "${tenantId}"
        or (tostring(props["tenant.id"]) == "" and tostring(props["host.name"]) startswith "openclaw-${tenantId}")
    | where tostring(props["otel.status_code"]) == "STATUS_CODE_ERROR"
    | count
  `;

  // Query 5: token consumption by model
  // Supports both gen_ai.usage.* and openclaw.tokens.* attributes
  const tokensByModelKusto = `
    AppDependencies
    | where TimeGenerated > ago(${daysBack}d)
    | extend props = todynamic(Properties)
    | where tostring(props["tenant.id"]) == "${tenantId}"
        or (tostring(props["tenant.id"]) == "" and tostring(props["host.name"]) startswith "openclaw-${tenantId}")
    | where tostring(props["gen_ai.operation.name"]) == "chat"
        or Name == "openclaw.model.usage"
    | extend modelName = coalesce(tostring(props["gen_ai.request.model"]), tostring(props["openclaw.model"])),
             inTok = coalesce(toint(props["gen_ai.usage.input_tokens"]), toint(props["openclaw.tokens.input"])),
             outTok = coalesce(toint(props["gen_ai.usage.output_tokens"]), toint(props["openclaw.tokens.output"]))
    | where modelName != ""
    | summarize totalTokens = sum(inTok) + sum(outTok) by modelName
  `;

  // Query 6: daily input/output tokens
  const dailyTokensKusto = `
    AppDependencies
    | where TimeGenerated > ago(${daysBack}d)
    | extend props = todynamic(Properties)
    | where tostring(props["tenant.id"]) == "${tenantId}"
        or (tostring(props["tenant.id"]) == "" and tostring(props["host.name"]) startswith "openclaw-${tenantId}")
    | where tostring(props["gen_ai.operation.name"]) == "chat"
        or Name == "openclaw.model.usage"
    | extend inTok = coalesce(toint(props["gen_ai.usage.input_tokens"]), toint(props["openclaw.tokens.input"])),
             outTok = coalesce(toint(props["gen_ai.usage.output_tokens"]), toint(props["openclaw.tokens.output"]))
    | summarize inputTotal = sum(inTok), outputTotal = sum(outTok) by bin(TimeGenerated, 1d)
    | order by TimeGenerated asc
  `;

  // Execute individual queries in parallel
  const duration = { duration: `P${daysBack}D` };
  const [runsRes, toolRes, modelRes, errorsRes, tokenModelRes, dailyTokRes] =
    await Promise.all([
      client.queryWorkspace(appId, dailyRunsKusto, duration),
      client.queryWorkspace(appId, toolStatsKusto, duration),
      client.queryWorkspace(appId, modelStatsKusto, duration),
      client.queryWorkspace(appId, errorsKusto, duration),
      client.queryWorkspace(appId, tokensByModelKusto, duration),
      client.queryWorkspace(appId, dailyTokensKusto, duration),
    ]);

  // Parse daily runs
  const dailyRuns: DailyPoint[] = [];
  let totalRuns = 0;
  if (runsRes.status === "Success" && runsRes.tables[0]) {
    for (const row of runsRes.tables[0].rows) {
      const date = new Date(row[0] as string).toISOString().slice(0, 10);
      const val = Number(row[1]);
      dailyRuns.push({ date, value: val });
      totalRuns += val;
    }
  }

  // Parse tool stats
  const toolCalls: ToolCallStat[] = [];
  if (toolRes.status === "Success" && toolRes.tables[0]) {
    for (const row of toolRes.tables[0].rows) {
      toolCalls.push({
        name: String(row[0]),
        calls: Number(row[1]),
        errors: Number(row[2]),
        avgDurationMs: Number(row[3]),
        dailyCalls: [], // Sparkline data requires separate per-tool daily query
      });
    }
  }

  // Parse model stats
  const models: ModelStat[] = [];
  if (modelRes.status === "Success" && modelRes.tables[0]) {
    for (const row of modelRes.tables[0].rows) {
      models.push({
        name: String(row[0]),
        calls: Number(row[1]),
        errors: Number(row[2]),
        avgDurationMs: Number(row[3]),
        dailyCalls: [],
      });
    }
  }

  // Parse errors
  let errorTotal = 0;
  if (errorsRes.status === "Success" && errorsRes.tables[0]?.rows[0]) {
    errorTotal = Number(errorsRes.tables[0].rows[0][0]);
  }

  // Parse token consumption by model
  const byModel: TokensByModel[] = [];
  if (tokenModelRes.status === "Success" && tokenModelRes.tables[0]) {
    for (const row of tokenModelRes.tables[0].rows) {
      byModel.push({ model: String(row[0]), total: Number(row[1]), daily: [] });
    }
  }

  // Parse daily input/output tokens
  const dailyInput: DailyPoint[] = [];
  const dailyOutput: DailyPoint[] = [];
  let inputTotal = 0;
  let outputTotal = 0;
  if (dailyTokRes.status === "Success" && dailyTokRes.tables[0]) {
    for (const row of dailyTokRes.tables[0].rows) {
      const date = new Date(row[0] as string).toISOString().slice(0, 10);
      const inVal = Number(row[1]);
      const outVal = Number(row[2]);
      dailyInput.push({ date, value: inVal });
      dailyOutput.push({ date, value: outVal });
      inputTotal += inVal;
      outputTotal += outVal;
    }
  }

  return {
    agentRuns: {
      total: totalRuns,
      agentName: "openclaw-agent",
      daily: dailyRuns,
    },
    genAiErrors: {
      total: errorTotal,
      hasErrors: errorTotal > 0,
    },
    toolCalls,
    models,
    tokenConsumption: {
      byModel,
      inputTokensTotal: inputTotal,
      outputTokensTotal: outputTotal,
      dailyInput,
      dailyOutput,
    },
  };
}

/**
 * Query DLP/Purview-related activity events from Application Insights.
 * Looks for tool executions where the result mentions DLP redaction or the
 * instrumentation library is the purview-dlp plugin.
 */
export interface DlpActivity {
  timestamp: string;
  traceId: string;
  spanId: string;
  toolName: string;
  action: string;
  result: string;
  durationMs: number;
  agentName: string;
  plugin: string;
}

export async function queryDlpActivities(
  workspaceId: string,
  tenantId: string,
  daysBack = 14,
): Promise<DlpActivity[]> {
  const client = getLogsClient();

  const kusto = `
    AppDependencies
    | where TimeGenerated > ago(${daysBack}d)
    | extend props = todynamic(Properties)
    | where tostring(props["tenant.id"]) == "${tenantId}"
        or (tostring(props["tenant.id"]) == "" and tostring(props["host.name"]) startswith "openclaw-${tenantId}")
    | where tostring(props["openclaw.plugin"]) contains "dlp"
        or tostring(props["gen_ai.tool.result"]) contains "DLP"
        or tostring(props["instrumentationlibrary.name"]) contains "dlp"
        or Name contains "purview" or Name contains "dlp"
    | project
        timestamp = TimeGenerated,
        traceId = OperationId,
        spanId = Id,
        toolName = coalesce(tostring(props["gen_ai.tool.name"]), Name),
        action = coalesce(tostring(props["gen_ai.operation.name"]), "dlp_scan"),
        result = tostring(props["gen_ai.tool.result"]),
        durationMs = DurationMs,
        agentName = coalesce(tostring(props["gen_ai.agent.name"]), "openclaw-agent"),
        plugin = coalesce(tostring(props["openclaw.plugin"]), tostring(props["instrumentationlibrary.name"]), "")
    | order by timestamp desc
    | take 500
  `;

  const result = await client.queryWorkspace(workspaceId, kusto, {
    duration: `P${daysBack}D`,
  });

  if (result.status !== "Success" || !result.tables.length) return [];

  const table = result.tables[0];
  const activities: DlpActivity[] = [];
  for (const row of table.rows) {
    const cols = table.columns;
    const get = (name: string) => {
      const idx = cols.findIndex((c) => c.name === name);
      return idx >= 0 ? row[idx] : undefined;
    };

    activities.push({
      timestamp: new Date(get("timestamp") as string).toISOString(),
      traceId: String(get("traceId") ?? ""),
      spanId: String(get("spanId") ?? ""),
      toolName: String(get("toolName") ?? ""),
      action: String(get("action") ?? ""),
      result: String(get("result") ?? ""),
      durationMs: Number(get("durationMs") ?? 0),
      agentName: String(get("agentName") ?? ""),
      plugin: String(get("plugin") ?? ""),
    });
  }

  return activities;
}
