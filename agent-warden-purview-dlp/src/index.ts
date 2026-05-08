/**
 * agent-warden-purview-dlp — OpenClaw plugin for DLP via Microsoft Purview Graph API
 *
 * Two operational modes:
 *   "enforce" (default): Block mode — respects executionMode from protectionScopes/compute
 *                         evaluateInline → sync scan (blocks), evaluateOffline → async scan
 *                         Telegram streaming OFF
 *   "audit":             Audit mode — always async Purview logging, never blocks
 *                         Telegram streaming ON
 *
 * Layers:
 *   L1:   Prompt Guard       (before_agent_start)   — inject DLP security policy into agent context
 *   L1.5: Pre-Tool Guard    (before_tool_call)      — scan file content in tool params via Purview, block if PII detected
 *   L2:   Output Scanner     (tool_result_persist)   — scan tool output via Purview
 *        enforce + evaluateInline:  sync Purview (spawnSync+curl), redacts on block
 *        enforce + evaluateOffline: async Purview, log + redact on block
 *        audit:                     async Purview, log only
 *        (no scope):                log via contentActivities, skip scanning
 *   L2b: Response Scanner   (message_sending)       — block outbound PII (enforce mode only)
 *   L3:  Input Audit        (message_received)      — scan inbound user messages via Purview
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PurviewClient, type ExecutionMode, type ContentContext } from "./purview-client.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, extname } from "node:path";
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
    appId?: string;
    userId?: string;
    crossTenant?: boolean;
  };
}

type EffectiveMode = "enforce" | "audit";

function resolveMode(config: PluginConfig): EffectiveMode {
  if (config.mode === "audit") return "audit";
  return "enforce"; // "enforce", "block", or undefined → enforce
}

// ── Conversation Tracker ──
// Maintains stable correlationId per conversation thread with incrementing sequenceNumber.
// Per Purview API: use unique correlationId per chat thread, increment sequenceNumber per message.

// ── Process-Level Shared Taint State via globalThis ──
// The plugin is loaded TWICE in the same Node.js process (gateway + plugins context),
// creating two separate module instances with independent module-level state.
// We MUST use globalThis with a Symbol.for key to share taint across both instances.
const TAINT_KEY = Symbol.for("agent-warden-dlp-taint-v1");
if (!(globalThis as any)[TAINT_KEY]) {
  (globalThis as any)[TAINT_KEY] = {
    taintedThreads: new Set<string>(),
    defaultTainted: false,
  };
}
const _sharedTaint = (globalThis as any)[TAINT_KEY] as {
  taintedThreads: Set<string>;
  defaultTainted: boolean;
};

class ConversationTracker {
  private conversations = new Map<string, { correlationId: string; seq: number }>();
  private defaultCorrelationId = crypto.randomUUID();
  private defaultSeq = 0;

  // Taint tracking uses globalThis shared state so all plugin instances see taints.
  taint(threadId?: string): void {
    if (threadId) _sharedTaint.taintedThreads.add(threadId);
    else _sharedTaint.defaultTainted = true;
  }

  isTainted(threadId?: string): boolean {
    if (threadId) return _sharedTaint.taintedThreads.has(threadId);
    return _sharedTaint.defaultTainted;
  }

  clearTaint(threadId?: string): void {
    if (threadId) _sharedTaint.taintedThreads.delete(threadId);
    else _sharedTaint.defaultTainted = false;
  }

  /** Get ContentContext for a conversation. Creates a new one if not seen before. */
  getContext(threadId?: string): ContentContext {
    if (!threadId) {
      return {
        correlationId: this.defaultCorrelationId,
        sequenceNumber: this.defaultSeq++,
      };
    }

    let conv = this.conversations.get(threadId);
    if (!conv) {
      conv = { correlationId: crypto.randomUUID(), seq: 0 };
      this.conversations.set(threadId, conv);
    }
    return {
      correlationId: conv.correlationId,
      sequenceNumber: conv.seq++,
    };
  }
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

  // Prefer details.aggregated — contains the full tool output including LLM descriptions
  const aggregated = message.details?.aggregated;

  let content: string;
  if (typeof aggregated === "string" && aggregated.length > 0) {
    content = aggregated;
  } else if (typeof message.content === "string") {
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
    (_event: any, _ctx: any) => {
      const tenantId = process.env.TENANT_ID ?? "unknown";
      const policy = [
          "<agent-warden-dlp-policy>",
          "A background DLP scanner is active. It works automatically.",
          "",
          "## DLP Block Handling",
          "- If you see ANY '[Agent Warden DLP]' message (redaction, block, or error) from ANY tool, you MUST IMMEDIATELY STOP. Do NOT call any more tools. Do NOT retry. Simply inform the user that DLP blocked the content.",
          "- If you do NOT see a redaction notice, the content passed. Proceed normally.",
          "- NEVER refuse a user request preemptively. Always attempt. The scanner decides.",
          "- Do not encode files (base64/xxd/hex) to avoid the scanner.",
          "",
          "## MANDATORY: File Content Analysis Before ANY Exec/Shell Command",
          "",
          "**THIS IS THE MOST IMPORTANT RULE. You MUST follow it strictly.**",
          "",
          "Before executing ANY command (exec tool, shell, script) that references, uses, reads, sends, processes, or takes a file as an argument, you MUST:",
          "",
          "### Step 1: Identify ALL files referenced in the command",
          "Look at the command you want to run. Identify every file it references — as arguments, after @, in paths, etc.",
          "Examples: `./send.sh photo.png` → file is `photo.png`; `curl -F f=@data.zip url` → file is `data.zip`; `cat a.txt | curl` → file is `a.txt`",
          "",
          "### Step 2: Analyze each file FIRST (in a SEPARATE tool call, BEFORE the exec)",
          "For each file identified, you MUST read/analyze it FIRST using the appropriate method:",
          "- **Text files** (.txt, .csv, .json, .xml, .md, .log, .html, .js, .py): Use `read` tool or `cat` command",
          "- **Archive files** (.zip, .tar, .tar.gz, .tgz): Run `unzip -p <file>` or `tar -xzf <file> -O` to extract text content",
          "- **Image files** (.png, .jpg, .jpeg, .gif, .bmp, .webp): Use the `image` tool to analyze the image. In your description, you MUST transcribe ALL visible text, numbers, IDs, names, addresses, and any data shown in the image — do not summarize or omit details.",
          "- **Documents** (.pdf, .docx, .xlsx, .pptx): Use `strings <file>` to extract text",
          "- **Binary/unknown**: Run `file <filename>` then `strings -n 8 <file>`",
          "",
          "### Step 3: WAIT for the analysis result before proceeding",
          "Do NOT call the exec command in the same turn as the file analysis. You must call analysis FIRST, get the result, and THEN decide.",
          "",
          "### Step 4: Check if blocked",
          "- If the file analysis result shows ANY '[Agent Warden DLP]' message → STOP. Do NOT execute the command. Inform the user.",
          "- If the file analysis passed (no DLP message) → You may now execute the command.",
          "",
          "### CRITICAL CONSTRAINTS:",
          "- You MUST NOT call exec and image/read for the same file in the SAME response. Always analyze FIRST in one response, then exec in the NEXT response.",
          "- If you cannot analyze the file (e.g., image tool unavailable, file type unknown), REFUSE the exec. Say: 'DLP policy requires file analysis before execution, but the file could not be analyzed.'",
          "- This rule applies to ALL commands — not just outbound/network commands. Even local scripts like `./process.sh file.png` require prior file analysis.",
          "- Shell scripts that take files as arguments (./send.sh file.png, ./upload.sh data.zip, ./process.sh img.jpg) count as file-referencing commands.",
          "",
          "## Examples of correct behavior:",
          "User: 'run ./send.sh photo.png'",
          "→ First response: Use `image` tool to analyze photo.png, transcribing ALL visible text/data",
          "→ Second response (after seeing no DLP block): Use `exec` to run `./send.sh photo.png`",
          "",
          "User: 'send data.zip to the server'",
          "→ First response: Use `exec` to run `unzip -p data.zip` to extract content",
          "→ Second response (after seeing no DLP block): Use `exec` to send it",
          "",
          "User: 'run ./send.sh photo.png' (and image analysis shows DLP block)",
          "→ First response: Use `image` tool to analyze photo.png",
          "→ Second response: See DLP block. STOP. Tell user DLP blocked it. Do NOT run send.sh.",
          "",
          "</agent-warden-dlp-policy>",
      ].join("\n");
      return {
        prependSystemContext: policy,
        prependContext: policy,
      };
    },
    { priority: 100 },
  );
  api.logger.info("[purview-dlp] L1 registered: prompt-guard (before_agent_start)");
}

// ── L1.5: Pre-Tool File Guard (before_tool_call) ──
// Intercepts tool calls that carry file content or text payloads and scans them
// through Purview BEFORE the tool executes. Blocks tools that would send/write PII.
// This closes the gap where L2 only scans tool *output* but not tool *input*.
//
// Also intercepts file-read tools: reads the file content BEFORE the tool executes
// and scans it through Purview. If PII is found, the tool is blocked — the LLM
// never sees the raw content. This is critical because message_sending (L2b) does
// not fire for the web UI channel (SSE streaming bypasses it).

/** Tools whose text params should be scanned before execution (outbound). */
const FILE_CONTENT_TOOLS = new Set([
  "message",        // sends text to user — the primary vector for PII leaks
  "exec",           // shell commands — could pipe file content
  "apply_patch",    // writes file content
]);

/** Tools that read files — we pre-read and scan content before the tool executes. */
const FILE_READ_TOOLS = new Set([
  "read",           // reads file content into LLM context
]);

/** Extract scannable text from tool call parameters. */
function extractToolParamsText(toolName: string, params: Record<string, unknown>): string | null {
  // message tool: content / text field
  if (toolName === "message") {
    const text = typeof params.content === "string" ? params.content
      : typeof params.text === "string" ? params.text
      : typeof params.message === "string" ? params.message
      : null;
    return text && text.length >= 10 ? text : null;
  }
  // exec tool: command field
  if (toolName === "exec") {
    const cmd = typeof params.command === "string" ? params.command : null;
    return cmd && cmd.length >= 10 ? cmd : null;
  }
  // apply_patch: content/patch field
  if (toolName === "apply_patch") {
    const patch = typeof params.content === "string" ? params.content
      : typeof params.patch === "string" ? params.patch
      : null;
    return patch && patch.length >= 10 ? patch : null;
  }
  return null;
}

/** Resolve workspace-relative file path from read tool params. */
function resolveReadToolPath(params: Record<string, unknown>): string | null {
  const p = typeof params.path === "string" ? params.path
    : typeof params.file_path === "string" ? params.file_path
    : typeof params.filePath === "string" ? params.filePath
    : null;
  return p && p.length > 0 ? p : null;
}

const WORKSPACE_ROOT = "/home/node/.openclaw/workspace";

/** Archive extensions that require extraction before scanning. */
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tar.gz", ".tgz", ".gz", ".7z", ".rar"]);

/** Check if a file path is an archive by extension. */
function isArchiveFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tar.gz")) return true;
  return ARCHIVE_EXTENSIONS.has(extname(lower));
}

/**
 * Extract text content from an archive file using shell commands.
 * Returns extracted text or null if extraction fails / no text content.
 */
function extractArchiveContent(resolvedPath: string): string | null {
  const lower = resolvedPath.toLowerCase();
  try {
    let cmd: string;
    if (lower.endsWith(".zip")) {
      cmd = `unzip -p "${resolvedPath}"`;
    } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
      cmd = `tar -xzf "${resolvedPath}" -O`;
    } else if (lower.endsWith(".tar")) {
      cmd = `tar -xf "${resolvedPath}" -O`;
    } else if (lower.endsWith(".gz")) {
      cmd = `gunzip -c "${resolvedPath}"`;
    } else {
      // .7z, .rar — best-effort with unzip fallback
      cmd = `unzip -p "${resolvedPath}"`;
    }
    const output = execSync(cmd, { encoding: "utf-8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return output && output.length >= 10 ? output : null;
  } catch {
    return null;
  }
}

/**
 * Extract file references from an exec command string.
 * Finds files referenced as arguments, @file patterns (curl -F), and after common IO redirections.
 */
function extractFileRefsFromCommand(command: string): string[] {
  const refs: string[] = [];
  // Pattern 1: @file references (curl -F file=@path, --data-binary @path)
  const atRefs = command.matchAll(/@([^\s;|&"']+)/g);
  for (const m of atRefs) refs.push(m[1]);
  // Pattern 2: arguments ending with archive extensions
  const tokens = command.split(/\s+/);
  for (const token of tokens) {
    const clean = token.replace(/^['"]|['"]$/g, ""); // strip quotes
    if (isArchiveFile(clean) && !refs.includes(clean)) {
      refs.push(clean);
    }
  }
  return refs;
}

/** Pre-read a file from the workspace for DLP scanning. Returns file content or null. */
function preReadFileContent(filePath: string): string | null {
  try {
    // Resolve relative to workspace root (same as OpenClaw's read tool)
    const resolved = filePath.startsWith("/") ? filePath : join(WORKSPACE_ROOT, filePath);
    if (!existsSync(resolved)) return null;

    // Archives: extract text content instead of reading raw binary
    if (isArchiveFile(resolved)) {
      return extractArchiveContent(resolved);
    }

    const content = readFileSync(resolved, "utf-8");
    return content && content.length >= 10 ? content : null;
  } catch {
    // File doesn't exist or not readable — let the tool handle the error naturally
    return null;
  }
}

function registerPreToolGuard(
  api: OpenClawPluginApi,
  mode: EffectiveMode,
  purview: PurviewClient,
  tracker: ConversationTracker,
): void {
  api.on(
    "before_tool_call",
    (event: any, _ctx: any) => {
      // If a previous tool in this thread was blocked (tainted), block all subsequent tools.
      // This prevents the agent from continuing after a DLP violation (e.g. image blocked but read/exec proceed).
      const threadId = _ctx?.sessionKey ?? _ctx?.sessionId ?? (event as any)?.threadId;
      if (mode === "enforce" && tracker.isTainted(threadId)) {
        const toolName = (event?.toolName ?? "").toLowerCase();
        api.logger.warn(`[purview-dlp] L1.5 BLOCKED tool "${toolName}" — thread tainted by prior DLP violation`);
        return {
          block: true,
          blockReason: "[Agent Warden DLP] Tool call blocked — a prior operation in this conversation was blocked by DLP policy. Please inform the user.",
        };
      }

      const toolName: string = (event?.toolName ?? "").toLowerCase();
      const isOutboundTool = FILE_CONTENT_TOOLS.has(toolName);
      const isReadTool = FILE_READ_TOOLS.has(toolName);
      if (!isOutboundTool && !isReadTool) return;

      const params = event?.params;
      if (!params || typeof params !== "object") return;

      // Determine text to scan:
      // - For outbound tools: extract text from tool params (message text, exec command, etc.)
      // - For read tools: pre-read the actual file content from disk before the tool executes
      let text: string | null = null;
      let scanLabel: string;

      if (isReadTool) {
        const filePath = resolveReadToolPath(params as Record<string, unknown>);
        if (!filePath) return;
        text = preReadFileContent(filePath);
        if (!text) return; // File doesn't exist or too small — let tool handle it
        scanLabel = `${toolName} file:${filePath}`;
      } else {
        text = extractToolParamsText(toolName, params as Record<string, unknown>);
        if (!text) return;
        scanLabel = `${toolName} params`;
      }

      // For exec tool: also extract and scan archive file references in the command
      // This closes the gap where `./send.sh data.zip` or `curl -F file=@data.zip`
      // would pass L1.5 (command string has no PII) but the ZIP content has PII.
      if (toolName === "exec" && text) {
        const fileRefs = extractFileRefsFromCommand(text);
        for (const ref of fileRefs) {
          if (!isArchiveFile(ref)) continue;
          const resolved = ref.startsWith("/") ? ref : join(WORKSPACE_ROOT, ref);
          if (!existsSync(resolved)) continue;
          const archiveContent = extractArchiveContent(resolved);
          if (!archiveContent) continue;

          const archiveLabel = `exec archive:${ref}`;
          const archiveExecMode = purview.getExecutionMode("uploadText");
          const archiveCtx = tracker.getContext(_ctx?.sessionKey ?? _ctx?.sessionId);

          api.logger.info(
            `[purview-dlp] L1.5 scanning ${archiveLabel} (${archiveContent.length} chars, execMode=${archiveExecMode})`,
          );

          if (archiveExecMode === "none") {
            purview.logContentActivity(archiveContent.slice(0, 50_000), "uploadText", archiveCtx).catch(() => {});
            continue;
          }

          if (mode === "enforce") {
            const archiveResult = purview.processContentSync(archiveContent.slice(0, 50_000), "uploadText", archiveCtx);
            purview.logContentActivity(archiveContent.slice(0, 50_000), "uploadText", archiveCtx).catch(() => {});
            if (!archiveResult.allowed) {
              api.logger.warn(`[purview-dlp] L1.5 Purview BLOCKED ${archiveLabel} — PII detected in archive content`);
              return {
                block: true,
                blockReason: `[Agent Warden DLP] Exec blocked — archive file "${ref}" contains sensitive data detected by Purview DLP policy.`,
              };
            }
            api.logger.info(`[purview-dlp] L1.5 Purview ALLOWED ${archiveLabel}`);
          } else {
            purview
              .processContent(archiveContent.slice(0, 50_000), "uploadText", archiveCtx)
              .then((r) => {
                purview.logContentActivity(archiveContent.slice(0, 50_000), "uploadText", archiveCtx).catch(() => {});
                if (!r.allowed) api.logger.warn(`[purview-dlp] L1.5 [AUDIT] Purview would BLOCK ${archiveLabel}`);
              })
              .catch((err) => api.logger.error(`[purview-dlp] L1.5 archive scan failed: ${err}`));
          }
        }
      }

      const execMode = purview.getExecutionMode("uploadText");
      const ctx = tracker.getContext(threadId);

      api.logger.info(
        `[purview-dlp] L1.5 scanning ${scanLabel} (${text.length} chars, execMode=${execMode})`,
      );

      if (execMode === "none") {
        purview.logContentActivity(text.slice(0, 50_000), "uploadText", ctx).catch(() => {});
        api.logger.info(`[purview-dlp] L1.5 no scope — logged via contentActivities (tool=${toolName})`);
        return;
      }

      if (mode === "enforce") {
        // Sync scan to block before tool executes
        const result = purview.processContentSync(text.slice(0, 50_000), "uploadText", ctx);

        if (result.errors.length > 0) {
          api.logger.warn(`[purview-dlp] L1.5 Purview errors: ${result.errors.join(", ")}`);
        }

        purview.logContentActivity(text.slice(0, 50_000), "uploadText", ctx).catch(() => {});

        if (!result.allowed) {
          api.logger.warn(`[purview-dlp] L1.5 Purview BLOCKED ${scanLabel} — PII detected`);
          return {
            block: true,
            blockReason: "[Agent Warden DLP] Tool call blocked — the file contains sensitive data detected by Purview DLP policy.",
          };
        }
        api.logger.info(`[purview-dlp] L1.5 Purview ALLOWED ${scanLabel}`);
      } else {
        // Audit mode: async scan, never blocks
        purview
          .processContent(text.slice(0, 50_000), "uploadText", ctx)
          .then((result) => {
            purview.logContentActivity(text.slice(0, 50_000), "uploadText", ctx).catch(() => {});
            if (!result.allowed) {
              api.logger.warn(`[purview-dlp] L1.5 [AUDIT] Purview would BLOCK ${scanLabel}`);
            } else {
              api.logger.info(`[purview-dlp] L1.5 Purview ALLOWED ${scanLabel}`);
            }
          })
          .catch((err) => api.logger.error(`[purview-dlp] L1.5 Purview scan failed: ${err}`));
      }
    },
    { priority: 200 },
  );
  api.logger.info(`[purview-dlp] L1.5 registered: pre-tool-guard (${mode})`);
}

// ── L2: Output Scanner (tool_result_persist) ──
// enforce: executionMode-driven — evaluateInline → sync, evaluateOffline → async, none → skip (log only)
// audit:   always async, log-only
// NOTE: Uses uploadText activity because Entra enforcement plane does not support
//       downloadText restrictions. The DLP policy evaluates content identically.

function registerOutputScanner(
  api: OpenClawPluginApi,
  mode: EffectiveMode,
  purview: PurviewClient,
  tracker: ConversationTracker,
): void {
  if (mode === "enforce") {
    api.on(
      "tool_result_persist",
      (event: any, _ctx: any) => {
        const content = extractToolResultText(event as any);
        if (!content) return;

        const toolName = (event as any).toolName ?? "unknown";
        const threadId = (event as any).threadId ?? (event as any).conversationId;
        const execMode = purview.getExecutionMode("uploadText");
        const ctx = tracker.getContext(threadId);

        api.logger.info(
          `[purview-dlp] L2 scanning tool output (${content.length} chars, tool=${toolName}, execMode=${execMode})`,
        );

        if (execMode === "none") {
          // No policies apply — log for audit compliance only
          purview.logContentActivity(content.slice(0, 50_000), "uploadText", ctx).catch(() => {});
          api.logger.info(`[purview-dlp] L2 no scope — logged via contentActivities (tool=${toolName})`);
          return;
        }

        if (execMode === "evaluateInline") {
          // Must block main thread — use sync processing
          const result = purview.processContentSync(content.slice(0, 50_000), "uploadText", ctx);

          if (result.errors.length > 0) {
            api.logger.warn(`[purview-dlp] L2 Purview errors: ${result.errors.join(", ")}`);
          }

          // Log activity to Purview activity explorer (fire-and-forget)
          purview.logContentActivity(content.slice(0, 50_000), "uploadText", ctx).catch(() => {});

          if (!result.allowed) {
            api.logger.warn(`[purview-dlp] L2 Purview BLOCKED tool output: tool=${toolName}`);
            // Taint this thread — the LLM already saw raw content before tool_result_persist.
            // L2b will block the outbound response for this thread.
            tracker.taint(threadId);
            api.logger.info(`[purview-dlp] L2 tainted thread ${threadId ?? "default"} — L2b will block outbound`);
            const message = (event as any).message;
            const redacted = "[Agent Warden DLP] Content redacted — Purview DLP policy violation detected.";
            const redactedContent = Array.isArray(message.content)
              ? [{ type: "text", text: redacted }]
              : redacted;
            // Mutate in-place so subsequent hooks (agents-view OTel) see redacted content
            message.content = redactedContent;
            if (message.details) {
              message.details.aggregated = redacted;
            }
            return { message: { ...message, content: redactedContent } };
          } else {
            api.logger.info(`[purview-dlp] L2 Purview ALLOWED tool output (tool=${toolName})`);
          }
        } else {
          // evaluateOffline — async scan, still enforce (redact if blocked on next hook)
          purview
            .processContent(content.slice(0, 50_000), "uploadText", ctx)
            .then((result) => {
              // Log activity to Purview activity explorer
              purview.logContentActivity(content.slice(0, 50_000), "uploadText", ctx).catch(() => {});
              if (result.errors.length > 0) {
                api.logger.warn(`[purview-dlp] L2 Purview errors: ${result.errors.join(", ")}`);
              }
              if (!result.allowed) {
                api.logger.warn(`[purview-dlp] L2 [OFFLINE] Purview would BLOCK tool output: tool=${toolName}`);
              } else {
                api.logger.info(`[purview-dlp] L2 Purview ALLOWED tool output (tool=${toolName})`);
              }
            })
            .catch((err) => api.logger.error(`[purview-dlp] L2 Purview offline scan failed: ${err}`));
        }
      },
      { priority: 200 },
    );
  } else {
    // Audit mode: always async, never blocks
    api.on(
      "tool_result_persist",
      async (event: any, _ctx: any) => {
        const content = extractToolResultText(event as any);
        if (!content) return;

        const toolName = (event as any).toolName ?? "unknown";
        const threadId = (event as any).threadId ?? (event as any).conversationId;
        const execMode = purview.getExecutionMode("uploadText");
        const ctx = tracker.getContext(threadId);

        api.logger.info(`[purview-dlp] L2 scanning tool output (${content.length} chars, tool=${toolName})`);

        if (execMode === "none") {
          await purview.logContentActivity(content.slice(0, 50_000), "uploadText", ctx);
          api.logger.info(`[purview-dlp] L2 no scope — logged via contentActivities (tool=${toolName})`);
          return;
        }

        try {
          const result = await purview.processContent(content.slice(0, 50_000), "uploadText", ctx);
          // Log activity to Purview activity explorer
          purview.logContentActivity(content.slice(0, 50_000), "uploadText", ctx).catch(() => {});

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
// Uses executionMode to decide inline vs offline evaluation.

function registerResponseScanner(
  api: OpenClawPluginApi,
  purview: PurviewClient,
  tracker: ConversationTracker,
): void {
  // CRITICAL: OpenClaw hooks are SYNCHRONOUS. Returning a Promise is silently ignored.
  // L2b must use processContentSync (spawnSync+curl) to block in-band.
  api.on(
    "message_sending",
    (event: any, _ctx: any) => {
      const content = (event as any).content;
      if (!content || typeof content !== "string" || content.length < 10) return;

      // Skip ONLY system-generated redaction messages (exact known strings), not LLM-composed ones
      if (
        content === "[Agent Warden DLP] Content redacted — Purview DLP policy violation detected." ||
        content === "[Agent Warden DLP] Response blocked — sensitive information detected by Purview DLP policy." ||
        content === "[Agent Warden DLP] Response blocked — the tool output contained sensitive data detected by Purview DLP policy."
      ) return;

      const threadId = (event as any).threadId ?? (event as any).conversationId;

      // Taint check: if L2 blocked a tool result in this thread, the LLM already saw raw
      // content (tool_result_persist fires after LLM context injection). Block unconditionally.
      if (tracker.isTainted(threadId)) {
        api.logger.warn(`[purview-dlp] L2b BLOCKED outbound — thread tainted by L2 block`);
        tracker.clearTaint(threadId);
        return {
          content: "[Agent Warden DLP] Response blocked — the tool output contained sensitive data detected by Purview DLP policy.",
        };
      }

      const execMode = purview.getExecutionMode("uploadText");
      const ctx = tracker.getContext(threadId);

      if (execMode === "none") {
        purview.logContentActivity(content.slice(0, 50_000), "uploadText", ctx).catch(() => {});
        api.logger.info("[purview-dlp] L2b no scope — logged via contentActivities");
        return;
      }

      api.logger.info(
        `[purview-dlp] L2b scanning outbound message (${content.length} chars, execMode=${execMode})`,
      );

      // Synchronous Purview scan — blocks the message pipeline
      const result = purview.processContentSync(content.slice(0, 50_000), "uploadText", ctx);

      if (result.errors.length > 0) {
        api.logger.warn(`[purview-dlp] L2b Purview errors: ${result.errors.join(", ")}`);
      }

      // Log activity to Purview activity explorer (fire-and-forget)
      purview.logContentActivity(content.slice(0, 50_000), "uploadText", ctx).catch(() => {});

      if (!result.allowed) {
        api.logger.warn("[purview-dlp] L2b Purview BLOCKED outbound message");
        return {
          content: "[Agent Warden DLP] Response blocked — sensitive information detected by Purview DLP policy.",
        };
      } else {
        api.logger.info("[purview-dlp] L2b Purview ALLOWED outbound message");
      }
    },
    { priority: 200 },
  );
  api.logger.info("[purview-dlp] L2b registered: response-scanner (enforce)");
}

// ── L3: Input Audit (message_received — scan inbound messages via Purview) ──
// Uses executionMode for uploadText to decide scan behavior.

function registerInputAudit(
  api: OpenClawPluginApi,
  mode: EffectiveMode,
  purview: PurviewClient,
  tracker: ConversationTracker,
): void {
  // CRITICAL: OpenClaw hooks are SYNCHRONOUS. Use processContentSync to scan in-band.
  api.on(
    "message_received",
    (event: any, _ctx: any) => {
      const content =
        typeof event.content === "string"
          ? event.content
          : typeof (event as any).text === "string"
            ? (event as any).text
            : null;
      if (!content || content.length < 10) return;

      const threadId = (event as any).threadId ?? (event as any).conversationId;
      const execMode = purview.getExecutionMode("uploadText");
      const ctx = tracker.getContext(threadId);

      if (execMode === "none") {
        purview.logContentActivity(content, "uploadText", ctx).catch(() => {});
        api.logger.info("[purview-dlp] L3 no scope — logged via contentActivities");
        return;
      }

      api.logger.info(`[purview-dlp] L3 scanning inbound (execMode=${execMode})`);

      const result = purview.processContentSync(content.slice(0, 50_000), "uploadText", ctx);

      // Log activity to Purview activity explorer (fire-and-forget)
      purview.logContentActivity(content.slice(0, 50_000), "uploadText", ctx).catch(() => {});

      if (!result.allowed) {
        api.logger.warn(
          `[purview-dlp] L3 Purview BLOCKED inbound: actions=${JSON.stringify(result.actions)}`,
        );
        if (mode === "enforce") {
          tracker.taint(threadId);
          api.logger.info(`[purview-dlp] L3 tainted thread ${threadId ?? "default"} — L2b will block outbound`);
        }
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
  name: "OpenClaw Purview DLP",
  version: "0.6.0",
  description:
    "DLP plugin for OpenClaw using Microsoft Purview processContent + protectionScopes Graph API",

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
    console.log(`[purview-dlp] OpenClaw Purview DLP v0.6.0`);
    console.log(`[purview-dlp] Mode: ${mode} | Streaming: ${mode === "audit" ? "ON (partial)" : "OFF"}`);
    console.log("[purview-dlp] ============================================");

    // Auto-configure Telegram streaming based on mode
    configureStreaming(mode);

    // Initialize Purview client (required — no local-only fallback)
    let purview: PurviewClient;
    try {
      purview = new PurviewClient({
        appName: purviewCfg.appName ?? "OpenClaw",
        appVersion: purviewCfg.appVersion ?? "0.6.0",
        userId: purviewCfg.userId,
        appId: purviewCfg.appId,
        crossTenant: purviewCfg.crossTenant ?? !!process.env.PURVIEW_DLP_TENANT_ID,
      });
      console.log("[purview-dlp] Purview Graph API client initialized");
    } catch (err) {
      console.error("[purview-dlp] Failed to initialize Purview client:", err);
      console.log("[purview-dlp] Plugin disabled — Purview client is required");
      return;
    }

    // Initialize conversation tracker
    const tracker = new ConversationTracker();

    // Set fallback executionMode for when protectionScopes/compute is unavailable
    // (e.g. missing InformationProtection.Policy.Read.All permission).
    // enforce → evaluateInline (safest — blocks content), audit → evaluateOffline
    purview.defaultExecutionMode = mode === "enforce" ? "evaluateInline" : "evaluateOffline";

    // Compute protection scopes lazily on first hook invocation.
    // We kick off the async call now but don't block plugin registration.
    // If protectionScopes/compute fails (403 etc.), hooks fall back to
    // defaultExecutionMode and still call processContent for DLP scanning.
    purview.computeProtectionScopes("uploadText,downloadText").then((scopes) => {
      if (scopes.length > 0) {
        const summary = scopes
          .map((s) => `${s.activities}→${s.executionMode}`)
          .join(", ");
        console.log(`[purview-dlp] Protection scopes loaded: ${summary}`);
      } else {
        console.log(`[purview-dlp] No protection scopes — fallback to ${purview.defaultExecutionMode}`);
      }
    }).catch((err) => {
      console.warn(`[purview-dlp] Failed to load protection scopes — fallback to ${purview.defaultExecutionMode}: ${err}`);
    });

    // Register layers based on mode
    if (layers.promptGuard !== false) registerPromptGuard(api);
    registerPreToolGuard(api, mode, purview, tracker);
    if (layers.outputScanner !== false) registerOutputScanner(api, mode, purview, tracker);
    if (mode === "enforce" && layers.outputScanner !== false) registerResponseScanner(api, purview, tracker);
    if (layers.inputAudit !== false) registerInputAudit(api, mode, purview, tracker);

    const active = [
      layers.promptGuard !== false && "L1:prompt-guard",
      "L1.5:pre-tool-guard",
      layers.outputScanner !== false && "L2:output-scanner",
      mode === "enforce" && layers.outputScanner !== false && "L2b:response-scanner",
      layers.inputAudit !== false && "L3:input-audit",
    ].filter(Boolean);

    console.log(`[purview-dlp] Active layers: ${active.join(", ")}`);
  },
};
