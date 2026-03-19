/**
 * agent-warden-agents-view — OpenClaw plugin for Azure Monitor Agents View
 *
 * Emits OTel GenAI Semantic Convention spans from OpenClaw lifecycle hooks,
 * enabling Azure Monitor's Agents View (Preview) blade.
 *
 * Spans emitted:
 *   - invoke_agent  (before_agent_start)                — parent span per agent invocation
 *   - chat          (message_received + message_sending)— LLM request/response approximation
 *   - execute_tool  (tool_result_persist)               — tool execution
 *
 * IMPORTANT: OpenClaw hooks are SYNCHRONOUS. All handlers must be non-async.
 * Returning a Promise causes the hook runner to ignore the result.
 *
 * All spans follow OTel GenAI semconv v1.40.0:
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── GenAI Semantic Convention attribute keys (v1.40.0) ──
// Not all are exported by @opentelemetry/semantic-conventions yet, so we define them.

const GEN_AI = {
  OPERATION_NAME: "gen_ai.operation.name",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  PROVIDER_NAME: "gen_ai.provider.name",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  AGENT_NAME: "gen_ai.agent.name",
  AGENT_ID: "gen_ai.agent.id",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_TYPE: "gen_ai.tool.type",
  CONVERSATION_ID: "gen_ai.conversation.id",
} as const;

// ── Types ──

interface PluginConfig {
  otelEndpoint?: string;
  sampleRate?: number;
  enableContentCapture?: boolean;
  serviceName?: string;
  tenantId?: string;
}

interface LlmSpanContext {
  span: Span;
  startTime: number;
}

interface AgentSpanContext {
  span: Span;
  otelContext: ReturnType<typeof context.active>;
  startTime: number;
}

// ── Config Loading ──

function loadConfig(api: OpenClawPluginApi): PluginConfig {
  // Try api.pluginConfig first (from openclaw.json plugin entries)
  if (api.pluginConfig && typeof api.pluginConfig === "object") {
    return api.pluginConfig as PluginConfig;
  }

  // Fallback: read config.json from plugin directory
  try {
    const __dirname =
      typeof import.meta.url !== "undefined"
        ? dirname(fileURLToPath(import.meta.url))
        : __dirname;
    const configPath = join(__dirname, "..", "config.json");
    return JSON.parse(readFileSync(configPath, "utf-8")) as PluginConfig;
  } catch {
    return {};
  }
}

// ── Provider Inference ──

function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return "openai";
  if (m.includes("claude")) return "anthropic";
  if (m.includes("gemini")) return "google";
  if (m.includes("llama") || m.includes("meta")) return "meta";
  if (m.includes("mistral") || m.includes("mixtral")) return "mistral";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("command")) return "cohere";
  return "unknown";
}

// ── Plugin Entry Point ──

// Singleton state — OpenClaw calls register() twice (plugins + gateway contexts).
// The OTel provider and span tracking must be shared across both calls, but
// hooks must be registered in each context so they fire from the correct scope.
let provider: NodeTracerProvider | null = null;
let tracer: Tracer | null = null;
let currentAgentSpan: AgentSpanContext | null = null;
const llmSpans = new Map<string, LlmSpanContext>();
// Stash tool call arguments from LLM responses, keyed by toolCallId
const pendingToolCalls = new Map<string, { name: string; arguments: string }>();

export default {
  register(api: OpenClawPluginApi) {
    const config = loadConfig(api);
    const endpoint =
      config.otelEndpoint ??
      "http://otel-collector.agent-warden-system.svc.cluster.local:4318/v1/traces";
    const serviceName = config.serviceName ?? "openclaw-gateway";
    const tenantId = config.tenantId ?? "";

    // Initialize OTel provider only once (singleton)
    if (!provider) {
      const resourceAttrs: Record<string, string> = {
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: "0.1.0",
        "openclaw.plugin": "agent-warden-agents-view",
      };
      if (tenantId) {
        resourceAttrs["tenant.id"] = tenantId;
      }

      const exporter = new OTLPTraceExporter({ url: endpoint });

      provider = new NodeTracerProvider({
        resource: resourceFromAttributes(resourceAttrs),
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
      // DO NOT call provider.register() — it may conflict with OpenClaw's global provider.
      // Instead, get the tracer directly from our provider.

      tracer = provider.getTracer(
        "agent-warden-agents-view",
        "0.1.0",
      );

      console.log(`[agents-view] OTel provider initialized → ${endpoint}`);
    }

    const t = tracer!;

    // ── Helper: derive a context key from hook event ──
    function contextKey(event: any): string {
      // Use conversation/session ID if available, otherwise thread or fallback
      return (
        event?.conversationId ??
        event?.sessionId ??
        event?.threadId ??
        event?.ctx?.conversationId ??
        "default"
      );
    }

    // ── L0: Agent Span (before_agent_start) ──
    // This hook fires when the agent loop starts. We create the parent
    // invoke_agent span here. It gets ended on agent_end (if that fires)
    // or cleaned up on next before_agent_start for the same key.

    api.on(
      "before_agent_start",
      (event: any, _ctx: any) => {
        try {
          const agentName =
            event?.agentName ?? event?.agent?.name ?? "openclaw-agent";

          // End any existing agent span
          if (currentAgentSpan) {
            currentAgentSpan.span.end();
            currentAgentSpan = null;
          }

          const parentCtx = context.active();
          const span = t.startSpan(
            `invoke_agent ${agentName}`,
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                [GEN_AI.OPERATION_NAME]: "invoke_agent",
                [GEN_AI.AGENT_NAME]: agentName,
                ...(event?.agentId
                  ? { [GEN_AI.AGENT_ID]: event.agentId }
                  : {}),
                ...(event?.conversationId
                  ? { [GEN_AI.CONVERSATION_ID]: event.conversationId }
                  : {}),
                ...(tenantId ? { "tenant.id": tenantId } : {}),
              },
            },
            parentCtx,
          );

          currentAgentSpan = {
            span,
            otelContext: trace.setSpan(parentCtx, span),
            startTime: Date.now(),
          };

          console.log(
            `[agents-view] invoke_agent span started: ${agentName}`,
          );
        } catch (err: any) {
          console.error(`[agents-view] before_agent_start error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 50 },
    );

    // agent_end — end the invoke_agent span
    api.on(
      "agent_end",
      (event: any, _ctx: any) => {
        try {
          if (!currentAgentSpan) {
            console.log(`[agents-view] agent_end fired but no span found`);
            return;
          }

          currentAgentSpan.span.end();
          const duration = Date.now() - currentAgentSpan.startTime;
          currentAgentSpan = null;

          console.log(
            `[agents-view] invoke_agent span ended duration=${duration}ms`,
          );
        } catch (err: any) {
          console.error(`[agents-view] agent_end error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 200 },
    );

    // ── L1: LLM Chat Span ──
    // llm_input / llm_output hooks may not fire in gateway mode.
    // We register them anyway — if they fire, great. If not, we
    // also use message_received as a fallback signal.

    api.on(
      "llm_input",
      (event: any, _ctx: any) => {
        try {
          const key = contextKey(event);
          const model: string =
            event?.model ?? event?.modelId ?? event?.request?.model ?? "unknown";
          const provider = inferProvider(model);

          // Use agent span as parent if available
          const parentCtx = currentAgentSpan?.otelContext ?? context.active();

          const span = t.startSpan(
            `chat ${model}`,
            {
              kind: SpanKind.CLIENT,
              attributes: {
                [GEN_AI.OPERATION_NAME]: "chat",
                [GEN_AI.REQUEST_MODEL]: model,
                [GEN_AI.PROVIDER_NAME]: provider,
                ...(tenantId ? { "tenant.id": tenantId } : {}),
              },
            },
            parentCtx,
          );

          llmSpans.set(key, { span, startTime: Date.now() });

          console.log(
            `[agents-view] chat span started: ${model} (${provider})`,
          );
        } catch (err: any) {
          console.error(`[agents-view] llm_input error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 100 },
    );

    api.on(
      "llm_output",
      (event: any, _ctx: any) => {
        try {
          const key = contextKey(event);
          const llmCtx = llmSpans.get(key);
          if (!llmCtx) {
            console.log(`[agents-view] llm_output fired but no span found [key=${key}]`);
            return;
          }

          const { span } = llmCtx;

          // Token usage — OpenClaw puts usage at event.lastAssistant.usage
          const u = event?.lastAssistant?.usage;
          const inputTokens =
            u?.input ?? u?.promptTokens ?? u?.input_tokens ??
            event?.usage?.promptTokens ?? event?.usage?.input_tokens;
          const outputTokens =
            u?.output ?? u?.completionTokens ?? u?.output_tokens ??
            event?.usage?.completionTokens ?? event?.usage?.output_tokens;
          const responseModel =
            event?.model ?? event?.lastAssistant?.model ?? event?.response?.model;
          const finishReason =
            event?.lastAssistant?.stopReason ?? event?.finishReason ?? event?.response?.finish_reason;

          if (inputTokens != null) {
            span.setAttribute(GEN_AI.USAGE_INPUT_TOKENS, inputTokens);
          }
          if (outputTokens != null) {
            span.setAttribute(GEN_AI.USAGE_OUTPUT_TOKENS, outputTokens);
          }
          if (responseModel) {
            span.setAttribute(GEN_AI.RESPONSE_MODEL, responseModel);
          }
          if (finishReason) {
            span.setAttribute(
              GEN_AI.RESPONSE_FINISH_REASONS,
              Array.isArray(finishReason)
                ? JSON.stringify(finishReason)
                : JSON.stringify([finishReason]),
            );
          }

          // Capture tool calls from LLM response — stash arguments for later
          // matching in tool_result_persist by toolCallId
          const toolCalls =
            event?.lastAssistant?.toolCalls ??
            event?.response?.tool_calls ??
            event?.toolCalls;
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              const tcId = tc?.id ?? tc?.toolCallId;
              const tcName = tc?.function?.name ?? tc?.name ?? tc?.toolName;
              const tcArgs = tc?.function?.arguments ?? tc?.arguments ?? "";
              if (tcId) {
                pendingToolCalls.set(tcId, {
                  name: tcName ?? "unknown",
                  arguments: typeof tcArgs === "string" ? tcArgs : JSON.stringify(tcArgs),
                });
              }
            }
          }

          // Error handling
          if (event?.error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message:
                typeof event.error === "string"
                  ? event.error
                  : event.error?.message ?? "LLM error",
            });
            span.setAttribute(
              "error.type",
              event.error?.type ?? event.error?.code ?? "LLMError",
            );
          }

          span.end();
          llmSpans.delete(key);

          console.log(
            `[agents-view] chat span ended [key=${key}] tokens=${inputTokens ?? "?"}/${outputTokens ?? "?"} duration=${Date.now() - llmCtx.startTime}ms`,
          );
        } catch (err: any) {
          console.error(`[agents-view] llm_output error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 100 },
    );

    // ── L2: Tool Execution Span (tool_result_persist) ──
    // MUST be synchronous — OpenClaw ignores async return values for this hook.

    // ── before_tool_call — try capturing tool arguments before execution ──
    api.on(
      "before_tool_call" as any,
      (event: any, _ctx: any) => {
        try {
          const tcId = event?.toolCallId ?? event?.id;
          const tcName = event?.toolName ?? event?.name ?? event?.function?.name;
          const tcArgs = event?.params ?? event?.arguments ?? event?.function?.arguments ?? event?.input ?? "";
          if (tcId) {
            pendingToolCalls.set(tcId, {
              name: tcName ?? "unknown",
              arguments: typeof tcArgs === "string" ? tcArgs : JSON.stringify(tcArgs),
            });
          }
        } catch (err: any) {
          console.error(`[agents-view] before_tool_call error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 100 },
    );

    api.on(
      "tool_result_persist",
      (event: any, _ctx: any) => {
        try {
          const key = contextKey(event);
          const toolName =
            event?.toolName ??
            event?.tool?.name ??
            event?.message?.name ??
            "unknown_tool";

          const msg = event?.message;
          const toolCallId = event?.toolCallId ?? msg?.toolCallId;

          // Look up stashed tool call arguments by toolCallId
          const stashedCall = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
          if (toolCallId) pendingToolCalls.delete(toolCallId);

          // Parse the stashed arguments to extract actual command/path
          let parsedArgs: Record<string, any> | null = null;
          if (stashedCall?.arguments) {
            try {
              parsedArgs = JSON.parse(stashedCall.arguments);
            } catch { /* not JSON */ }
          }

          // For exec tool, extract the actual command
          const actualCommand =
            parsedArgs?.command ?? parsedArgs?.cmd ?? parsedArgs?.script ?? "";
          // For read/write tools, extract the path
          const targetPath =
            parsedArgs?.path ?? parsedArgs?.file ?? parsedArgs?.filename ?? "";

          // Execution details from message.details
          const details = msg?.details;
          const exitCode = details?.exitCode;
          const execDurationMs = details?.durationMs;
          const cwd = details?.cwd;
          const execStatus = details?.status;

          // Tool result — from details.aggregated (raw output) or content array
          let toolResult = "";
          if (typeof details?.aggregated === "string") {
            toolResult = details.aggregated;
          } else if (Array.isArray(msg?.content)) {
            toolResult = msg.content.map((c: any) => c?.text ?? "").join("\n");
          } else if (typeof msg?.content === "string") {
            toolResult = msg.content;
          }
          const truncatedResult = toolResult.length > 500
            ? toolResult.slice(0, 500) + "…"
            : toolResult;

          // Use agent span as parent if available
          const parentCtx = currentAgentSpan?.otelContext ?? context.active();

          // Build descriptive span name
          const spanLabel = actualCommand
            ? `execute_tool ${toolName}: ${actualCommand.slice(0, 100)}`
            : `execute_tool ${toolName}`;

          const span = t.startSpan(
            spanLabel,
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                [GEN_AI.OPERATION_NAME]: "execute_tool",
                [GEN_AI.TOOL_NAME]: toolName,
                [GEN_AI.TOOL_TYPE]: "function",
                ...(actualCommand ? { "gen_ai.tool.call.arguments": actualCommand } : {}),
                ...(targetPath ? { "gen_ai.tool.target_path": targetPath } : {}),
                ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : {}),
                ...(truncatedResult ? { "gen_ai.tool.result": truncatedResult } : {}),
                ...(exitCode != null ? { "tool.exit_code": exitCode } : {}),
                ...(execDurationMs != null ? { "tool.duration_ms": execDurationMs } : {}),
                ...(cwd ? { "tool.cwd": cwd } : {}),
                ...(execStatus ? { "tool.status": execStatus } : {}),
                ...(msg?.isError ? { "tool.is_error": true } : {}),
                ...(tenantId ? { "tenant.id": tenantId } : {}),
              },
            },
            parentCtx,
          );

          // Check for errors in tool result
          const isError =
            event?.error ||
            event?.status === "error";

          if (isError) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message:
                typeof event.error === "string"
                  ? event.error
                  : event.error?.message ?? "Tool execution error",
            });
            span.setAttribute(
              "error.type",
              event.error?.type ?? "ToolError",
            );
          }

          // End immediately since we only get the completion event
          span.end();

          console.log(
            `[agents-view] execute_tool span: ${toolName} cmd=${actualCommand.slice(0, 80) || targetPath || '(none)'} exitCode=${exitCode ?? '?'} duration=${execDurationMs ?? '?'}ms`,
          );
        } catch (err: any) {
          console.error(`[agents-view] tool_result_persist error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 100 },
    );

    // ── L3: Message hooks — diagnostic logging to discover event shapes ──

    api.on(
      "message_received",
      (event: any, _ctx: any) => {
        try {
          console.log(
            `[agents-view] message_received fired: keys=${Object.keys(event || {}).join(",")}`,
          );
        } catch (err: any) {
          console.error(`[agents-view] message_received error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 200 },
    );

    api.on(
      "message_sending",
      (event: any, _ctx: any) => {
        try {
          console.log(
            `[agents-view] message_sending fired: keys=${Object.keys(event || {}).join(",")}`,
          );
        } catch (err: any) {
          console.error(`[agents-view] message_sending error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 200 },
    );

    // ── Graceful Shutdown ──

    const shutdownHandler = async () => {
      console.log("[agents-view] Shutting down OTel provider...");
      // End any dangling spans
      if (currentAgentSpan) {
        currentAgentSpan.span.end();
        currentAgentSpan = null;
      }
      for (const [key, ctx] of llmSpans) {
        ctx.span.end();
        llmSpans.delete(key);
      }
      await provider!.shutdown();
    };

    process.on("SIGTERM", shutdownHandler);
    process.on("SIGINT", shutdownHandler);

    console.log(
      `[agents-view] Plugin registered — OTel GenAI spans → ${endpoint}` +
        (tenantId ? ` (tenant: ${tenantId})` : ""),
    );
  },
};
