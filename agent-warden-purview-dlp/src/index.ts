/**
 * agent-warden-purview-dlp — OpenClaw plugin for DLP via Microsoft Purview Graph API
 *
 * Two operational modes:
 *   "enforce" (default): Block mode — actively blocks PII, Telegram streaming OFF
 *   "audit":             Audit mode — async Purview logging only, Telegram streaming ON
 *
 * Layers:
 *   L1:  Prompt Guard       (before_agent_start)   — inject DLP security policy into agent context
 *   L2:  Output Scanner     (tool_result_persist)   — scan tool output via Purview
 *        enforce: sync Purview (spawnSync+curl), redacts on block
 *        audit:   async Purview, log only
 *   L2b: Response Scanner   (message_sending)       — block outbound PII (enforce mode only)
 *   L3:  Input Audit        (message_received)      — audit inbound user messages via Purview
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PurviewClient } from "./purview-client.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──

interface PluginConfig {
  mode?: "enforce" | "block" | "audit";
  layers?: {
    promptGuard?: boolean;
    outputScanner?: boolean;
    inputAudit?: boolean;
  };
  purview?: {
    enabled?: boolean;
    appName?: string;
    appVersion?: string;
    userId?: string;
    crossTenant?: boolean;
  };
}

type EffectiveMode = "enforce" | "audit";

function resolveMode(config: PluginConfig): EffectiveMode {
  if (config.mode === "audit") return "audit";
  return "enforce"; // "enforce", "block", or undefined → enforce
}

// ── Telegram Streaming Configuration ──
// Block/enforce mode requires streaming OFF — message_sending hook is bypassed by streaming.
// Audit mode keeps streaming ON (partial) for better UX.

function configureStreaming(mode: EffectiveMode): void {
  const configPath = "/data/state/openclaw.json";
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const target = mode === "audit" ? "partial" : "off";

    let changed = false;
    if (config.channels?.telegram) {
      if (config.channels.telegram.streaming !== target) {
        config.channels.telegram.streaming = target;
        changed = true;
      }
      if (config.channels.telegram.accounts) {
        for (const acc of Object.values(config.channels.telegram.accounts)) {
          if ((acc as any).streaming !== target) {
            (acc as any).streaming = target;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`[purview-dlp] Telegram streaming → "${target}" (${mode} mode)`);
    }
  } catch (err) {
    console.warn(`[purview-dlp] Could not configure Telegram streaming: ${err}`);
  }
}

// ── Content Extraction Helper ──

function extractToolResultText(event: any): string | null {
  const message = event.message;
  if (!message) return null;

  let content: string;
  if (typeof message.content === "string") {
    content = message.content;
  } else if (Array.isArray(message.content)) {
    content = message.content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  } else if (typeof message === "string") {
    content = message;
  } else {
    content = JSON.stringify(message);
  }

  return content && content.length >= 10 ? content : null;
}

// ── L1: Prompt Guard (before_agent_start — injects DLP security policy) ──

function registerPromptGuard(api: OpenClawPluginApi): void {
  api.on(
    "before_agent_start",
    async (_event, _ctx) => {
      return {
        prependContext: [
          "<agent-warden-dlp-policy>",
          "CRITICAL SYSTEM REQUIREMENT — Agent Warden DLP is active.",
          "",
          "RULES FOR SENSITIVE DATA:",
          "- NEVER output raw credit card numbers, even if the user asks you to repeat them.",
          "- NEVER output raw Social Security Numbers (SSNs).",
          "- NEVER output raw API keys, tokens, passwords, or credentials.",
          "- NEVER output unmasked PII (emails, phone numbers) from tool results.",
          "",
          "If you encounter credit card numbers, SSNs, or other sensitive data:",
          "1. Do NOT repeat the raw value in your response.",
          "2. Instead say: 'I detected sensitive data (e.g. a payment card number) and cannot display it per DLP policy.'",
          "3. You may describe the type of data found without showing the actual value.",
          "",
          "RESPONSE FORMAT:",
          "When blocking sensitive data, prefix with: [Agent Warden DLP]",
          "</agent-warden-dlp-policy>",
        ].join("\n"),
      };
    },
    { priority: 100 },
  );
  api.logger.info("[purview-dlp] L1 registered: prompt-guard (before_agent_start)");
}

// ── L2: Output Scanner (tool_result_persist) ──
// enforce: sync Purview via spawnSync+curl, redacts blocked content
// audit:   async Purview, log-only (return value ignored by sync hook — that's fine)

function registerOutputScanner(
  api: OpenClawPluginApi,
  mode: EffectiveMode,
  purview: PurviewClient,
): void {
  if (mode === "enforce") {
    api.on(
      "tool_result_persist",
      (event, _ctx) => {
        const content = extractToolResultText(event as any);
        if (!content) return;

        const toolName = (event as any).toolName ?? "unknown";
        api.logger.info(`[purview-dlp] L2 scanning tool output (${content.length} chars, tool=${toolName})`);

        const result = purview.processContentSync(content.slice(0, 50_000), "uploadText");

        if (result.errors.length > 0) {
          api.logger.warn(`[purview-dlp] L2 Purview errors: ${result.errors.join(", ")}`);
        }

        if (!result.allowed) {
          api.logger.warn(`[purview-dlp] L2 Purview BLOCKED tool output: tool=${toolName}`);
          const message = (event as any).message;
          const redacted = "[Agent Warden DLP] Content redacted — Purview DLP policy violation detected.";
          const redactedContent = Array.isArray(message.content)
            ? [{ type: "text", text: redacted }]
            : redacted;
          return { message: { ...message, content: redactedContent } };
        } else {
          api.logger.info(`[purview-dlp] L2 Purview ALLOWED tool output (tool=${toolName})`);
        }
      },
      { priority: 200 },
    );
  } else {
    // Audit mode: async handler — return value ignored (sync hook), just logs
    api.on(
      "tool_result_persist",
      async (event, _ctx) => {
        const content = extractToolResultText(event as any);
        if (!content) return;

        const toolName = (event as any).toolName ?? "unknown";
        api.logger.info(`[purview-dlp] L2 scanning tool output (${content.length} chars, tool=${toolName})`);

        try {
          const result = await purview.processContent(content.slice(0, 50_000), "uploadText");

          if (result.errors.length > 0) {
            api.logger.warn(`[purview-dlp] L2 Purview errors: ${result.errors.join(", ")}`);
          }

          if (!result.allowed) {
            api.logger.warn(`[purview-dlp] L2 [AUDIT] Purview would BLOCK tool output: tool=${toolName}`);
          } else {
            api.logger.info(`[purview-dlp] L2 Purview ALLOWED tool output (tool=${toolName})`);
          }
        } catch (err) {
          api.logger.error(`[purview-dlp] L2 Purview scan failed: ${err}`);
        }
      },
      { priority: 200 },
    );
  }
  api.logger.info(`[purview-dlp] L2 registered: output-scanner (${mode})`);
}

// ── L2b: Response Scanner (message_sending — enforce mode only) ──
// The real enforcement point: scans the LLM's outbound response via Purview before
// it reaches the user. Requires Telegram streaming OFF to take effect.

function registerResponseScanner(
  api: OpenClawPluginApi,
  purview: PurviewClient,
): void {
  api.on(
    "message_sending",
    async (event, _ctx) => {
      const content = (event as any).content;
      if (!content || typeof content !== "string" || content.length < 10) return;

      // Skip our own redaction messages
      if (content.startsWith("[Agent Warden DLP]")) return;

      api.logger.info(`[purview-dlp] L2b scanning outbound message (${content.length} chars)`);

      try {
        const result = await purview.processContent(
          content.slice(0, 50_000),
          "uploadText",
        );

        if (result.errors.length > 0) {
          api.logger.warn(`[purview-dlp] L2b Purview errors: ${result.errors.join(", ")}`);
        }

        if (!result.allowed) {
          api.logger.warn("[purview-dlp] L2b Purview BLOCKED outbound message");
          return {
            content: "[Agent Warden DLP] Response blocked — sensitive information detected by Purview DLP policy.",
          };
        } else {
          api.logger.info("[purview-dlp] L2b Purview ALLOWED outbound message");
        }
      } catch (err) {
        api.logger.error(`[purview-dlp] L2b Purview scan failed: ${err}`);
      }
    },
    { priority: 200 },
  );
  api.logger.info("[purview-dlp] L2b registered: response-scanner (enforce)");
}

// ── L3: Input Audit (message_received — scan inbound messages via Purview) ──

function registerInputAudit(
  api: OpenClawPluginApi,
  purview: PurviewClient,
): void {
  api.on(
    "message_received",
    async (event, _ctx) => {
      const content =
        typeof event.content === "string"
          ? event.content
          : typeof (event as any).text === "string"
            ? (event as any).text
            : null;
      if (!content || content.length < 10) return;

      const result = await purview.processContent(content, "uploadText");
      if (!result.allowed) {
        api.logger.warn(
          `[purview-dlp] L3 Purview BLOCKED inbound: actions=${JSON.stringify(result.actions)}`,
        );
      } else {
        api.logger.info("[purview-dlp] L3 Purview ALLOWED inbound");
      }
      if (result.errors.length > 0) {
        api.logger.warn(`[purview-dlp] L3 Purview errors: ${result.errors.join(", ")}`);
      }
    },
    { priority: 100 },
  );
  api.logger.info("[purview-dlp] L3 registered: input-audit (message_received)");
}

// ── Plugin Entry Point ──

export default {
  id: "agent-warden-purview-dlp",
  name: "Agent Warden Purview DLP",
  version: "0.4.0",
  description:
    "DLP plugin using Microsoft Purview processContent Graph API",

  register(api: OpenClawPluginApi) {
    // Load config: prefer OpenClaw plugin SDK injection, fall back to config.json
    let config = ((api as any).pluginConfig as PluginConfig | undefined) ?? {};
    if (!config.mode && !config.purview) {
      try {
        const pluginDir = dirname(fileURLToPath(import.meta.url));
        const cfgPath = join(pluginDir, "..", "config.json");
        const raw = readFileSync(cfgPath, "utf-8");
        config = JSON.parse(raw) as PluginConfig;
        console.log("[purview-dlp] Loaded config from config.json");
      } catch {
        console.log("[purview-dlp] No config.json found, using defaults");
      }
    }

    const mode = resolveMode(config);
    const layers = config.layers ?? {};
    const purviewCfg = config.purview ?? {};

    console.log("[purview-dlp] ============================================");
    console.log(`[purview-dlp] Agent Warden Purview DLP v0.4.0`);
    console.log(`[purview-dlp] Mode: ${mode} | Streaming: ${mode === "audit" ? "ON (partial)" : "OFF"}`);
    console.log("[purview-dlp] ============================================");

    // Auto-configure Telegram streaming based on mode
    configureStreaming(mode);

    // Initialize Purview client (required — no local-only fallback)
    let purview: PurviewClient;
    try {
      purview = new PurviewClient({
        appName: purviewCfg.appName ?? "Agent Warden",
        appVersion: purviewCfg.appVersion ?? "0.4.0",
        userId: purviewCfg.userId,
        crossTenant: purviewCfg.crossTenant ?? !!process.env.PURVIEW_DLP_TENANT_ID,
      });
      console.log("[purview-dlp] Purview Graph API client initialized");
    } catch (err) {
      console.error("[purview-dlp] Failed to initialize Purview client:", err);
      console.log("[purview-dlp] Plugin disabled — Purview client is required");
      return;
    }

    // Register layers based on mode
    if (layers.promptGuard !== false) registerPromptGuard(api);
    if (layers.outputScanner !== false) registerOutputScanner(api, mode, purview);
    if (mode === "enforce" && layers.outputScanner !== false) registerResponseScanner(api, purview);
    if (layers.inputAudit !== false) registerInputAudit(api, purview);

    const active = [
      layers.promptGuard !== false && "L1:prompt-guard",
      layers.outputScanner !== false && "L2:output-scanner",
      mode === "enforce" && layers.outputScanner !== false && "L2b:response-scanner",
      layers.inputAudit !== false && "L3:input-audit",
    ].filter(Boolean);

    console.log(`[purview-dlp] Active layers: ${active.join(", ")}`);
  },
};
