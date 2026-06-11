/**
 * agent-warden-a365 — OpenClaw plugin for Agent 365 Observability
 *
 * Emits Agent 365 Observability SDK spans from OpenClaw lifecycle hooks,
 * enabling unified agent governance via M365 Admin Center, Microsoft Defender,
 * and Microsoft Purview DSPM.
 *
 * Spans emitted:
 *   - InvokeAgentScope  (before_agent_start → agent_end)  — parent span per agent invocation
 *   - InferenceScope    (llm_input → llm_output)           — LLM inference call
 *   - ExecuteToolScope  (tool_result_persist)               — tool execution
 *
 * IMPORTANT: OpenClaw hooks are SYNCHRONOUS. All handlers must be non-async.
 * Returning a Promise causes the hook runner to ignore the result.
 *
 * SDK: @microsoft/agents-a365-observability v0.1.0-preview
 * Docs: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { InvokeAgentScope, InferenceScope } from "@microsoft/agents-a365-observability";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type A365PluginConfig,
  configureA365,
  buildAgentDetails,
  setBaggageContext,
  startInvokeAgentScope,
  startExecuteToolScope,
  startInferenceScope,
} from "./a365-client.js";

// ── Config Loading ──

function loadConfig(api: OpenClawPluginApi): A365PluginConfig {
  // Try api.pluginConfig first (from openclaw.json plugin entries)
  if (api.pluginConfig && typeof api.pluginConfig === "object") {
    return api.pluginConfig as A365PluginConfig;
  }

  // Fallback: read config.json from plugin directory
  try {
    const __dirname =
      typeof import.meta.url !== "undefined"
        ? dirname(fileURLToPath(import.meta.url))
        : __dirname;
    const configPath = join(__dirname, "..", "config.json");
    return JSON.parse(readFileSync(configPath, "utf-8")) as A365PluginConfig;
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

// ── Span Tracking ──

interface InvokeContext {
  scope: InvokeAgentScope;
  startTime: number;
  inputMessage?: string;
}

interface InferenceContext {
  scope: InferenceScope;
  startTime: number;
}

// Track active scopes across hooks
let currentInvoke: InvokeContext | null = null;
const inferenceScopes = new Map<string, InferenceContext>();

// Stash tool call arguments from LLM responses, keyed by toolCallId
const pendingToolCalls = new Map<string, { name: string; arguments: string }>();

// ── Plugin Entry Point ──

export default {
  register(api: OpenClawPluginApi) {
    const config = loadConfig(api);

    // Initialize A365 SDK (singleton — safe to call multiple times)
    try {
      configureA365(config);
    } catch (err: any) {
      console.error(`[a365] SDK configuration failed: ${err.message}`);
      console.error("[a365] Plugin will register hooks but spans may not export.");
    }

    const agentDetails = buildAgentDetails(config);
    const defaultChannel = config.channelName ?? "api";

    // ── Helper: derive a context key from hook event ──
    function contextKey(event: any): string {
      const key =
        event?.conversationId ??
        event?.sessionId ??
        event?.threadId ??
        event?.ctx?.conversationId ??
        null;
      if (!key) {
        console.warn(
          "[a365] contextKey: no conversationId/sessionId/threadId found on event — " +
          "concurrent conversations will collide. Falling back to 'default'.",
        );
        return "default";
      }
      return key;
    }

    // ── Helper: resolve channel from Activity Protocol fields on event ──
    function resolveChannel(event: any): string {
      return (
        event?.channelId ??
        event?.activity?.channelId ??
        event?.channel ??
        event?.ctx?.channelId ??
        defaultChannel
      );
    }

    // ── Helper: extract Activity Protocol from/recipient identity ──
    function extractFrom(event: any): string | undefined {
      return (
        event?.from?.id ??
        event?.from?.name ??
        event?.activity?.from?.id ??
        event?.userId ??
        event?.ctx?.userId ??
        undefined
      );
    }

    function extractRecipient(event: any): string | undefined {
      return (
        event?.recipient?.id ??
        event?.recipient?.name ??
        event?.activity?.recipient?.id ??
        undefined
      );
    }

    // ── InvokeAgentScope (before_agent_start → agent_end) ──

    api.on(
      "before_agent_start",
      (event: any, _ctx: any) => {
        try {
          // Dispose any existing invoke scope
          if (currentInvoke) {
            currentInvoke.scope.dispose();
            currentInvoke = null;
          }

          const conversationId = contextKey(event);
          const channel = resolveChannel(event);
          const from = extractFrom(event);
          const recipient = extractRecipient(event);
          const inputMessage =
            event?.message?.content ??
            event?.input ??
            event?.prompt ??
            "";
          const sessionId = event?.sessionId ?? event?.threadId;

          // Set baggage context for this invocation
          const baggageBuilder = setBaggageContext(config, conversationId);
          // BaggageBuilder.build() returns a disposable context — we let the SDK
          // processor copy baggage entries to all child spans automatically.
          baggageBuilder.build();

          const scope = startInvokeAgentScope(
            agentDetails,
            conversationId,
            typeof inputMessage === "string" ? inputMessage : JSON.stringify(inputMessage),
            sessionId,
            channel,
          );

          // Record input messages
          const inputStr = typeof inputMessage === "string" ? inputMessage : JSON.stringify(inputMessage);
          if (inputStr) {
            scope.recordInputMessages([inputStr]);
          }

          currentInvoke = {
            scope,
            startTime: Date.now(),
            inputMessage: inputStr,
          };

          console.log(
            `[a365] InvokeAgentScope started: agent=${agentDetails.agentName}, conversation=${conversationId}, ` +
            `channel=${channel}, from=${from ?? "unknown"}, recipient=${recipient ?? "unknown"}`,
          );
        } catch (err: any) {
          console.error(`[a365] before_agent_start error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 50 },
    );

    // agent_end — end the InvokeAgentScope
    api.on(
      "agent_end",
      (event: any, _ctx: any) => {
        try {
          if (!currentInvoke) {
            console.log("[a365] agent_end fired but no InvokeAgentScope found");
            return;
          }

          // Record output message
          const output =
            event?.response?.content ??
            event?.output ??
            event?.message?.content ??
            "";
          const outputStr = typeof output === "string" ? output : JSON.stringify(output);
          if (outputStr) {
            currentInvoke.scope.recordResponse(outputStr);
          }

          currentInvoke.scope.dispose();
          const duration = Date.now() - currentInvoke.startTime;
          currentInvoke = null;

          console.log(`[a365] InvokeAgentScope ended, duration=${duration}ms`);
        } catch (err: any) {
          console.error(`[a365] agent_end error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 200 },
    );

    // ── InferenceScope (llm_input → llm_output) ──

    api.on(
      "llm_input",
      (event: any, _ctx: any) => {
        try {
          const key = contextKey(event);
          const model: string =
            event?.model ?? event?.modelId ?? event?.request?.model ?? "unknown";
          const provider = inferProvider(model);
          const conversationId = contextKey(event);

          const inputContent =
            event?.messages?.[0]?.content ??
            event?.prompt ??
            event?.input ??
            "";
          const inputStr = typeof inputContent === "string" ? inputContent : JSON.stringify(inputContent);

          const channel = resolveChannel(event);

          const scope = startInferenceScope(
            agentDetails,
            model,
            provider,
            inputStr,
            conversationId,
            channel,
          );

          // Record input messages
          if (inputStr) {
            scope.recordInputMessages([inputStr]);
          }

          inferenceScopes.set(key, { scope, startTime: Date.now() });

          console.log(`[a365] InferenceScope started: model=${model} (${provider})`);
        } catch (err: any) {
          console.error(`[a365] llm_input error: ${err.message}`);
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
          const infCtx = inferenceScopes.get(key);
          if (!infCtx) {
            console.log(`[a365] llm_output fired but no InferenceScope found [key=${key}]`);
            return;
          }

          const { scope } = infCtx;

          // Token usage
          const u = event?.lastAssistant?.usage;
          const inputTokens =
            u?.input ?? u?.promptTokens ?? u?.input_tokens ??
            event?.usage?.promptTokens ?? event?.usage?.input_tokens;
          const outputTokens =
            u?.output ?? u?.completionTokens ?? u?.output_tokens ??
            event?.usage?.completionTokens ?? event?.usage?.output_tokens;

          if (inputTokens != null) scope.recordInputTokens(inputTokens);
          if (outputTokens != null) scope.recordOutputTokens(outputTokens);

          // Finish reasons
          const finishReason =
            event?.lastAssistant?.stopReason ?? event?.finishReason ?? event?.response?.finish_reason;
          if (finishReason) {
            const reasons = Array.isArray(finishReason) ? finishReason : [finishReason];
            scope.recordFinishReasons(reasons);
          }

          // Output messages
          const outputContent =
            event?.lastAssistant?.content ??
            event?.response?.content ??
            event?.output ??
            "";
          const outputStr = typeof outputContent === "string" ? outputContent : JSON.stringify(outputContent);
          if (outputStr) {
            scope.recordOutputMessages([outputStr]);
          }

          // Stash tool calls from LLM response for later matching in tool_result_persist
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

          scope.dispose();
          inferenceScopes.delete(key);

          console.log(
            `[a365] InferenceScope ended [key=${key}] tokens=${inputTokens ?? "?"}/${outputTokens ?? "?"} duration=${Date.now() - infCtx.startTime}ms`,
          );
        } catch (err: any) {
          console.error(`[a365] llm_output error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 100 },
    );

    // ── ExecuteToolScope (tool_result_persist) ──

    // Capture tool arguments before execution
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
          console.error(`[a365] before_tool_call error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 100 },
    );

    api.on(
      "tool_result_persist",
      (event: any, _ctx: any) => {
        try {
          const toolName =
            event?.toolName ??
            event?.tool?.name ??
            event?.message?.name ??
            "unknown_tool";

          const msg = event?.message;
          const toolCallId = event?.toolCallId ?? msg?.toolCallId ?? crypto.randomUUID();
          const conversationId = contextKey(event);

          // Look up stashed tool call arguments
          const stashedCall = pendingToolCalls.get(toolCallId);
          if (toolCallId) pendingToolCalls.delete(toolCallId);

          const toolArgs = stashedCall?.arguments ?? "";

          const channel = resolveChannel(event);

          const scope = startExecuteToolScope(
            agentDetails,
            stashedCall?.name ?? toolName,
            toolCallId,
            toolArgs,
            conversationId,
            channel,
          );

          // Record tool result
          const resultContent =
            typeof msg?.content === "string"
              ? msg.content
              : Array.isArray(msg?.content)
                ? msg.content
                    .filter((c: any) => c?.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : "";
          if (resultContent) {
            scope.recordResponse(resultContent.slice(0, 10_000));
          }

          scope.dispose();

          console.log(`[a365] ExecuteToolScope: tool=${toolName}, callId=${toolCallId}`);
        } catch (err: any) {
          console.error(`[a365] tool_result_persist error: ${err.message}`);
        }
        return undefined;
      },
      { priority: 50 },
    );

    console.log("[a365] Plugin registered — hooks: before_agent_start, agent_end, llm_input, llm_output, before_tool_call, tool_result_persist");
  },
};
