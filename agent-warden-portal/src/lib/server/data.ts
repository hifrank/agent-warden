import type { InstanceRecord, SkillRecord, McpServerRecord, TraceSpan, TelegramChannelConfig, InstanceConfigFiles, ActivityMetrics, EndToEndTransaction } from "$lib/types";

/** In-memory store — swap for Cosmos DB by replacing this module. */

export const instances: InstanceRecord[] = [
  {
    tenantId: "contoso-prod",
    instanceId: "oc-contoso-prod",
    state: "Active",
    version: "0.9.2",
    tier: "enterprise",
    region: "eastus2",
    createdAt: "2026-03-01T10:00:00Z",
    lastHealthCheck: "2026-04-08T08:00:00Z",
    healthStatus: "Healthy",
    activeChannels: ["slack", "telegram"],
    skillCount: 12,
    podCount: 3,
    cpuUsagePct: 45,
    memoryUsagePct: 62,
    messagesLast24h: 1420,
    llmTokensLast24h: 890000,
    ownerIdentity: "admin@contoso.com",
    tags: { env: "production" },
  },
  {
    tenantId: "fabrikam-dev",
    instanceId: "oc-fabrikam-dev",
    state: "Active",
    version: "0.9.1",
    tier: "pro",
    region: "westus3",
    createdAt: "2026-03-15T14:30:00Z",
    lastHealthCheck: "2026-04-08T07:55:00Z",
    healthStatus: "Degraded",
    activeChannels: ["discord"],
    skillCount: 5,
    podCount: 1,
    cpuUsagePct: 78,
    memoryUsagePct: 85,
    messagesLast24h: 310,
    llmTokensLast24h: 210000,
    ownerIdentity: "dev@fabrikam.com",
    tags: { env: "development" },
  },
];

export const skills: SkillRecord[] = [
  { id: "sk-1", name: "web-search", description: "Search the web via Bing", version: "1.2.0", enabled: true, tenantId: "contoso-prod" },
  { id: "sk-2", name: "code-interpreter", description: "Execute Python in sandbox", version: "2.0.1", enabled: true, tenantId: "contoso-prod" },
  { id: "sk-3", name: "calendar-access", description: "Read/write M365 calendar", version: "1.0.0", enabled: false, tenantId: "contoso-prod" },
  { id: "sk-4", name: "file-search", description: "Search uploaded documents", version: "1.1.0", enabled: true, tenantId: "fabrikam-dev" },
  { id: "sk-5", name: "email-send", description: "Send emails via Graph API", version: "1.0.2", enabled: true, tenantId: "fabrikam-dev" },
];

export const mcpServers: McpServerRecord[] = [
  { id: "mcp-1", name: "agent-warden-server", endpoint: "http://localhost:3002/mcp", status: "connected", toolCount: 18, tenantId: "contoso-prod" },
  { id: "mcp-2", name: "purview-dlp-server", endpoint: "http://localhost:3003/mcp", status: "connected", toolCount: 4, tenantId: "contoso-prod" },
  { id: "mcp-3", name: "a365-server", endpoint: "http://localhost:3004/mcp", status: "disconnected", toolCount: 6, tenantId: "fabrikam-dev" },
];

// ─── Trace Spans (from agents-view OTel plugin) ──────────

function genDates(n: number): string[] {
  const out: string[] = [];
  const now = new Date("2026-04-08");
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const dates28 = genDates(28);

export const activityMetrics: Record<string, ActivityMetrics> = {
  "contoso-prod": {
    agentRuns: {
      total: 663,
      agentName: "openclaw-agent",
      daily: dates28.map((d, i) => ({
        date: d,
        value: i < 8 ? [5, 12, 18, 45, 520, 38, 8, 3][i]
             : i < 20 ? [2, 0, 1, 0, 0, 0, 0, 1, 2, 3, 1, 2][i - 8]
             : [4, 3, 2, 1, 0, 1, 0, 0][i - 20],
      })),
    },
    genAiErrors: { total: 0, hasErrors: false },
    toolCalls: [
      { name: "read", errors: 0, avgDurationMs: 31930, calls: 1290, dailyCalls: [80, 95, 102, 88, 110, 75, 92, 105, 98, 85, 70, 88, 102, 100] },
      { name: "web_search", errors: 0, avgDurationMs: 30850, calls: 302, dailyCalls: [20, 25, 18, 30, 22, 28, 15, 24, 20, 18, 25, 22, 30, 35] },
      { name: "session_status", errors: 0, avgDurationMs: 47440, calls: 9, dailyCalls: [0, 1, 0, 1, 0, 0, 2, 0, 1, 1, 0, 1, 1, 1] },
      { name: "browser", errors: 0, avgDurationMs: 52670, calls: 154, dailyCalls: [8, 12, 15, 10, 14, 9, 11, 13, 8, 12, 10, 11, 10, 11] },
      { name: "exec", errors: 0, avgDurationMs: 45710, calls: 212, dailyCalls: [10, 18, 12, 20, 15, 14, 16, 18, 12, 15, 14, 16, 18, 14] },
    ],
    models: [
      { name: "gpt-5.4", errors: 0, avgDurationMs: 12270, calls: 169, dailyCalls: [8, 12, 15, 10, 14, 9, 11, 13, 10, 12, 14, 11, 10, 10] },
      { name: "gpt-4o", errors: 0, avgDurationMs: 6420, calls: 22, dailyCalls: [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2] },
      { name: "gpt-54", errors: 0, avgDurationMs: 20820, calls: 447, dailyCalls: [25, 35, 30, 40, 32, 28, 35, 30, 28, 35, 30, 32, 35, 32] },
    ],
    tokenConsumption: {
      byModel: [
        { model: "gpt-54", total: 4200000, daily: dates28.map((d, i) => ({ date: d, value: i === 10 ? 3800000 : i > 24 ? [15000, 18000, 12000][i-25] ?? 0 : Math.floor(Math.random() * 5000) })) },
        { model: "gpt-5.4", total: 1400000, daily: dates28.map((d, i) => ({ date: d, value: i === 8 ? 120000 : i > 20 ? [8000, 10000, 5000, 12000, 9000, 7000, 8000][i-21] ?? 0 : Math.floor(Math.random() * 3000) })) },
        { model: "gpt-4o", total: 2000, daily: dates28.map((d) => ({ date: d, value: Math.floor(Math.random() * 200) })) },
      ],
      inputTokensTotal: 5600000,
      outputTokensTotal: 68200,
      dailyInput: dates28.map((d, i) => ({ date: d, value: i === 10 ? 3500000 : i === 11 ? 1800000 : Math.floor(Math.random() * 50000) + 10000 })),
      dailyOutput: dates28.map((d) => ({ date: d, value: Math.floor(Math.random() * 5000) + 500 })),
    },
  },
  "fabrikam-dev": {
    agentRuns: {
      total: 87,
      agentName: "openclaw-agent",
      daily: dates28.map((d, i) => ({ date: d, value: i > 20 ? [5, 8, 12, 15, 10, 18, 19][i - 21] ?? 0 : Math.floor(Math.random() * 3) })),
    },
    genAiErrors: { total: 3, hasErrors: true },
    toolCalls: [
      { name: "file-search", errors: 1, avgDurationMs: 42000, calls: 45, dailyCalls: [2, 3, 4, 5, 3, 2, 4, 3, 2, 5, 3, 4, 3, 2] },
      { name: "email-send", errors: 0, avgDurationMs: 18500, calls: 28, dailyCalls: [1, 2, 3, 2, 1, 3, 2, 1, 2, 3, 2, 1, 3, 2] },
    ],
    models: [
      { name: "claude-sonnet-4-20250514", errors: 2, avgDurationMs: 8900, calls: 65, dailyCalls: [3, 4, 5, 6, 4, 3, 5, 4, 5, 6, 5, 4, 5, 6] },
      { name: "gpt-4o", errors: 1, avgDurationMs: 5200, calls: 22, dailyCalls: [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2] },
    ],
    tokenConsumption: {
      byModel: [
        { model: "claude-sonnet-4-20250514", total: 580000, daily: dates28.map((d) => ({ date: d, value: Math.floor(Math.random() * 30000) + 5000 })) },
        { model: "gpt-4o", total: 42000, daily: dates28.map((d) => ({ date: d, value: Math.floor(Math.random() * 3000) + 200 })) },
      ],
      inputTokensTotal: 580000,
      outputTokensTotal: 42000,
      dailyInput: dates28.map((d) => ({ date: d, value: Math.floor(Math.random() * 30000) + 5000 })),
      dailyOutput: dates28.map((d) => ({ date: d, value: Math.floor(Math.random() * 3000) + 200 })),
    },
  },
};

export const traceSpans: (TraceSpan & { tenantId: string })[] = [
  // ── contoso-prod: Transaction 1 (4/3 12:16 PM) ──
  {
    traceId: "d5c48509315e5c70c4b9dc40176c71c5", spanId: "s1-root", operationName: "invoke_agent",
    agentName: "openclaw-agent", startTime: "2026-04-03T12:16:04Z", durationMs: 54900, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "openclaw-agent", "instrumentationlibrary.name": "agent-warden-agents-view", "instrumentationlibrary.version": "0.1.0", "openclaw.plugin": "agent-warden-agents-view", "otel.status_code": "STATUS_CODE_UNSET", "service.name": "openclaw-gateway", "service.version": "0.1.0", "tenant.id": "contoso-prod" },
  },
  {
    traceId: "d5c48509315e5c70c4b9dc40176c71c5", spanId: "s1-llm", parentSpanId: "s1-root", operationName: "chat",
    agentName: "openclaw-agent", model: "gpt-5.4", provider: "openai",
    startTime: "2026-04-03T12:16:05Z", durationMs: 54800, inputTokens: 8120, outputTokens: 2113, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-5.4", "gen_ai.response.model": "gpt-5.4", "gen_ai.usage.input_tokens": "8120", "gen_ai.usage.output_tokens": "2113", "gen_ai.system": "openai" },
  },
  {
    traceId: "d5c48509315e5c70c4b9dc40176c71c5", spanId: "s1-t1", parentSpanId: "s1-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-03T12:16:06Z", durationMs: 44, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "d5c48509315e5c70c4b9dc40176c71c5", spanId: "s1-t2", parentSpanId: "s1-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-03T12:16:08Z", durationMs: 33, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "d5c48509315e5c70c4b9dc40176c71c5", spanId: "s1-t3", parentSpanId: "s1-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-03T12:16:10Z", durationMs: 50, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "d5c48509315e5c70c4b9dc40176c71c5", spanId: "s1-t4", parentSpanId: "s1-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-03T12:16:12Z", durationMs: 48, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "d5c48509315e5c70c4b9dc40176c71c5", spanId: "s1-t5", parentSpanId: "s1-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-03T12:16:14Z", durationMs: 56, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "d5c48509315e5c70c4b9dc40176c71c5", spanId: "s1-t6", parentSpanId: "s1-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "web_fetch", startTime: "2026-04-03T12:16:55Z", durationMs: 28, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "web_fetch" },
  },
  {
    traceId: "d5c48509315e5c70c4b9dc40176c71c5", spanId: "s1-t7", parentSpanId: "s1-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "web_fetch", startTime: "2026-04-03T12:16:56Z", durationMs: 79, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "web_fetch" },
  },

  // ── contoso-prod: Transaction 2 (4/3 12:48 AM) ──
  {
    traceId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", spanId: "s2-root", operationName: "invoke_agent",
    agentName: "openclaw-agent", startTime: "2026-04-03T00:48:44Z", durationMs: 32100, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "openclaw-agent", "instrumentationlibrary.name": "agent-warden-agents-view", "instrumentationlibrary.version": "0.1.0", "openclaw.plugin": "agent-warden-agents-view", "otel.status_code": "STATUS_CODE_UNSET", "service.name": "openclaw-gateway", "service.version": "0.1.0", "tenant.id": "contoso-prod" },
  },
  {
    traceId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", spanId: "s2-llm", parentSpanId: "s2-root", operationName: "chat",
    agentName: "openclaw-agent", model: "gpt-5.4", provider: "openai",
    startTime: "2026-04-03T00:48:45Z", durationMs: 31800, inputTokens: 5200, outputTokens: 1450, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-5.4", "gen_ai.usage.input_tokens": "5200", "gen_ai.usage.output_tokens": "1450" },
  },
  {
    traceId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", spanId: "s2-t1", parentSpanId: "s2-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "read", startTime: "2026-04-03T00:48:50Z", durationMs: 120, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "read" },
  },
  {
    traceId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", spanId: "s2-t2", parentSpanId: "s2-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "exec", startTime: "2026-04-03T00:49:00Z", durationMs: 2400, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "exec" },
  },
  {
    traceId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", spanId: "s2-t3", parentSpanId: "s2-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-03T00:49:10Z", durationMs: 67, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },

  // ── contoso-prod: Transaction 3 (4/3 12:05 AM) ──
  {
    traceId: "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6", spanId: "s3-root", operationName: "invoke_agent",
    agentName: "openclaw-agent", startTime: "2026-04-03T00:05:52Z", durationMs: 18900, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "openclaw-agent", "instrumentationlibrary.name": "agent-warden-agents-view", "instrumentationlibrary.version": "0.1.0", "openclaw.plugin": "agent-warden-agents-view", "otel.status_code": "STATUS_CODE_UNSET", "service.name": "openclaw-gateway", "service.version": "0.1.0", "tenant.id": "contoso-prod" },
  },
  {
    traceId: "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6", spanId: "s3-llm", parentSpanId: "s3-root", operationName: "chat",
    agentName: "openclaw-agent", model: "gpt-54", provider: "openai",
    startTime: "2026-04-03T00:05:53Z", durationMs: 18500, inputTokens: 3800, outputTokens: 980, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-54", "gen_ai.usage.input_tokens": "3800", "gen_ai.usage.output_tokens": "980" },
  },
  {
    traceId: "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6", spanId: "s3-t1", parentSpanId: "s3-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "web_search", startTime: "2026-04-03T00:06:00Z", durationMs: 350, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "web_search" },
  },

  // ── contoso-prod: Transaction 4 (4/2 11:54 PM) ──
  {
    traceId: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", spanId: "s4-root", operationName: "invoke_agent",
    agentName: "openclaw-agent", startTime: "2026-04-02T23:54:08Z", durationMs: 54900, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "openclaw-agent", "instrumentationlibrary.name": "agent-warden-agents-view", "instrumentationlibrary.version": "0.1.0", "openclaw.plugin": "agent-warden-agents-view", "otel.status_code": "STATUS_CODE_UNSET", "service.name": "openclaw-gateway", "service.version": "0.1.0", "tenant.id": "contoso-prod" },
  },
  {
    traceId: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", spanId: "s4-llm", parentSpanId: "s4-root", operationName: "chat",
    agentName: "openclaw-agent", model: "gpt-5.4", provider: "openai",
    startTime: "2026-04-02T23:54:09Z", durationMs: 54500, inputTokens: 7600, outputTokens: 2050, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-5.4", "gen_ai.usage.input_tokens": "7600", "gen_ai.usage.output_tokens": "2050" },
  },
  {
    traceId: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", spanId: "s4-t1", parentSpanId: "s4-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-02T23:54:15Z", durationMs: 44, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", spanId: "s4-t2", parentSpanId: "s4-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-02T23:54:20Z", durationMs: 33, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", spanId: "s4-t3", parentSpanId: "s4-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-02T23:54:25Z", durationMs: 50, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", spanId: "s4-t4", parentSpanId: "s4-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-02T23:54:30Z", durationMs: 27, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", spanId: "s4-t5", parentSpanId: "s4-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-02T23:54:35Z", durationMs: 27, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },

  // ── contoso-prod: Transaction 5 (4/2 11:41 PM) ──
  {
    traceId: "7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b", spanId: "s5-root", operationName: "invoke_agent",
    agentName: "openclaw-agent", startTime: "2026-04-02T23:41:46Z", durationMs: 12300, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "openclaw-agent", "instrumentationlibrary.name": "agent-warden-agents-view", "instrumentationlibrary.version": "0.1.0", "openclaw.plugin": "agent-warden-agents-view", "otel.status_code": "STATUS_CODE_UNSET", "service.name": "openclaw-gateway", "service.version": "0.1.0", "tenant.id": "contoso-prod" },
  },
  {
    traceId: "7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b", spanId: "s5-llm", parentSpanId: "s5-root", operationName: "chat",
    agentName: "openclaw-agent", model: "gpt-4o", provider: "openai",
    startTime: "2026-04-02T23:41:47Z", durationMs: 11800, inputTokens: 2100, outputTokens: 620, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o", "gen_ai.usage.input_tokens": "2100", "gen_ai.usage.output_tokens": "620" },
  },
  {
    traceId: "7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b", spanId: "s5-t1", parentSpanId: "s5-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "read", startTime: "2026-04-02T23:41:50Z", durationMs: 89, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "read" },
  },
  {
    traceId: "7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b", spanId: "s5-t2", parentSpanId: "s5-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-02T23:41:52Z", durationMs: 30, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },
  {
    traceId: "7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b", spanId: "s5-t3", parentSpanId: "s5-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "browser", startTime: "2026-04-02T23:41:55Z", durationMs: 29, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "browser" },
  },

  // ── contoso-prod: Transaction 6 (4/2 11:25 PM) ──
  {
    traceId: "bb00cc11dd22ee33ff44aa55bb66cc77", spanId: "s6-root", operationName: "invoke_agent",
    agentName: "openclaw-agent", startTime: "2026-04-02T23:25:12Z", durationMs: 8900, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "openclaw-agent", "instrumentationlibrary.name": "agent-warden-agents-view", "instrumentationlibrary.version": "0.1.0", "openclaw.plugin": "agent-warden-agents-view", "otel.status_code": "STATUS_CODE_UNSET", "service.name": "openclaw-gateway", "service.version": "0.1.0", "tenant.id": "contoso-prod" },
  },
  {
    traceId: "bb00cc11dd22ee33ff44aa55bb66cc77", spanId: "s6-llm", parentSpanId: "s6-root", operationName: "chat",
    agentName: "openclaw-agent", model: "gpt-54", provider: "openai",
    startTime: "2026-04-02T23:25:13Z", durationMs: 8600, inputTokens: 1800, outputTokens: 540, status: "ok",
    tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-54", "gen_ai.usage.input_tokens": "1800", "gen_ai.usage.output_tokens": "540" },
  },
  {
    traceId: "bb00cc11dd22ee33ff44aa55bb66cc77", spanId: "s6-t1", parentSpanId: "s6-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "web_search", startTime: "2026-04-02T23:25:18Z", durationMs: 210, status: "ok", tenantId: "contoso-prod",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "web_search" },
  },

  // ── fabrikam-dev: Transaction 1 (4/8 07:50 AM) ──
  {
    traceId: "def789abc012def789abc012def789ab", spanId: "f1-root", operationName: "invoke_agent",
    agentName: "openclaw-agent", startTime: "2026-04-08T07:50:00Z", durationMs: 6200, status: "ok",
    tenantId: "fabrikam-dev",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "openclaw-agent", "instrumentationlibrary.name": "agent-warden-agents-view", "instrumentationlibrary.version": "0.1.0", "openclaw.plugin": "agent-warden-agents-view", "otel.status_code": "STATUS_CODE_UNSET", "service.name": "openclaw-gateway", "service.version": "0.1.0", "tenant.id": "fabrikam-dev" },
  },
  {
    traceId: "def789abc012def789abc012def789ab", spanId: "f1-llm", parentSpanId: "f1-root", operationName: "chat",
    agentName: "openclaw-agent", model: "claude-sonnet-4-20250514", provider: "anthropic",
    startTime: "2026-04-08T07:50:01Z", durationMs: 3100, inputTokens: 980, outputTokens: 450, status: "ok",
    tenantId: "fabrikam-dev",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "claude-sonnet-4-20250514", "gen_ai.usage.input_tokens": "980", "gen_ai.usage.output_tokens": "450" },
  },
  {
    traceId: "def789abc012def789abc012def789ab", spanId: "f1-t1", parentSpanId: "f1-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "file-search", startTime: "2026-04-08T07:50:05Z", durationMs: 1500,
    status: "error", errorMessage: "Timeout: file index unavailable", tenantId: "fabrikam-dev",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "file-search", "otel.status_code": "STATUS_CODE_ERROR" },
  },

  // ── fabrikam-dev: Transaction 2 (4/7 09:15 AM) ──
  {
    traceId: "aabb1122ccdd3344eeff5566aabb7788", spanId: "f2-root", operationName: "invoke_agent",
    agentName: "openclaw-agent", startTime: "2026-04-07T09:15:00Z", durationMs: 9800, status: "ok",
    tenantId: "fabrikam-dev",
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "openclaw-agent", "instrumentationlibrary.name": "agent-warden-agents-view", "instrumentationlibrary.version": "0.1.0", "openclaw.plugin": "agent-warden-agents-view", "otel.status_code": "STATUS_CODE_UNSET", "service.name": "openclaw-gateway", "service.version": "0.1.0", "tenant.id": "fabrikam-dev" },
  },
  {
    traceId: "aabb1122ccdd3344eeff5566aabb7788", spanId: "f2-llm", parentSpanId: "f2-root", operationName: "chat",
    agentName: "openclaw-agent", model: "gpt-4o", provider: "openai",
    startTime: "2026-04-07T09:15:01Z", durationMs: 5200, inputTokens: 1500, outputTokens: 380, status: "ok",
    tenantId: "fabrikam-dev",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o", "gen_ai.usage.input_tokens": "1500", "gen_ai.usage.output_tokens": "380" },
  },
  {
    traceId: "aabb1122ccdd3344eeff5566aabb7788", spanId: "f2-t1", parentSpanId: "f2-root", operationName: "execute_tool",
    agentName: "openclaw-agent", toolName: "email-send", startTime: "2026-04-07T09:15:08Z", durationMs: 320, status: "ok", tenantId: "fabrikam-dev",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "email-send" },
  },
];

/** Build end-to-end transactions from raw spans for a given tenant */
export function getTransactions(tenantId: string): EndToEndTransaction[] {
  const spans = traceSpans.filter((s) => s.tenantId === tenantId);
  const byTrace = new Map<string, (TraceSpan & { tenantId: string })[]>();
  for (const s of spans) {
    if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, []);
    byTrace.get(s.traceId)!.push(s);
  }
  const txns: EndToEndTransaction[] = [];
  for (const [traceId, group] of byTrace) {
    const root = group.find((s) => s.operationName === "invoke_agent");
    if (!root) continue;
    const children = group
      .filter((s) => s.spanId !== root.spanId)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    // strip tenantId from exported spans
    const strip = ({ tenantId: _, ...rest }: typeof root) => rest;
    txns.push({ traceId, rootSpan: strip(root), childSpans: children.map(strip) });
  }
  txns.sort((a, b) => new Date(b.rootSpan.startTime).getTime() - new Date(a.rootSpan.startTime).getTime());
  return txns;
}

// ─── Telegram Channel Configs ─────────────────────────────

export const telegramConfigs: TelegramChannelConfig[] = [
  {
    tenantId: "contoso-prod",
    botToken: "",
    botUsername: "contoso_agent_bot",
    pairingStatus: "approved",
    pairedAt: "2026-03-10T12:00:00Z",
  },
  {
    tenantId: "fabrikam-dev",
    botToken: "",
    pairingStatus: "pending",
  },
];

// ─── Instance Config Files (soul.md / openclaw.md) ────────

export const instanceConfigs: Record<string, InstanceConfigFiles> = {
  "contoso-prod": {
    soulMd: `# Agent Identity\n\nYou are Contoso's AI assistant, a professional and helpful agent.\n\n## Personality\n- Professional and concise\n- Always cite sources when providing information\n- Decline requests outside your authorized scope\n\n## Boundaries\n- Do not share internal company data externally\n- Escalate sensitive HR or legal questions to human operators\n- Follow Contoso data classification policies\n`,
    openclawMd: `# OpenClaw Configuration\n\n## Gateway\n- Port: 18789\n- Auth mode: shared-secret\n\n## Channels\n- Telegram: enabled (dmPolicy: pairing)\n- Slack: enabled\n\n## Skills\n- web-search: enabled\n- code-interpreter: enabled\n- calendar-access: disabled\n\n## Security\n- DLP: Purview integration enabled\n- Content scanning: all channels\n`,
  },
  "fabrikam-dev": {
    soulMd: `# Agent Identity\n\nYou are Fabrikam's development assistant.\n\n## Personality\n- Casual and developer-friendly\n- Provide code examples when helpful\n- Ask clarifying questions before taking action\n`,
    openclawMd: `# OpenClaw Configuration\n\n## Gateway\n- Port: 18789\n- Auth mode: none (dev)\n\n## Channels\n- Discord: enabled\n\n## Skills\n- file-search: enabled\n- email-send: enabled\n`,
  },
};
