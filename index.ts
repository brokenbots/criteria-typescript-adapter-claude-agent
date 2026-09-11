/**
 * Claude Code Agent Adapter for Criteria (Protocol v2)
 *
 * This adapter controls the actual Claude Code CLI agent (not the Anthropic API)
 * via the @anthropic-ai/claude-agent-sdk. The agent can read files, run commands,
 * edit code, and use all built-in Claude Code tools.
 *
 * Features:
 * - Spawns real Claude Code CLI subprocess
 * - Bridges permission requests to Criteria's permission system via helpers.permission
 * - Custom MCP tool `submit_outcome` for workflow integration
 * - Session persistence across execute calls
 * - Structured events for observability
 *
 * Secrets:
 * - ANTHROPIC_API_KEY     – Optional. If unset, the Claude Code CLI falls back
 *   to its own stored credentials (e.g. `claude` login / OAuth).
 * - ANTHROPIC_AUTH_TOKEN  – Optional. Auth token.
 * - CRITERIA_REMOTE_TOKEN – Optional. Bearer token presented to the remote host
 *   shim during the identity handshake. Only used in remote mode.
 *
 * Config:
 * - base_url              – Optional. Overrides the Anthropic API base URL.
 *   Falls back to the ANTHROPIC_BASE_URL environment variable.
 *
 * Remote mode:
 * - CRITERIA_REMOTE_HOST  – Optional. When set, the adapter dials this host:port
 *   and runs via `serveRemote()` instead of local `serve()`.
 * - CRITERIA_REMOTE_DIGEST – Required in remote mode. The adapter artifact digest
 *   sent in the identity handshake and verified by the host.
 */

import { serve, serveRemote } from "@criteria/adapter-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, PermissionResult, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Helpers, ExecuteRequest } from "@criteria/adapter-sdk";
import {
  SUBMIT_OUTCOME_TOOL_NAME,
  MAX_FINALIZE_ATTEMPTS,
  REDACTED_PLACEHOLDER,
  createOutcomeState,
  buildOutcomeMcpServer,
  buildOutcomeInstructions,
  buildRepromptPrompt,
  resolveOutcome,
  sanitizeReason,
} from "./outcome.js";

// ============================================================================
// Constants
// ============================================================================

const PLUGIN_NAME = "claude-agent";
// Injected at build time via `--define` (see scripts/build.ts) from the release
// tag, so the reported version can't drift from what was published. Falls back
// to "0.0.0-dev" when run without a compile step (e.g. `bun test`).
const PLUGIN_VERSION = process.env.PLUGIN_VERSION ?? "0.0.0-dev";

/**
 * Passed through to the Claude Code subprocess. The agent SDK treats
 * `options.env` as a full replacement for the child environment, so anything
 * omitted here is simply absent — without PATH and HOME the CLI cannot resolve
 * its own tools or read its credentials. The host environment is not forwarded
 * wholesale: the agent runs untrusted model output, so only these are shared.
 */
const ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
] as const;


const VALID_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
type ReasoningEffort = (typeof VALID_REASONING_EFFORTS)[number];

const REASONING_EFFORT_BUDGET_TOKENS: Record<ReasoningEffort, number> = {
  none: 0,
  low: 4096,
  medium: 16384,
  high: 65536,
};

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && VALID_REASONING_EFFORTS.includes(value as ReasoningEffort);
}

/**
 * Validate and normalize a reasoning_effort value. Returns undefined when the
 * input is undefined/null/empty. Throws a clear error for unsupported values.
 */
function validateReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (isReasoningEffort(value)) {
    return value;
  }
  throw new Error(
    `Invalid reasoning_effort ${JSON.stringify(value)}. Valid values: ${VALID_REASONING_EFFORTS.join(", ")}.`
  );
}

/**
 * Validate a model identifier. Returns undefined when the input is undefined/
 * null/empty. Trims whitespace and rejects empty or malformed identifiers.
 */
function validateModel(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid model ${JSON.stringify(value)}: must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("Invalid model: must be a non-empty string.");
  }
  if (!/^[a-zA-Z0-9_.\-/:]+$/.test(trimmed)) {
    throw new Error(
      `Invalid model ${JSON.stringify(trimmed)}: must contain only letters, numbers, hyphens, underscores, dots, slashes, and colons.`
    );
  }
  return trimmed;
}

/**
 * Convert a legacy `thinking` boolean into the reasoning_effort vocabulary.
 * `true` maps to "high" (generalizes the previous adaptive-thinking behavior
 * into the high-effort budget tier), `false` maps to "none". Returns undefined
 * when the value is not a boolean.
 */
function reasoningEffortFromThinking(value: unknown): ReasoningEffort | undefined {
  if (value === true) return "high";
  if (value === false) return "none";
  return undefined;
}

/**
 * Coerce the legacy `thinking` config value, which may be a boolean or the
 * strings "true"/"false", into a boolean. Returns undefined for other values.
 */
function coerceLegacyThinking(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

/**
 * Map a reasoning_effort level to the Claude Code SDK thinking configuration.
 * - none  -> disabled
 * - low   -> enabled with a small token budget
 * - medium-> enabled with a moderate token budget
 * - high  -> enabled with a large token budget
 */
function thinkingConfigFromReasoningEffort(
  effort: ReasoningEffort | undefined
): ThinkingConfig | undefined {
  if (effort === undefined) return undefined;
  if (effort === "none") return { type: "disabled" as const };
  return {
    type: "enabled" as const,
    budgetTokens: REASONING_EFFORT_BUDGET_TOKENS[effort],
  };
}

// ============================================================================
// Output sanitization
// ============================================================================

// ============================================================================
// Timeout resolution
// ============================================================================

/**
 * Validate a timeout value from config or per-step input. Returns undefined
 * when the input is undefined/null/empty/zero. Throws a clear error for
 * unsupported values. Negative values are rejected; non-integer numbers are
 * accepted but rounded to milliseconds.
 */
function resolveTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Invalid timeout ${JSON.stringify(value)}: must be a finite number of milliseconds.`);
    }
  } else {
    throw new Error(`Invalid timeout ${JSON.stringify(value)}: must be a number of milliseconds.`);
  }
  if (numeric <= 0) {
    throw new Error(`Invalid timeout ${numeric}: must be a positive number of milliseconds.`);
  }
  return numeric;
}

// ============================================================================
// Claude Code CLI discovery
// ============================================================================

function passthroughEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the Claude Code CLI.
 *
 * The agent SDK's default resolution loads a per-platform optional npm package
 * at runtime. `bun build --compile` cannot bundle that native binary, so a
 * compiled adapter must point the SDK at an executable explicitly.
 */
function resolveClaudeExecutable(configured?: string): string | undefined {
  if (configured) {
    if (!isExecutable(configured)) {
      throw new Error(`claude_executable "${configured}" is not an executable file`);
    }
    return configured;
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

// ============================================================================
// Permission Bridge
// ============================================================================

function buildCanUseTool(helpers: Helpers) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
    }
  ): Promise<PermissionResult> => {
    const payload: Record<string, unknown> = { tool: toolName, args: input };
    if (input && typeof input === "object") {
      if (typeof (input as any).command === "string" && (input as any).command.length > 0) {
        payload.full_command_text = (input as any).command;
      }
      if ("commands" in (input as any)) {
        const cmds = (input as any).commands;
        if (typeof cmds === "string" || (Array.isArray(cmds) && cmds.every((c: unknown) => typeof c === "string"))) {
          payload.commands = cmds;
        }
      }
    }
    const decision = await helpers.permission.request(payload);
    if (decision.decision === "allow") {
      return { behavior: "allow", toolUseID: options.toolUseID };
    }
    return {
      behavior: "deny",
      message: decision.reason || "Denied by host",
      toolUseID: options.toolUseID,
    };
  };
}

// ============================================================================
// Message Stream Handler
// ============================================================================

async function handleMessageStream(
  helpers: Helpers,
  q: Query,
  state: {
    lastResultText: string;
    claudeSessionId: string | null;
  }
): Promise<void> {
  for await (const msg of q) {
    if ("session_id" in msg && (msg as any).session_id) {
      state.claudeSessionId = (msg as any).session_id as string;
    }

    switch (msg.type) {
      case "assistant": {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              await helpers.log.stdout(block.text);
              await helpers.log.adapterEvent("agent.message", { content: block.text });
            }
          }
        }
        break;
      }

      case "stream_event": {
        if (msg.event && msg.event.type === "content_block_delta") {
          const delta = (msg.event as any).delta;
          if (delta?.type === "text_delta" && delta.text) {
            await helpers.log.stdout(delta.text);
          }
        }
        break;
      }

      case "tool_progress": {
        const progressMsg = (msg as any).message || `${msg.tool_name} running...`;
        await helpers.log.stdout(`[${msg.tool_name}] ${progressMsg}\n`);
        await helpers.log.adapterEvent("tool.progress", { tool: msg.tool_name, message: progressMsg });
        break;
      }

      case "system": {
        break;
      }

      case "result": {
        if (msg.subtype === "success") {
          if (msg.result) {
            state.lastResultText = msg.result;
            await helpers.log.stdout(msg.result + "\n");
          }
          await helpers.log.adapterEvent("query.complete", {
            durationMs: msg.duration_ms,
            turns: msg.num_turns,
            costUsd: msg.total_cost_usd,
          });
        } else {
          const errorText = (msg as any).errors?.join("\n") || `Query error: ${msg.subtype}`;
          await helpers.log.stderr(`[claude-agent] ${errorText}\n`);
          await helpers.log.adapterEvent("query.error", {
            subtype: msg.subtype,
            errors: (msg as any).errors || [],
          });
        }
        break;
      }

      case "auth_status": {
        if (msg.isAuthenticating) {
          await helpers.log.stdout("[claude-agent] Authenticating...\n");
        }
        break;
      }

      default:
        break;
    }
  }
}

// ============================================================================
// Execute Logic
// ============================================================================

async function executeStep(
  req: ExecuteRequest,
  helpers: Helpers
): Promise<void> {
  const prompt = req.input.prompt;
  if (!prompt) {
    throw new Error("input.prompt is required");
  }

  // Reset per-execution state
  let lastResultText = "";
  let claudeSessionId = helpers.session.get<string | null>("claudeSessionId") ?? null;

  const allowedOutcomes = req.allowedOutcomes ?? [];
  const outcomeInstructions = buildOutcomeInstructions(allowedOutcomes);

  // The outcome instructions are always appended: without them the agent never
  // learns that `submit_outcome` exists and the step can only fail.
  const customSystemPrompt = helpers.session.get<string>("systemPromptAppend");
  const systemPromptAppend = customSystemPrompt
    ? `${customSystemPrompt}\n\n${outcomeInstructions}`
    : outcomeInstructions;

  await helpers.log.stdout("[claude-agent] Starting agent query...\n");

  // Secrets the adapter actually holds and therefore must redact from any
  // agent-authored output before returning it to the workflow.
  const apiKey = (await helpers.secrets.get("ANTHROPIC_API_KEY")) ?? undefined;
  const authToken = (await helpers.secrets.get("ANTHROPIC_AUTH_TOKEN")) ?? undefined;
  const heldSecrets = [apiKey, authToken];

  const outcomeState = createOutcomeState();
  const mcpServer = buildOutcomeMcpServer({ allowedOutcomes, capture: outcomeState, heldSecrets, helpers });
  const abortController = new AbortController();

  // Configure a per-step timeout. Precedence: per-step input, session config,
  // then no timeout. A positive timeout aborts the query and forces a timeout
  // outcome if the agent never calls submit_outcome in time.
  const timeoutMs =
    resolveTimeoutMs(req.input.timeout_ms as unknown) ??
    helpers.session.get<number>("stepTimeoutMs") ??
    undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      outcomeState.timedOut = true;
      abortController.abort(new Error(`Outcome capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  // Per-step `input.cwd` overrides the adapter-level `config.cwd`.
  const cwd = req.input.cwd || helpers.session.get<string>("cwd") || process.cwd();
  // Per-step `input.model` overrides the adapter-level `config.model`,
  // which in turn overrides the CLI default.
  const model = validateModel(req.input.model as unknown) ?? helpers.session.get<string>("model") ?? undefined;
  const reasoningEffort = helpers.session.get<ReasoningEffort>("reasoningEffort") ?? undefined;
  const thinking = thinkingConfigFromReasoningEffort(reasoningEffort);

  const claudeExecutable = resolveClaudeExecutable(
    helpers.session.get<string>("claudeExecutable") ?? undefined
  );
  if (!claudeExecutable) {
    throw new Error(
      "Claude Code CLI not found on PATH. Install it, or set the adapter's `claude_executable` config field."
    );
  }

  // base_url is a config field (not a secret): precedence is config, then the
  // ANTHROPIC_BASE_URL environment variable. It is not in ENV_PASSTHROUGH, so
  // the env var only reaches the subprocess if we forward it explicitly below.
  const baseURL =
    helpers.session.get<string>("baseUrl") || process.env.ANTHROPIC_BASE_URL || undefined;

  const buildOptions = (resume: string | undefined) => ({
    abortController,
    systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: systemPromptAppend },
    cwd,
    canUseTool: buildCanUseTool(helpers),
    allowedTools: [`mcp__${mcpServer.name}__${SUBMIT_OUTCOME_TOOL_NAME}`],
    tools: { type: "preset" as const, preset: "claude_code" as const },
    mcpServers: { [mcpServer.name]: mcpServer },
    // Must stay on for the first execute too, otherwise nothing is written to
    // disk and the `resume` on the next step has no session to attach to.
    persistSession: true,
    resume,
    model,
    thinking,
    pathToClaudeCodeExecutable: claudeExecutable,
    env: {
      ...passthroughEnv(),
      CLAUDE_AGENT_SDK_CLIENT_APP: `criteria-adapter-claude-agent/${PLUGIN_VERSION}`,
      ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
      ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
      ...(authToken ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
    },
  });

  const streamState = { lastResultText, claudeSessionId };

  const runQuery = async (queryPrompt: string, resume: string | undefined) => {
    try {
      await handleMessageStream(
        helpers,
        query({ prompt: queryPrompt, options: buildOptions(resume) }),
        streamState
      );
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // A timeout abort is expected and already recorded on the state; other
      // errors are terminal agent failures.
      if (!outcomeState.timedOut) {
        outcomeState.error = err;
      }
      await helpers.log.stderr(`[claude-agent] Query error: ${err.message}\n`);
    } finally {
      // Persist session ID for resume
      helpers.session.set("claudeSessionId", streamState.claudeSessionId);
      helpers.session.set("lastResultText", streamState.lastResultText);
    }
  };

  await runQuery(prompt, claudeSessionId || undefined);

  // The agent often answers and stops without finalizing. Re-prompt it in the
  // same session, resuming so it keeps the conversation context. We count the
  // initial query as attempt 1 and allow up to MAX_FINALIZE_ATTEMPTS total
  // attempts, matching the copilot adapter behavior (1 initial + 2 reprompts).
  let attempts = 1;
  while (
    !outcomeState.finalized &&
    !outcomeState.timedOut &&
    !outcomeState.error &&
    allowedOutcomes.length > 0 &&
    streamState.claudeSessionId &&
    attempts < MAX_FINALIZE_ATTEMPTS
  ) {
    const nextAttempt = attempts + 1;
    await helpers.log.adapterEvent("outcome.reprompt", {
      attempt: nextAttempt,
      maxAttempts: MAX_FINALIZE_ATTEMPTS,
    });
    await runQuery(buildRepromptPrompt(allowedOutcomes), streamState.claudeSessionId);
    attempts = nextAttempt;
  }

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  const resolved = await resolveOutcome({
    state: outcomeState,
    allowedOutcomes,
    attempts,
    helpers,
    heldSecrets,
  });
  await helpers.outcomes.finalize(resolved.outcome, { reason: resolved.reason });
}

// ============================================================================
// Main
// ============================================================================

export const adapterConfig = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description: "Claude Code agent adapter for Criteria workflows.",

  source_url: "https://github.com/brokenbots/criteria-typescript-adapter-claude-agent",
  capabilities: ["multi_turn", "tool_calling", "structured_events"],
  platforms: ["linux/amd64", "linux/arm64", "darwin/arm64"],

  secrets: [
    { name: "ANTHROPIC_API_KEY", required: false, description: "Anthropic API key. If unset, the Claude Code CLI uses its own stored credentials." },
    { name: "ANTHROPIC_AUTH_TOKEN", required: false, description: "Auth token" },
  ],

  permissions: [
    { name: "Read" },
    { name: "Bash" },
    { name: "Write" },
    { name: "Edit" },
    { name: "Glob" },
    { name: "Grep" },
  ],

  config_schema: {
    fields: {
      model: { type: "string", required: false, description: "Model to use (e.g., claude-sonnet-4-6). Falls back to the Claude Code CLI default." },
      cwd: { type: "string", required: false, description: "Working directory for the agent. Defaults to process.cwd()." },
      system_prompt: { type: "string", required: false, description: "Custom system prompt prepended to every execute call" },
      reasoning_effort: { type: "string", required: false, description: "Reasoning effort for the agent: none, low, medium, or high." },
      thinking: { type: "boolean", required: false, description: "Deprecated. Use reasoning_effort instead. `true` maps to high, `false` to none." },
      claude_executable: { type: "string", required: false, description: "Path to the Claude Code CLI. Defaults to `claude` on PATH." },
      base_url: { type: "string", required: false, description: "Override the Anthropic API base URL. Falls back to the ANTHROPIC_BASE_URL environment variable." },
      step_timeout_ms: { type: "number", required: false, description: "Maximum time in milliseconds to wait for the agent to submit an outcome. When exceeded, the adapter aborts the query and emits a timeout outcome. No timeout when unset." },
    },
  },

  input_schema: {
    fields: {
      prompt: { type: "string", required: true, description: "The task prompt to send to Claude Code" },
      model: { type: "string", required: false, description: "Per-step model override" },
      cwd: { type: "string", required: false, description: "Per-step working directory override. Takes precedence over config.cwd." },
      timeout_ms: { type: "number", required: false, description: "Per-step override for the maximum time in milliseconds to wait for an outcome. Takes precedence over config.step_timeout_ms." },
    },
  },

  output_schema: {
    fields: {
      reason: {
        type: "string",
        required: false,
        description:
          "Agent-authored prose returned when the agent calls submit_outcome. " +
          "May include repository or user content. " +
          "Before returning, the adapter redacts verbatim occurrences of any secret value it holds " +
          `(currently ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN), replacing them with "${REDACTED_PLACEHOLDER}". ` +
          "This is best-effort hygiene: general secret detection is not performed, so the text is not guaranteed to be free of sensitive material.",
      },
    },
  },

  async openSession(req: any, helpers: Helpers) {
    // Validate and store adapter-level config in session.
    const model = validateModel(req.config.model);

    // reasoning_effort takes precedence over the legacy `thinking` boolean.
    let reasoningEffort: ReasoningEffort | undefined;
    if (req.config.reasoning_effort !== undefined) {
      reasoningEffort = validateReasoningEffort(req.config.reasoning_effort);
    } else {
      const legacyThinking = coerceLegacyThinking(req.config.thinking);
      if (legacyThinking !== undefined) {
        reasoningEffort = validateReasoningEffort(reasoningEffortFromThinking(legacyThinking));
      }
    }

    helpers.session.set("model", model || undefined);
    helpers.session.set("cwd", req.config.cwd || undefined);
    helpers.session.set("reasoningEffort", reasoningEffort || undefined);
    helpers.session.set("claudeExecutable", req.config.claude_executable || undefined);
    helpers.session.set("baseUrl", req.config.base_url || undefined);
    helpers.session.set("stepTimeoutMs", resolveTimeoutMs(req.config.step_timeout_ms as unknown) ?? undefined);
    helpers.session.set(
      "systemPromptAppend",
      req.config.system_prompt
        ? `${req.config.system_prompt}`
        : undefined
    );
    helpers.session.set("claudeSessionId", null);
    helpers.session.set("lastResultText", "");
  },

  async execute(req: any, helpers: Helpers) {
    await executeStep(req, helpers);
  },

  async snapshot(_sessionId: string, helpers: Helpers) {
    const payload = {
      claudeSessionId: helpers.session.get<string | null>("claudeSessionId") ?? null,
      lastResultText: helpers.session.get<string>("lastResultText") ?? "",
      model: helpers.session.get<string>("model") ?? undefined,
      cwd: helpers.session.get<string>("cwd") ?? undefined,
      reasoningEffort: helpers.session.get<ReasoningEffort>("reasoningEffort") ?? undefined,
      systemPromptAppend: helpers.session.get<string>("systemPromptAppend") ?? undefined,
      baseUrl: helpers.session.get<string>("baseUrl") ?? undefined,
      claudeExecutable: helpers.session.get<string>("claudeExecutable") ?? undefined,
      stepTimeoutMs: helpers.session.get<number>("stepTimeoutMs") ?? undefined,
    };
    const state = new TextEncoder().encode(JSON.stringify(payload));
    return { state, schemaVersion: 1 };
  },

  async restore(_sessionId: string, blob: { state: Uint8Array; schemaVersion?: number }, helpers: Helpers) {
    const text = new TextDecoder().decode(blob.state);
    const snapshot = JSON.parse(text) as Record<string, unknown>;
    helpers.session.set("claudeSessionId", (snapshot.claudeSessionId as string | null) ?? null);
    helpers.session.set("lastResultText", (snapshot.lastResultText as string) ?? "");
    helpers.session.set("model", snapshot.model as string | undefined);
    helpers.session.set("cwd", snapshot.cwd as string | undefined);
    // Migrate legacy `thinking` boolean snapshots into the reasoning_effort vocabulary.
    if (snapshot.reasoningEffort !== undefined) {
      helpers.session.set("reasoningEffort", snapshot.reasoningEffort as ReasoningEffort | undefined);
    } else if (snapshot.thinking !== undefined) {
      helpers.session.set("reasoningEffort", reasoningEffortFromThinking(snapshot.thinking));
    } else {
      helpers.session.set("reasoningEffort", undefined);
    }
    helpers.session.set("systemPromptAppend", snapshot.systemPromptAppend as string | undefined);
    helpers.session.set("baseUrl", snapshot.baseUrl as string | undefined);
    helpers.session.set("claudeExecutable", snapshot.claudeExecutable as string | undefined);
    helpers.session.set("stepTimeoutMs", snapshot.stepTimeoutMs as number | undefined);
  },
};

/**
 * Entry-point dispatcher. Detects remote mode from the environment and calls
 * either `serveRemote()` (when CRITERIA_REMOTE_HOST is set) or the local
 * `serve()` path. Exported so tests can exercise mode selection without
 * spawning a real process.
 */
export async function main(): Promise<void> {
  const remoteHost = process.env.CRITERIA_REMOTE_HOST;
  if (remoteHost) {
    const digest = process.env.CRITERIA_REMOTE_DIGEST;
    if (!digest) {
      throw new Error(
        "CRITERIA_REMOTE_DIGEST is required when running in remote mode (CRITERIA_REMOTE_HOST is set)"
      );
    }

    await serveRemote(adapterConfig, {
      host: remoteHost,
      ...(process.env.CRITERIA_REMOTE_TOKEN
        ? { accept_token: process.env.CRITERIA_REMOTE_TOKEN }
        : {}),
      identity: {
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        digest,
      },
    });
    return;
  }

  serve(adapterConfig);
}

// Only start the server when this file is the main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default adapterConfig;
