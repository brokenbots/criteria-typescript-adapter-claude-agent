/**
 * Claude Code Agent Adapter for Criteria
 *
 * This adapter controls the actual Claude Code CLI agent (not the Anthropic API)
 * via the @anthropic-ai/claude-agent-sdk. The agent can read files, run commands,
 * edit code, and use all built-in Claude Code tools.
 *
 * Features:
 * - Spawns real Claude Code CLI subprocess
 * - Bridges permission requests to Criteria's permission system
 * - Custom MCP tool `submit_outcome` for workflow integration
 * - Session persistence across execute calls
 * - Structured events for observability
 *
 * Environment Variables:
 * - ANTHROPIC_API_KEY: Required for first-party API access.
 *
 * Example workflow:
 * ```hcl
 * step "refactor" {
 *   adapter = "claude-code"
 *   input {
 *     prompt = "Refactor the auth module to use OAuth2"
 *   }
 *   outcome "success" { transition_to = "test" }
 *   outcome "failure" { transition_to = "review" }
 * }
 * ```
 */

import { serve, type EventSender, type ExecuteRequest, type PermitRequest } from '@criteria/adapter-sdk';
import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, Query, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

interface SessionState {
  query: Query | null;
  finalizedOutcome: string | null;
  finalizedReason: string;
  claudeSessionId: string | null;
  lastResultText: string;
  pendingPermissions: Map<string, { toolUseID: string; resolve: (result: PermissionResult) => void; reject: (reason: Error) => void }>;
  allowedOutcomes: Set<string>;
}

// ============================================================================
// Constants
// ============================================================================

const PLUGIN_NAME = 'claude-code';
const PLUGIN_VERSION = '0.1.0';

const SUBMIT_OUTCOME_TOOL_NAME = 'submit_outcome';
const SUBMIT_OUTCOME_DESCRIPTION = `Finalize the outcome for the current workflow step. Call this exactly once with one of the allowed outcomes when you are done with your task. The allowed outcomes are provided in the system context.`;

// ============================================================================
// Sessions
// ============================================================================

const sessions = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

function createSession(sessionId: string): SessionState {
  const state: SessionState = {
    query: null,
    finalizedOutcome: null,
    finalizedReason: '',
    claudeSessionId: null,
    lastResultText: '',
    pendingPermissions: new Map(),
    allowedOutcomes: new Set(),
  };
  sessions.set(sessionId, state);
  return state;
}

function closeSession(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (state?.query) {
    try {
      state.query.close();
    } catch {
      // ignore
    }
  }
  // Reject any pending permissions so they don't hang
  for (const { reject } of state?.pendingPermissions.values() || []) {
    reject(new Error('Session closed'));
  }
  sessions.delete(sessionId);
}

// ============================================================================
// MCP Server
// ============================================================================

function buildOutcomeMcpServer(state: SessionState) {
  const outcomes = Array.from(state.allowedOutcomes);
  const outcomeSchema = outcomes.length > 0
    ? z.enum(outcomes as [string, ...string[]]).describe(`The outcome to submit. Must be one of: ${outcomes.join(', ')}`)
    : z.string().describe('The outcome name to finalize.');

  return createSdkMcpServer({
    name: 'criteria-workflow',
    tools: [
      {
        name: SUBMIT_OUTCOME_TOOL_NAME,
        description: SUBMIT_OUTCOME_DESCRIPTION,
        inputSchema: {
          outcome: outcomeSchema,
          reason: z.string().optional().describe('Optional reason or explanation for the outcome.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        handler: async (args: any) => {
          const outcome = args.outcome?.trim() as string | undefined;
          const reason = (args.reason?.trim() as string | undefined) || '';

          if (!outcome) {
            return {
              content: [{ type: 'text', text: 'Outcome is required. Please provide a valid outcome name.' }],
              isError: true,
            };
          }

          if (!state.allowedOutcomes.has(outcome)) {
            const allowed = Array.from(state.allowedOutcomes).join(', ');
            if (state.allowedOutcomes.size === 0) {
              return {
                content: [{ type: 'text', text: 'No outcomes are declared for this step.' }],
                isError: true,
              };
            }
            return {
              content: [{ type: 'text', text: `Outcome "${outcome}" is not allowed. Choose one of: ${allowed}` }],
              isError: true,
            };
          }

          if (state.finalizedOutcome !== null) {
            return {
              content: [{ type: 'text', text: `Outcome already finalized as "${state.finalizedOutcome}".` }],
              isError: true,
            };
          }

          state.finalizedOutcome = outcome;
          state.finalizedReason = reason;

          // Interrupt the agent so the workflow can proceed
          if (state.query) {
            try {
              await state.query.interrupt();
            } catch {
              // ignore interrupt errors
            }
          }

          return {
            content: [{ type: 'text', text: `Outcome "${outcome}" recorded successfully. Workflow will proceed.` }],
          };
        },
      },
    ],
  });
}

// ============================================================================
// Permission Bridge
// ============================================================================

function buildCanUseTool(state: SessionState, sender: EventSender) {
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
    const details: Record<string, string> = {
      tool: toolName,
      toolUseId: options.toolUseID,
    };
    if (options.title) details.title = options.title;
    if (options.displayName) details.displayName = options.displayName;
    if (options.description) details.description = options.description;
    try {
      details.input = JSON.stringify(input).slice(0, 4000);
    } catch {
      details.input = '<unserializable>';
    }

    const permissionId = await sender.permissionRequest(toolName, details);

    return new Promise<PermissionResult>((resolve) => {
      const timeout = setTimeout(() => {
        state.pendingPermissions.delete(permissionId);
        resolve({ behavior: 'deny', message: 'Permission request timed out.', toolUseID: options.toolUseID });
      }, 300_000); // 5 minute timeout

      state.pendingPermissions.set(permissionId, {
        toolUseID: options.toolUseID,
        resolve: (result) => {
          clearTimeout(timeout);
          state.pendingPermissions.delete(permissionId);
          resolve(result);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          state.pendingPermissions.delete(permissionId);
          resolve({ behavior: 'deny', message: reason.message, toolUseID: options.toolUseID });
        },
      });
    });
  };
}

// ============================================================================
// Message Stream Handler
// ============================================================================

async function handleMessageStream(
  state: SessionState,
  sender: EventSender,
  q: Query
): Promise<void> {
  for await (const msg of q) {
    // Capture session id from any message for resume on next execute
    if ('session_id' in msg && msg.session_id) {
      state.claudeSessionId = msg.session_id;
    }

    switch (msg.type) {
      case 'assistant': {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              await sender.log('stdout', block.text);
              await sender.adapterEvent('agent.message', { content: block.text });
            }
          }
        }
        break;
      }

      case 'stream_event': {
        // Partial assistant message during streaming
        if (msg.event && msg.event.type === 'content_block_delta') {
          const delta = (msg.event as any).delta;
          if (delta?.type === 'text_delta' && delta.text) {
            await sender.log('stdout', delta.text);
          }
        }
        break;
      }

      case 'tool_progress': {
        const progressMsg = (msg as any).message || `${msg.tool_name} running...`;
        await sender.log('stdout', `[${msg.tool_name}] ${progressMsg}\n`);
        await sender.adapterEvent('tool.progress', { tool: msg.tool_name, message: progressMsg });
        break;
      }

      case 'system': {
        break;
      }

      case 'result': {
        // Final result message — log the agent's full text output
        if (msg.subtype === 'success') {
          if (msg.result) {
            state.lastResultText = msg.result;
            await sender.log('stdout', msg.result + '\n');
          }
          await sender.adapterEvent('query.complete', { durationMs: msg.duration_ms, turns: msg.num_turns, costUsd: msg.total_cost_usd });
        } else {
          const errorText = (msg as any).errors?.join('\n') || `Query error: ${msg.subtype}`;
          await sender.log('stderr', `[claude-code] ${errorText}\n`);
          await sender.adapterEvent('query.error', { subtype: msg.subtype, errors: (msg as any).errors || [] });
        }
        break;
      }

      case 'auth_status': {
        if (msg.isAuthenticating) {
          await sender.log('stdout', '[claude-code] Authenticating...\n');
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

async function executeStep(state: SessionState, req: ExecuteRequest, sender: EventSender): Promise<void> {
  const prompt = req.config.prompt;
  if (!prompt) {
    throw new Error('config.prompt is required');
  }

  // Reset per-execution state
  state.finalizedOutcome = null;
  state.finalizedReason = '';
  state.lastResultText = '';
  state.allowedOutcomes = new Set(req.allowedOutcomes);

  // Build system prompt append — outcome instructions always included;
  // user-configured system_prompt appended after.
  const outcomeInstructions = req.allowedOutcomes.length > 0
    ? `You are integrated into a workflow system. When you have completed your task, you MUST call the \`${SUBMIT_OUTCOME_TOOL_NAME}\` tool to finalize the step. The allowed outcomes are: ${req.allowedOutcomes.join(', ')}. Do not stop or explain that you are done — just call the tool.`
    : `You are integrated into a workflow system.`;

  const systemPromptAppend = req.config.system_prompt
    ? `${outcomeInstructions}\n\n${req.config.system_prompt}`
    : outcomeInstructions;

  await sender.log('stdout', `[claude-code] Starting agent query...\n`);

  const mcpServer = buildOutcomeMcpServer(state);
  const abortController = new AbortController();

  const q = query({
    prompt,
    options: {
      abortController,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend },
      cwd: req.config.cwd || process.cwd(),
      canUseTool: buildCanUseTool(state, sender),
      // Auto-allow the submit_outcome MCP tool so it bypasses the permission system
      allowedTools: [`mcp__${mcpServer.name}__${SUBMIT_OUTCOME_TOOL_NAME}`],
      tools: { type: 'preset', preset: 'claude_code' },
      // Pass MCP server inline so it's available from the first turn
      mcpServers: { [mcpServer.name]: mcpServer },
      // Only persist/resume a session if we have an explicit ID from a prior turn.
      // Without this guard, the claude CLI auto-resumes its last on-disk session
      // which can inject unrelated conversation context into the new step.
      persistSession: state.claudeSessionId !== null,
      resume: state.claudeSessionId || undefined,
      model: req.config.model || undefined,
      thinking: req.config.thinking === 'true'
        ? { type: 'adaptive' }
        : undefined,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'criteria-adapter-claude-code/0.1.0',
        ...(req.config.auth_token ? { ANTHROPIC_AUTH_TOKEN: req.config.auth_token } : {}),
        ...(req.config.api_key ? { ANTHROPIC_API_KEY: req.config.api_key } : {}),
        ...(req.config.base_url ? { ANTHROPIC_BASE_URL: req.config.base_url } : {}),
      },
    },
  });

  state.query = q;

  try {
    await handleMessageStream(state, sender, q);
  } catch (e) {
    await sender.log('stderr', `[claude-code] Query error: ${e}\n`);
  } finally {
    state.query = null;
  }

  // Determine outcome
  if (state.finalizedOutcome) {
    await sender.result(state.finalizedOutcome, {
      reason: state.finalizedReason,
      ...(state.lastResultText ? { output: state.lastResultText } : {}),
    });
    return;
  }

  // No outcome was submitted
  if (state.allowedOutcomes.has('needs_review')) {
    await sender.result('needs_review', { reason: 'Agent completed without submitting an outcome' });
  } else {
    await sender.adapterEvent('outcome.failure', { reason: 'missing submit_outcome' });
    await sender.result('failure', { reason: 'Agent completed without submitting an outcome' });
  }
}

// ============================================================================
// Main
// ============================================================================

serve({
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  capabilities: ['multi_turn', 'structured_events', 'tool_calling'],

  configSchema: {
    fields: {
      model: { type: 'string', required: false, doc: 'Model to use (e.g., claude-sonnet-4-6)' },
      cwd: { type: 'string', required: false, doc: 'Working directory for the agent. Defaults to process.cwd().' },
      system_prompt: { type: 'string', required: false, doc: 'Custom system prompt prepended to every execute call' },
      thinking: { type: 'bool', required: false, doc: 'Enable adaptive thinking mode' },
      auth_token: { type: 'string', required: false, doc: 'Value for ANTHROPIC_AUTH_TOKEN' },
      api_key: { type: 'string', required: false, doc: 'Value for ANTHROPIC_API_KEY' },
      base_url: { type: 'string', required: false, doc: 'Value for ANTHROPIC_BASE_URL' },
    },
  },

  inputSchema: {
    fields: {
      prompt: { type: 'string', required: true, doc: 'The task prompt to send to Claude Code' },
      model: { type: 'string', required: false, doc: 'Per-step model override' },
    },
  },

  async onOpenSession(req) {
    createSession(req.sessionId);
  },

  async execute(req, sender) {
    const state = getSession(req.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${req.sessionId}`);
    }
    await executeStep(state, req, sender);
  },

  async onPermit(req) {
    const state = getSession(req.sessionId);
    if (!state) return;

    const pending = state.pendingPermissions.get(req.permissionId);
    if (!pending) return;

    if (req.allow) {
      pending.resolve({ behavior: 'allow', toolUseID: pending.toolUseID });
    } else {
      pending.resolve({
        behavior: 'deny',
        message: req.reason || 'Denied by user',
        toolUseID: pending.toolUseID,
      });
    }
  },

  async onCloseSession(req) {
    closeSession(req.sessionId);
  },
});
