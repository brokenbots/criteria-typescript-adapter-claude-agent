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
 * - ANTHROPIC_API_KEY    – Required for first-party API access.
 * - ANTHROPIC_BASE_URL   – Optional. Override the API base URL.
 * - ANTHROPIC_AUTH_TOKEN – Optional. Auth token.
 */

import { serve } from "@criteria/adapter-sdk";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Query, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Helpers, ExecuteRequest } from "@criteria/adapter-sdk";

// ============================================================================
// Constants
// ============================================================================

const PLUGIN_NAME = "claude-agent";
const PLUGIN_VERSION = "0.5.1";

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

const SUBMIT_OUTCOME_TOOL_NAME = "submit_outcome";

/**
 * Calling `submit_outcome` is model behaviour, not a guarantee — the agent
 * regularly answers a conversational prompt and stops. Re-prompt it this many
 * times before giving up and taking the fallback outcome.
 */
const MAX_FINALIZE_ATTEMPTS = 3;
const SUBMIT_OUTCOME_DESCRIPTION = `Finalize the outcome for the current workflow step. Call this exactly once with one of the allowed outcomes when you are done with your task. The allowed outcomes are provided in the system context.`;

// ============================================================================
// MCP Server
// ============================================================================

interface OutcomeCapture {
  outcome: string | null;
  reason: string;
  finalized: boolean;
}

function buildOutcomeMcpServer(allowedOutcomes: string[], capture: OutcomeCapture) {
  const outcomeSchema =
    allowedOutcomes.length > 0
      ? z
          .enum(allowedOutcomes as [string, ...string[]])
          .describe(`The outcome to submit. Must be one of: ${allowedOutcomes.join(", ")}`)
      : z.string().describe("The outcome name to finalize.");

  return createSdkMcpServer({
    name: "criteria-workflow",
    // Without this the tool is deferred behind tool search, so the agent never
    // sees `submit_outcome` in its prompt and the step cannot be finalized.
    alwaysLoad: true,
    tools: [
      {
        name: SUBMIT_OUTCOME_TOOL_NAME,
        description: SUBMIT_OUTCOME_DESCRIPTION,
        inputSchema: {
          outcome: outcomeSchema,
          reason: z.string().optional().describe("Optional reason or explanation for the outcome."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        handler: async (args: any) => {
          const outcome = args.outcome?.trim() as string | undefined;
          const reason = (args.reason?.trim() as string | undefined) || "";

          if (!outcome) {
            return {
              content: [{ type: "text", text: "Outcome is required. Please provide a valid outcome name." }],
              isError: true,
            };
          }

          if (!allowedOutcomes.includes(outcome)) {
            if (allowedOutcomes.length === 0) {
              return {
                content: [{ type: "text", text: "No outcomes are declared for this step." }],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Outcome "${outcome}" is not allowed. Choose one of: ${allowedOutcomes.join(", ")}`,
                },
              ],
              isError: true,
            };
          }

          if (capture.finalized) {
            return {
              content: [{ type: "text", text: `Outcome already finalized as "${capture.outcome}".` }],
              isError: true,
            };
          }

          capture.outcome = outcome;
          capture.reason = reason;
          capture.finalized = true;

          return {
            content: [
              { type: "text", text: `Outcome "${outcome}" recorded successfully. Workflow will proceed.` },
            ],
            metadata: { outcome, reason },
          };
        },
      },
    ],
  });
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
    const decision = await helpers.permission.request({ tool: toolName, args: input });
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
    finalizedOutcome: string | null;
    finalizedReason: string;
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
  let finalizedOutcome: string | null = null;
  let finalizedReason = "";
  let lastResultText = "";
  let claudeSessionId = helpers.session.get<string | null>("claudeSessionId") ?? null;

  const allowedOutcomes = req.allowedOutcomes ?? [];
  const outcomeInstructions =
    allowedOutcomes.length > 0
      ? `You are integrated into a workflow system. When you have completed your task, you MUST call the \`${SUBMIT_OUTCOME_TOOL_NAME}\` tool to finalize the step. The allowed outcomes are: ${allowedOutcomes.join(", ")}. Do not stop or explain that you are done — just call the tool.`
      : `You are integrated into a workflow system.`;

  // The outcome instructions are always appended: without them the agent never
  // learns that `submit_outcome` exists and the step can only fail.
  const customSystemPrompt = helpers.session.get<string>("systemPromptAppend");
  const systemPromptAppend = customSystemPrompt
    ? `${customSystemPrompt}\n\n${outcomeInstructions}`
    : outcomeInstructions;

  await helpers.log.stdout("[claude-agent] Starting agent query...\n");

  const capture: OutcomeCapture = { outcome: null, reason: "", finalized: false };
  const mcpServer = buildOutcomeMcpServer(allowedOutcomes, capture);
  const abortController = new AbortController();

  const cwd = helpers.session.get<string>("cwd") ?? process.cwd();
  // Per-step `input.model` overrides the adapter-level `config.model`.
  const model = req.input.model || helpers.session.get<string>("model") || undefined;
  const thinking = helpers.session.get<boolean>("thinking") ?? false;

  const claudeExecutable = resolveClaudeExecutable(
    helpers.session.get<string>("claudeExecutable") ?? undefined
  );
  if (!claudeExecutable) {
    throw new Error(
      "Claude Code CLI not found on PATH. Install it, or set the adapter's `claude_executable` config field."
    );
  }

  const apiKey = (await helpers.secrets.get("ANTHROPIC_API_KEY")) ?? undefined;
  const baseURL = (await helpers.secrets.get("ANTHROPIC_BASE_URL")) ?? undefined;
  const authToken = (await helpers.secrets.get("ANTHROPIC_AUTH_TOKEN")) ?? undefined;

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
    thinking: thinking ? { type: "adaptive" as const } : undefined,
    pathToClaudeCodeExecutable: claudeExecutable,
    env: {
      ...passthroughEnv(),
      CLAUDE_AGENT_SDK_CLIENT_APP: `criteria-adapter-claude-agent/${PLUGIN_VERSION}`,
      ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
      ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
      ...(authToken ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
    },
  });

  const state = { finalizedOutcome, finalizedReason, lastResultText, claudeSessionId };

  const runQuery = async (prompt: string, resume: string | undefined) => {
    try {
      await handleMessageStream(helpers, query({ prompt, options: buildOptions(resume) }), state);
    } catch (e) {
      await helpers.log.stderr(`[claude-agent] Query error: ${e}\n`);
    } finally {
      // Persist session ID for resume
      helpers.session.set("claudeSessionId", state.claudeSessionId);
      helpers.session.set("lastResultText", state.lastResultText);
    }
  };

  await runQuery(prompt, claudeSessionId || undefined);

  // The agent often answers and stops without finalizing. Re-prompt it in the
  // same session, resuming so it keeps the conversation context.
  let attempts = 0;
  while (
    !capture.finalized &&
    allowedOutcomes.length > 0 &&
    state.claudeSessionId &&
    attempts < MAX_FINALIZE_ATTEMPTS
  ) {
    attempts++;
    await helpers.log.adapterEvent("outcome.reprompt", {
      attempt: attempts,
      maxAttempts: MAX_FINALIZE_ATTEMPTS,
    });
    await runQuery(
      `You have not finalized this workflow step. Call the \`${SUBMIT_OUTCOME_TOOL_NAME}\` tool now with one of: ${allowedOutcomes.join(", ")}. Respond with the tool call only.`,
      state.claudeSessionId
    );
  }

  // Determine outcome from capture
  if (capture.outcome) {
    await helpers.outcomes.finalize(capture.outcome, { reason: capture.reason });
    return;
  }

  // No outcome was submitted, even after re-prompting
  const reason = `Agent completed without submitting an outcome after ${attempts} re-prompt(s)`;
  if (allowedOutcomes.includes("needs_review")) {
    await helpers.outcomes.finalize("needs_review", { reason });
  } else {
    await helpers.log.adapterEvent("outcome.failure", { reason: "missing submit_outcome", attempts });
    await helpers.outcomes.finalize("failure", { reason });
  }
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
    { name: "ANTHROPIC_API_KEY", required: true, description: "Anthropic API key" },
    { name: "ANTHROPIC_BASE_URL", required: false, description: "Override base URL" },
    { name: "ANTHROPIC_AUTH_TOKEN", required: false, description: "Auth token" },
  ],

  permissions: [
    { name: "read_file" },
    { name: "write_file" },
    { name: "edit_file" },
    { name: "run_command" },
    { name: "list_directory" },
  ],

  config_schema: {
    fields: {
      model: { type: "string", required: false, description: "Model to use (e.g., claude-sonnet-4-6)" },
      cwd: { type: "string", required: false, description: "Working directory for the agent. Defaults to process.cwd()." },
      system_prompt: { type: "string", required: false, description: "Custom system prompt prepended to every execute call" },
      thinking: { type: "boolean", required: false, description: "Enable adaptive thinking mode" },
      claude_executable: { type: "string", required: false, description: "Path to the Claude Code CLI. Defaults to `claude` on PATH." },
    },
  },

  input_schema: {
    fields: {
      prompt: { type: "string", required: true, description: "The task prompt to send to Claude Code" },
      model: { type: "string", required: false, description: "Per-step model override" },
    },
  },

  async openSession(req: any, helpers: Helpers) {
    // Store adapter-level config in session
    helpers.session.set("model", req.config.model || undefined);
    helpers.session.set("cwd", req.config.cwd || undefined);
    helpers.session.set("thinking", req.config.thinking === true || req.config.thinking === "true" || undefined);
    helpers.session.set("claudeExecutable", req.config.claude_executable || undefined);
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
      thinking: helpers.session.get<boolean>("thinking") ?? undefined,
      systemPromptAppend: helpers.session.get<string>("systemPromptAppend") ?? undefined,
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
    helpers.session.set("thinking", snapshot.thinking as boolean | undefined);
    helpers.session.set("systemPromptAppend", snapshot.systemPromptAppend as string | undefined);
  },
};

// Only start the server when this file is the main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  serve(adapterConfig);
}

export default adapterConfig;
