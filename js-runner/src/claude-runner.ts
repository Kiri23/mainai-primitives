/**
 * Claude Agent SDK runner for MainAI.
 *
 * Replaces the Python `claude -p` subprocess approach with the official
 * Agent SDK, giving us: streaming, multi-turn sessions, resume,
 * approval bridging, interrupt, and MCP server support.
 */
import { execSync } from "node:child_process";
import {
  query,
  type Query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type SDKResultMessage,
  type SDKAssistantMessage,
  type SDKSystemMessage,
  type PermissionResult,
  type CanUseTool,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the full absolute path to the `claude` binary.
 * The SDK uses `existsSync(path)` — it does NOT search $PATH —
 * so we must give it the real path.
 */
function resolveClaudeBinary(explicit?: string): string | undefined {
  if (explicit) return explicit;
  try {
    // `which` resolves the PATH for us
    return execSync("which claude", { encoding: "utf-8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ClaudeRunConfig {
  /** The user prompt */
  prompt: string;
  /** Working directory for Claude */
  cwd?: string;
  /** Model to use (default: whatever the CLI default is) */
  model?: string;
  /** Permission mode */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Auto-allow all tools (sets bypassPermissions) */
  dangerouslySkipPermissions?: boolean;
  /** Resume a previous session by ID */
  resumeSessionId?: string;
  /** MCP servers to connect */
  mcpServers?: Record<string, McpServerConfig>;
  /** Max turns before stopping */
  maxTurns?: number;
  /** Max budget in USD */
  maxBudgetUsd?: number;
  /** Path to claude binary (default: "claude") */
  binaryPath?: string;
  /** System prompt override */
  systemPrompt?: string;
  /** Whether to stream partial messages */
  includePartialMessages?: boolean;
  /** Allowed tools list (auto-approved without prompting) */
  allowedTools?: string[];
}

export interface ClaudeRunResult {
  /** Final text output */
  output: string;
  /** Session ID for resuming later */
  sessionId: string;
  /** Whether it completed successfully */
  success: boolean;
  /** Cost in USD */
  costUsd: number;
  /** Number of turns used */
  numTurns: number;
  /** Any errors */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Event callbacks (optional, for whoever consumes this)
// ---------------------------------------------------------------------------

export interface ClaudeEventHandlers {
  /** Called on each assistant text delta (streaming) */
  onTextDelta?: (text: string) => void;
  /** Called when a tool is being used */
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  /** Called on system init (session started) */
  onSystemInit?: (info: SDKSystemMessage) => void;
  /** Called on every raw SDK message */
  onMessage?: (message: SDKMessage) => void;
  /** Called when Claude asks for approval */
  onApprovalRequest?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<PermissionResult>;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run a single prompt through Claude Agent SDK.
 * This is the direct replacement for `claude -p "prompt"` subprocess calls.
 */
export async function runClaude(
  config: ClaudeRunConfig,
  handlers?: ClaudeEventHandlers,
): Promise<ClaudeRunResult> {
  const canUseTool: CanUseTool | undefined = handlers?.onApprovalRequest
    ? async (toolName, input, options) => {
        return handlers.onApprovalRequest!(toolName, input);
      }
    : undefined;

  const resolvedBinary = resolveClaudeBinary(config.binaryPath);

  const options: Options = {
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(resolvedBinary ? { pathToClaudeCodeExecutable: resolvedBinary } : {}),
    settingSources: ["user", "project", "local"],
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...(config.dangerouslySkipPermissions
      ? { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }
      : {}),
    ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
    ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
    ...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
    ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
    includePartialMessages: config.includePartialMessages ?? false,
    ...(canUseTool ? { canUseTool } : {}),
  };

  const queryRuntime: Query = query({
    prompt: config.prompt,
    options,
  });

  let sessionId = "";
  let finalResult: SDKResultMessage | undefined;
  const assistantTexts: string[] = [];

  for await (const message of queryRuntime) {
    // Forward every message to the raw handler
    handlers?.onMessage?.(message);

    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          sessionId = message.session_id;
          handlers?.onSystemInit?.(message);
        }
        break;
      }

      case "assistant": {
        const assistantMsg = message as SDKAssistantMessage;
        sessionId = assistantMsg.session_id || sessionId;

        // Extract text content
        for (const block of assistantMsg.message.content) {
          if ("type" in block && block.type === "text" && "text" in block) {
            assistantTexts.push(block.text as string);
          }
          if ("type" in block && block.type === "tool_use") {
            const toolBlock = block as { name: string; input: Record<string, unknown> };
            handlers?.onToolUse?.(toolBlock.name, toolBlock.input);
          }
        }
        break;
      }

      case "stream_event": {
        // Streaming deltas — extract text
        const event = (message as { event: { type: string; delta?: { text?: string } } }).event;
        if (event.type === "content_block_delta" && event.delta?.text) {
          handlers?.onTextDelta?.(event.delta.text);
        }
        break;
      }

      case "result": {
        finalResult = message as SDKResultMessage;
        sessionId = finalResult.session_id || sessionId;
        break;
      }
    }
  }

  const success = finalResult?.subtype === "success";
  const output = success && "result" in finalResult!
    ? finalResult!.result as string
    : assistantTexts.join("");
  const errors = !success && finalResult && "errors" in finalResult
    ? (finalResult.errors as string[])
    : [];

  return {
    output,
    sessionId,
    success,
    costUsd: finalResult?.total_cost_usd ?? 0,
    numTurns: finalResult?.num_turns ?? 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Multi-turn session runner
// ---------------------------------------------------------------------------

/**
 * Create a long-lived multi-turn session.
 * This is the big upgrade over `claude -p` — keeps Claude running
 * and lets you send multiple messages without restarting.
 */
export function createSession(config: Omit<ClaudeRunConfig, "prompt">) {
  const abortController = new AbortController();

  // Prompt queue — push messages in, the SDK consumes them
  let resolveNext: ((msg: SDKUserMessage | null) => void) | null = null;
  const messageQueue: SDKUserMessage[] = [];
  let closed = false;

  const promptIterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          // If there's a queued message, return it immediately
          const queued = messageQueue.shift();
          if (queued) return { value: queued, done: false };
          if (closed) return { value: undefined as any, done: true };

          // Wait for next message
          return new Promise((resolve) => {
            resolveNext = (msg) => {
              resolveNext = null;
              if (msg === null) {
                resolve({ value: undefined as any, done: true });
              } else {
                resolve({ value: msg, done: false });
              }
            };
          });
        },
      };
    },
  };

  const canUseTool: CanUseTool = async (toolName, input) => {
    // Default: allow everything (MainAI runs on own infra)
    return { behavior: "allow", updatedInput: input };
  };

  const resolvedBinary = resolveClaudeBinary(config.binaryPath);

  const options: Options = {
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(resolvedBinary ? { pathToClaudeCodeExecutable: resolvedBinary } : {}),
    settingSources: ["user", "project", "local"],
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...(config.dangerouslySkipPermissions
      ? { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }
      : {}),
    ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
    ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
    ...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
    ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
    includePartialMessages: config.includePartialMessages ?? false,
    canUseTool,
    abortController,
  };

  const queryRuntime: Query = query({
    prompt: promptIterable,
    options,
  });

  function sendMessage(text: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    } as SDKUserMessage;

    if (resolveNext) {
      resolveNext(msg);
    } else {
      messageQueue.push(msg);
    }
  }

  async function interrupt(): Promise<void> {
    await queryRuntime.interrupt();
  }

  function close(): void {
    closed = true;
    if (resolveNext) resolveNext(null);
    abortController.abort();
  }

  return {
    /** The raw SDK query runtime — iterate for messages */
    messages: queryRuntime as AsyncIterable<SDKMessage>,
    /** Send a new user message into the session */
    sendMessage,
    /** Interrupt the current turn */
    interrupt,
    /** Close the session and clean up */
    close,
    /** Change model mid-session */
    setModel: (model: string) => queryRuntime.setModel(model),
    /** Change permission mode mid-session */
    setPermissionMode: (mode: "default" | "acceptEdits" | "bypassPermissions" | "plan") =>
      queryRuntime.setPermissionMode(mode),
    /** Dynamically add/remove MCP servers */
    setMcpServers: (servers: Record<string, McpServerConfig>) =>
      queryRuntime.setMcpServers(servers),
  };
}
