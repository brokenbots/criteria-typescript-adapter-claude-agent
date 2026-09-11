/**
 * Structured outcome handling for the claude-agent adapter.
 *
 * Mirrors the patterns in the copilot adapter's copilot_outcome.go:
 * - typed capture state with attempt/failure-kind tracking
 * - allowed-outcome validation inside the submit_outcome handler
 * - duplicate/missing/invalid/no_outcomes failure kinds
 * - redaction of adapter-held secrets from agent-authored reasons
 * - helper functions for reprompt text, fallback reasons, timeout reasons, and
 *   finalization.
 */

import { z } from "zod";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Helpers } from "@criteria/adapter-sdk";

export const SUBMIT_OUTCOME_TOOL_NAME = "submit_outcome";

/**
 * Placeholder used when a secret value the adapter holds appears in the
 * agent-authored `reason` text. The replacement is visible so readers can see
 * that something was removed, rather than silently dropping it.
 */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Calling `submit_outcome` is model behaviour, not a guarantee — the agent
 * regularly answers a conversational prompt and stops. Re-prompt it this many
 * times before giving up and taking the fallback outcome.
 */
export const MAX_FINALIZE_ATTEMPTS = 3;

export const SUBMIT_OUTCOME_DESCRIPTION = `Finalize the outcome for the current workflow step. Call this exactly once with one of the allowed outcomes when you are done with your task. The allowed outcomes are provided in the system context.`;

export type FinalizeFailureKind = "missing" | "invalid_outcome" | "duplicate" | "no_outcomes";

/**
 * Mutable per-execute state for outcome capture. The MCP tool handler writes
 * into this object; the execute loop reads it to decide when to stop
 * reprompting and which outcome to report.
 */
export interface OutcomeState {
  finalized: boolean;
  finalizedOutcome: string | null;
  finalizedReason: string;
  finalizeAttempts: number;
  finalizeFailureKind: FinalizeFailureKind | "";
  timedOut: boolean;
  error: Error | null;
}

export interface BuildOutcomeServerOptions {
  allowedOutcomes: string[];
  capture: OutcomeState;
  heldSecrets: (string | undefined)[];
  helpers: Helpers;
}

/**
 * Create a fresh, empty outcome capture state for a new execute call.
 */
export function createOutcomeState(): OutcomeState {
  return {
    finalized: false,
    finalizedOutcome: null,
    finalizedReason: "",
    finalizeAttempts: 0,
    finalizeFailureKind: "",
    timedOut: false,
    error: null,
  };
}

/**
 * Best-effort redaction of secret values the adapter actually holds.
 *
 * This only removes verbatim occurrences of secrets the adapter has received
 * (currently ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN). It does not do
 * general-purpose secret detection, PII scrubbing, or entropy heuristics,
 * because those produce false positives that corrupt legitimate agent prose.
 * An agent's explanation may still contain other repository or user content;
 * consumers must decide where to route it.
 */
export function sanitizeReason(reason: string, secrets: (string | undefined)[]): string {
  const toRedact = secrets
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    // Longer secrets first so a shorter value cannot slice a longer one.
    .sort((a, b) => b.length - a.length);

  let sanitized = reason;
  for (const value of toRedact) {
    // Escape regex metacharacters so the secret is matched literally.
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "g");
    sanitized = sanitized.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return sanitized;
}

/**
 * Build the system-prompt appendix that tells the agent it must call
 * submit_outcome with one of the allowed outcomes.
 */
export function buildOutcomeInstructions(allowedOutcomes: string[]): string {
  if (allowedOutcomes.length === 0) {
    return "You are integrated into a workflow system.";
  }
  return (
    `You are integrated into a workflow system. When you have completed your task, you MUST call the \`${SUBMIT_OUTCOME_TOOL_NAME}\` tool to finalize the step. ` +
    `The allowed outcomes are: ${allowedOutcomes.join(", ")}. Do not stop or explain that you are done — just call the tool.`
  );
}

/**
 * Build the corrective user prompt sent on a reprompt turn.
 */
export function buildRepromptPrompt(allowedOutcomes: string[]): string {
  const list = allowedOutcomes.join(", ");
  return (
    `You have not finalized this workflow step. Call the \`${SUBMIT_OUTCOME_TOOL_NAME}\` tool now with one of: ${list}. ` +
    `Respond with the tool call only.`
  );
}

function sortedAllowedOutcomes(allowedOutcomes: string[]): string[] {
  return [...allowedOutcomes].sort();
}

function submitOutcomeError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function submitOutcomeSuccess(outcome: string, reason: string, heldSecrets: (string | undefined)[]) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Outcome "${outcome}" recorded successfully. Workflow will proceed.`,
      },
    ],
    metadata: { outcome, reason: sanitizeReason(reason, heldSecrets) },
  };
}

/**
 * Build the MCP server that exposes `submit_outcome`. The tool handler performs
 * allowed-outcome validation, duplicate detection, and updates the shared
 * OutcomeState. Validation errors are returned as MCP tool errors so the model
 * can retry within the same turn.
 */
export function buildOutcomeMcpServer(options: BuildOutcomeServerOptions) {
  const { allowedOutcomes, capture, heldSecrets, helpers } = options;

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

          capture.finalizeAttempts++;

          if (capture.finalized) {
            capture.finalizeFailureKind = "duplicate";
            return submitOutcomeError(
              `Outcome already finalized as "${capture.finalizedOutcome}" in this turn; do not call submit_outcome again.`
            );
          }

          if (!outcome) {
            capture.finalizeFailureKind = "missing";
            return submitOutcomeError("Outcome is required. Please provide a valid outcome name.");
          }

          if (!allowedOutcomes.includes(outcome)) {
            if (allowedOutcomes.length === 0) {
              capture.finalizeFailureKind = "no_outcomes";
              return submitOutcomeError(
                "No outcomes are declared for this step; it cannot be finalized via submit_outcome."
              );
            }
            capture.finalizeFailureKind = "invalid_outcome";
            const allowedList = sortedAllowedOutcomes(allowedOutcomes);
            return submitOutcomeError(
              `Outcome "${outcome}" is not in the allowed set; choose one of: ${allowedList.join(", ")}`
            );
          }

          capture.finalized = true;
          capture.finalizedOutcome = outcome;
          capture.finalizedReason = reason;
          capture.finalizeFailureKind = "";

          await helpers.log.adapterEvent("outcome.finalized", {
            outcome,
            reason: sanitizeReason(reason, heldSecrets),
          });

          return submitOutcomeSuccess(outcome, reason, heldSecrets);
        },
      },
    ],
  });
}

export interface ResolveOutcomeOptions {
  state: OutcomeState;
  allowedOutcomes: string[];
  attempts: number;
  helpers: Helpers;
  heldSecrets: (string | undefined)[];
}

export interface ResolvedOutcome {
  outcome: string;
  reason: string;
}

/**
 * Resolve the terminal outcome from the capture state and emit the
 * appropriate diagnostic event. This is the single place that decides between:
 *   - a valid submitted outcome
 *   - a timeout outcome
 *   - an error outcome (query failed)
 *   - a fallback outcome after exhausting reprompt attempts
 */
export async function resolveOutcome(options: ResolveOutcomeOptions): Promise<ResolvedOutcome> {
  const { state, allowedOutcomes, attempts, helpers, heldSecrets } = options;

  // 1. Valid submitted outcome: already emitted outcome.finalized by the tool.
  if (state.finalized && state.finalizedOutcome) {
    return {
      outcome: state.finalizedOutcome,
      reason: sanitizeReason(state.finalizedReason, heldSecrets),
    };
  }

  // 2. Timeout before any valid outcome.
  if (state.timedOut) {
    const allowedList = sortedAllowedOutcomes(allowedOutcomes);
    const reason = sanitizeReason(
      `Outcome capture timed out before the agent called submit_outcome. Allowed outcomes were: ${allowedList.join(", ")}`,
      heldSecrets
    );
    await helpers.log.adapterEvent("outcome.timeout", {
      reason,
      allowed_outcomes: allowedList,
      attempts,
    });
    if (allowedOutcomes.includes("needs_review")) {
      return { outcome: "needs_review", reason };
    }
    return { outcome: "failure", reason };
  }

  // 3. General agent/query error before any valid outcome.
  if (state.error) {
    const reason = sanitizeReason(
      `Agent query failed before finalizing: ${state.error.message || "unknown error"}`,
      heldSecrets
    );
    await helpers.log.adapterEvent("outcome.failure", {
      reason,
      kind: "agent_error",
      attempts,
    });
    if (allowedOutcomes.includes("needs_review")) {
      return { outcome: "needs_review", reason };
    }
    return { outcome: "failure", reason };
  }

  // 4. Exhausted reprompt attempts without a valid outcome.
  const kind: FinalizeFailureKind = state.finalizeFailureKind || "missing";
  const reasonLabels: Record<FinalizeFailureKind, string> = {
    missing: "missing finalize",
    invalid_outcome: "invalid outcome",
    duplicate: "duplicate finalize",
    no_outcomes: "step has no declared outcomes",
  };
  const reasonLabel = reasonLabels[kind] || "missing finalize";
  const allowedList = sortedAllowedOutcomes(allowedOutcomes);
  const reason = sanitizeReason(
    `Agent completed without submitting a valid outcome after ${attempts} finalize attempt(s) (${reasonLabel}).`,
    heldSecrets
  );

  await helpers.log.adapterEvent("outcome.failure", {
    reason,
    kind,
    allowed_outcomes: allowedList,
    attempts,
  });

  if (allowedOutcomes.includes("needs_review")) {
    return { outcome: "needs_review", reason };
  }
  return { outcome: "failure", reason };
}
