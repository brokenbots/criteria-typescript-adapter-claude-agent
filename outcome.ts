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
import { REDACTED_PLACEHOLDER, sanitizeReason } from "./redaction.js";

// The held-secret redaction primitives live in the shared redaction module
// (contract.ts hashes redacted canonical payload renderings); re-exported so
// consumers keep importing them from the outcome module.
export { REDACTED_PLACEHOLDER, sanitizeReason };
import {
  CALL_ERROR_HOST_UNSUPPORTED,
  CALL_ERROR_UNKNOWN_ADAPTER,
  CALL_ERROR_UNKNOWN_TOOL,
  ToolCallDeniedError,
  ToolCallError,
  ToolCallStreamClosedError,
  ToolCallTimeoutError,
} from "@criteria/adapter-sdk";
import type { Helpers } from "@criteria/adapter-sdk";
import {
  contractSchemaCarrying,
  ContractModeContext,
  evaluateContractSubmission,
  finalizedDisplayReason as resolveFinalizedDisplayReason,
  FinalizeResolution,
  foldDeclaredPayloadParams,
  formatFallbackFinalizeReason,
  formatNeverFinalizedFallbackReason,
  outcomeNotAllowedIssue,
  truncateText,
} from "./contract.js";
import {
  decodeSubmitOutcomeArgs,
  StepSurface,
  SubmitArgsDecodeError,
} from "./surface.js";

export const SUBMIT_OUTCOME_TOOL_NAME = "submit_outcome";

/** Name of the caller-side tool the agent invokes to call another adapter's tool (CRI-180). */
export const ADAPTER_TOOL_TOOL_NAME = "adapter_tool";

export const ADAPTER_TOOL_DESCRIPTION =
  "Call a tool that is exposed by another adapter in this workflow, e.g. adapter.greet.hello.tools.greet. " +
  "Only targets granted to this step's tools are callable. " +
  "A failed call does not fail the step: it returns a typed error as this tool's result (isError), which you should " +
  'incorporate into your answer — give up after "host_unsupported", report the denial and continue after a denied call, ' +
  'and correct the target after "unknown_tool".';

/**
 * Calling `submit_outcome` is model behaviour, not a guarantee — the agent
 * regularly answers a conversational prompt and stops. Re-prompt it this many
 * times before giving up and taking the fallback outcome.
 */
export const MAX_FINALIZE_ATTEMPTS = 3;

export const SUBMIT_OUTCOME_DESCRIPTION = `Finalize the outcome for the current workflow step. Call this exactly once with one of the allowed outcomes when you are done with your task. The allowed outcomes are provided in the system context.`;

/**
 * KB-263 wrong-lane rejection (typed): a schema-carrying typed outcome does
 * not consume a top-level `reason` parameter at all — the payload is the
 * output, so the step's findings belong under the payload's declared fields.
 */
export const TYPED_REASON_NOT_CONSUMED_MESSAGE =
  'submit_outcome rejected: "reason" is not consumed by this typed outcome (its contract declares a payload schema, so the payload is the output). ' +
  "The step's findings belong under the payload's declared fields — the schema's reason field when the contract declares one. " +
  'Call submit_outcome again without the "reason" parameter.';

/**
 * Normalize a submitted payload to the wire form: only plain JSON objects
 * forward; degenerate shapes (null, arrays, scalars) collapse to an empty
 * object (the pinned evaluator's object-decode lane already rejected them,
 * so this is only reachable on the success path of a schema-less contract).
 */
function normalizedFinalizePayload(payload: unknown): Record<string, unknown> {
  return payload !== undefined &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

export type FinalizeFailureKind =
  | "missing"
  | "invalid_outcome"
  | "invalid_params"
  | "comment_missing"
  | "invalid_payload"
  | "duplicate"
  | "no_outcomes"
  | "payload_validation_failed";

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
  /**
   * Contract mode: the host aborted the in-flight query because a finalize
   * became terminal (valid submission, fallback, or exhausted budget); the
   * resulting AgentAbortError is expected, not a query failure.
   */
  finalizeAborted: boolean;
  /** Contract mode: the validated model payload, forwarded verbatim. */
  submittedPayload: Record<string, unknown> | null;
  /** Contract mode: true only for a model-submitted valid finalize (synthetic
   * fallbacks finalize without it, so host-repair `recovered` stays honest). */
  finalizedViaTool: boolean;
  /** Contract mode: issue strings from the last payload rejection (drives the
   * exhaustion diagnostics when no fallback is configured). */
  finalizeFailureIssues: string[];
  /**
   * Outcome-event display reason (KB-263): the finalized event's reason prose.
   * Empty default keeps legacy lanes byte-identical; contract mode resolves
   * it from the submitted payload (schema reason, else a sha256 digest).
   */
  finalizedDisplayReason: string;
}

export interface BuildOutcomeServerOptions {
  allowedOutcomes: string[];
  capture: OutcomeState;
  heldSecrets: (string | undefined)[];
  helpers: Helpers;
  /** Contract mode (v0.7.0): parsed outcome contracts for this execute; null keeps legacy behavior byte-identical. */
  contracts?: ContractModeContext | null;
  /** Contract mode: the per-step submit_outcome surface (KB-391); required when contracts are present. */
  surface?: StepSurface | null;
  /** Contract mode: invoked when the in-flight query must be aborted because a finalize is terminal. */
  onFinalize?: () => void;
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
    finalizeAborted: false,
    submittedPayload: null,
    finalizedViaTool: false,
    finalizeFailureIssues: [],
    finalizedDisplayReason: "",
  };
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

/** MCP tool-result content for a failed adapter tool call, so the agent sees it as a tool result, not a step failure. */
function adapterToolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Map a successful adapter tool call into MCP content: the callee's typed
 * outputs JSON-encoded as the text content, passed through structured as well
 * when the callee emitted any.
 */
function adapterToolSuccess(
  outcome: string,
  outputs: Record<string, unknown> | undefined
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(outputs ?? {}) }],
    ...(outputs !== undefined ? { structuredContent: outputs } : {}),
    metadata: { outcome },
  };
}

/**
 * Translate a typed adapter tool-call failure (CRI-179 SDK surface) into
 * agent-facing text. The error class/code must be distinguishable so the
 * agent can react appropriately: give up on `host_unsupported`, report and
 * continue on a denial, and correct the target on unknown-tool.
 */
function describeAdapterToolFailure(err: unknown): { text: string; code?: string } {
  if (err instanceof ToolCallDeniedError) {
    return {
      code: "deny",
      text: `Adapter tool call denied by host policy${err.reason ? `: ${err.reason}` : ""}. ` +
        "Report the denial in your answer and continue with your task.",
    };
  }
  if (err instanceof ToolCallError) {
    if (err.code === CALL_ERROR_HOST_UNSUPPORTED) {
      return {
        code: err.code,
        text: `Adapter tool call failed: host_unsupported (ToolCallError). ` +
          "This Criteria host does not support adapter tool calls, so give up on calling adapter tools.",
      };
    }
    if (err.code === CALL_ERROR_UNKNOWN_TOOL || err.code === CALL_ERROR_UNKNOWN_ADAPTER) {
      return {
        code: err.code,
        text: `Adapter tool call failed: ${err.code} (ToolCallError). ` +
          "The target does not match any exposed adapter tool; correct the target " +
          "(the adapter.<type>.<name>.tools[.<tool>] form) if possible.",
      };
    }
    return {
      code: err.code,
      text: `Adapter tool call failed: call_error "${err.code}" (ToolCallError).`,
    };
  }
  if (err instanceof ToolCallTimeoutError || err instanceof ToolCallStreamClosedError) {
    return { text: `Adapter tool call failed (${err.name}): ${err.message}` };
  }
  return {
    text: `Adapter tool call failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/**
 * Build the MCP server that exposes `submit_outcome`. The tool handler performs
 * allowed-outcome validation, duplicate detection, and updates the shared
 * OutcomeState. Validation errors are returned as MCP tool errors so the model
 * can retry within the same turn.
 *
 * Contract mode (v0.7.0): payload/comment validation runs against the parsed
 * outcome contracts, rejections emit `outcome.payload_invalid` and consume the
 * finalize budget, a valid payload becomes terminal (aborting the in-flight
 * query), and budget exhaustion takes the contract's fallback outcome. Static
 * argument schemas stay strategically permissive on payload/comment so every
 * contract rejection happens in this handler — that is where the events and
 * the budget live; an over-strict static schema would bypass both.
 */
export function buildOutcomeMcpServer(options: BuildOutcomeServerOptions) {
  if (options.contracts) {
    return buildContractOutcomeMcpServer(options);
  }
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
          capture.finalizedViaTool = true;
          capture.finalizeFailureKind = "";

          await helpers.log.adapterEvent("outcome.finalized", {
            outcome,
            reason: sanitizeReason(reason, heldSecrets),
          });

          return submitOutcomeSuccess(outcome, reason, heldSecrets);
        },
      },
      {
        name: ADAPTER_TOOL_TOOL_NAME,
        description: ADAPTER_TOOL_DESCRIPTION,
        inputSchema: {
          target: z.string().describe("Full adapter.<type>.<name>.tools[.<tool>] target"),
          args: z.record(z.string(), z.any()).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        handler: async (args: any) => {
          const target = (args?.target ?? "").trim() as string;
          const callArgs = args?.args as Record<string, unknown> | undefined;

          if (!target) {
            return adapterToolError(
              "adapter_tool requires a target in the adapter.<type>.<name>.tools[.<tool>] form."
            );
          }

          // ADR-0004 permission ordering: this call's permission.request IS the
          // gated event — the host evaluates policy plus the callee adapter's
          // own allow_tools against it. It is deliberately NOT routed through
          // helpers.permission.request, which would double-gate the same call.
          try {
            // No timeoutMs override: the SDK helper bounds the call by its
            // own DefaultToolCallTimeout.
            const result = await helpers.tools.callAdapterTool({
              target,
              args: callArgs,
            });

            await helpers.log.adapterEvent("adapter_tool.call", {
              target,
              status: "ok",
            });
            return adapterToolSuccess(result.outcome, result.outputs);
          } catch (err) {
            const failure = describeAdapterToolFailure(err);
            await helpers.log.adapterEvent("adapter_tool.call", {
              target,
              status: err instanceof ToolCallDeniedError ? "denied" : "error",
              ...(failure.code ? { code: failure.code } : {}),
            });
            return adapterToolError(failure.text);
          }
        },
      },
    ],
  });
}

/**
 * Contract-mode submit_outcome tool (KB-391 per-step surface parity): the
 * model sees this step's delivered outcome contracts as schema metadata —
 * the allowed-outcome enum plus per-outcome payload branches and
 * conditional-reason/comment descriptions — and every contract rejection is
 * evaluated inside the handler, where it emits `outcome.payload_invalid`
 * and consumes the finalize budget. A surface-aware strict decode rejects
 * undeclared parameters typed (invalid_outcome / invalid_params) before any
 * budget-costing evaluation.
 */
function buildContractOutcomeMcpServer(options: BuildOutcomeServerOptions) {
  const { allowedOutcomes, capture, heldSecrets, helpers, contracts, onFinalize, surface } = options;
  if (!contracts) {
    throw new Error("contract mode requires parsed contracts");
  }
  if (!surface) {
    throw new Error("contract mode requires a step surface");
  }

  const allowedList = sortedAllowedOutcomes(allowedOutcomes);

  // Classify evaluator issues into the typed KB-391 rejection kinds. The
  // empty-outcome evaluator issue maps to invalid_outcome (an undeclared
  // verdict), missing_comment to its own kind, and payload-schema issues to
  // invalid_payload — matching the copilot adapter's typed classification.
  function contractRejectionKind(issues: string[]): FinalizeFailureKind {
    let commentOnly = true;
    let payloadIssue = false;
    for (const issue of issues) {
      if (issue.startsWith("missing_comment: ")) {
        continue;
      }
      commentOnly = false;
      if (issue.startsWith("payload_schema: ")) {
        payloadIssue = true;
      }
    }
    if (commentOnly) {
      return "comment_missing";
    }
    if (payloadIssue) {
      return "invalid_payload";
    }
    return "invalid_outcome";
  }

  function isNotAllowedOnly(issues: string[], candidateOutcome: string): boolean {
    return issues.length === 1 && issues[0] === outcomeNotAllowedIssue(candidateOutcome);
  }

  return createSdkMcpServer({
    name: "criteria-workflow",
    alwaysLoad: true,
    tools: [
      {
        name: SUBMIT_OUTCOME_TOOL_NAME,
        description: surface.description,
        inputSchema: surface.zodShape,
        annotations: { readOnlyHint: false, destructiveHint: false },
        handler: async (args: any) => {
          // Surface-aware strict decode (KB-391): unknown or malformed
          // arguments are rejected typed before any budget-costing
          // evaluation. The rejected call still consumes one finalize
          // attempt, mirroring the copilot handler's budget ordering.
          let decoded: Record<string, unknown>;
          try {
            decoded = decodeSubmitOutcomeArgs(args, surface);
          } catch (err) {
            capture.finalizeAttempts++;
            const kind: FinalizeFailureKind = err instanceof SubmitArgsDecodeError ? err.kind : "invalid_outcome";
            capture.finalizeFailureKind = kind;
            return submitOutcomeError(err instanceof Error ? err.message : String(err));
          }

          const outcome = (typeof decoded.outcome === "string" ? decoded.outcome : "").trim();
          const comment = (typeof decoded.comment === "string" ? decoded.comment : "").trim();
          const rawReason = typeof decoded.reason === "string" ? decoded.reason.trim() : "";
          const payload = decoded.payload;

          // Duplicate finalize: checked before the budget so duplicates never
          // consume an attempt.
          if (capture.finalized) {
            capture.finalizeFailureKind = "duplicate";
            return submitOutcomeError(
              `Outcome already finalized as "${capture.finalizedOutcome}" in this turn; do not call submit_outcome again.`
            );
          }

          // Every evaluated submission burns budget exactly once.
          capture.finalizeAttempts++;

          const outcomeContract = contracts.byName.get(outcome) ?? null;
          // KB-263/388: fold a top-level reason/comment into the payload when
          // the chosen contract schema requires those members and the payload
          // itself lacks them, in the contract's required order.
          const folded = foldDeclaredPayloadParams(rawReason, comment, payload, outcomeContract);

          // KB-263 wrong lane: a schema-carrying typed outcome does not
          // consume a top-level reason parameter at all. A reason that the
          // fold did not absorb is a wrong-lane submission, rejected typed.
          if (rawReason !== "" && !folded.reasonFolded && outcomeContract && contractSchemaCarrying(outcomeContract)) {
            capture.finalizeFailureKind = "invalid_params";
            return submitOutcomeError(TYPED_REASON_NOT_CONSUMED_MESSAGE);
          }

          const issues = evaluateContractSubmission(contracts, allowedOutcomes, {
            outcome,
            comment,
            payload: folded.payload,
          });

          if (issues.length > 0) {
            await helpers.log.adapterEvent("outcome.payload_invalid", {
              outcome: outcome || null,
              issues,
            });

            if (capture.finalizeAttempts >= MAX_FINALIZE_ATTEMPTS) {
              if (contracts.fallback) {
                const fallback = contracts.fallback;
                capture.finalized = true;
                capture.finalizedOutcome = fallback.name;
                capture.finalizedReason = formatFallbackFinalizeReason(
                  capture.finalizeAttempts,
                  issues
                );
                capture.finalizedViaTool = false;
                capture.finalizeFailureKind = "";
                await helpers.log.adapterEvent("outcome.finalized", {
                  outcome: fallback.name,
                  reason: sanitizeReason(capture.finalizedReason, heldSecrets),
                });
                onFinalize?.();
                return submitOutcomeSuccess(fallback.name, capture.finalizedReason, heldSecrets);
              }
              capture.finalizeFailureKind = contractRejectionKind(issues);
              capture.finalizeFailureIssues = issues;
              onFinalize?.();
              return submitOutcomeError(
                `Payload validation failed ${capture.finalizeAttempts} times; the budget for this step is exhausted. Stop calling submit_outcome. ` +
                  issues.join(" ")
              );
            }

            // Typed rejection wording (KB-391): an undeclared verdict gets
            // the not-allowed chooser listing this step's allowed outcomes;
            // the remaining lanes keep the evaluator's structured issues as
            // the model-facing message.
            if (isNotAllowedOnly(issues, outcome)) {
              capture.finalizeFailureKind = "invalid_outcome";
              return submitOutcomeError(
                `Outcome "${outcome}" is not in the allowed set; choose one of: ${allowedList.join(", ")}`
              );
            }
            capture.finalizeFailureKind = contractRejectionKind(issues);
            return submitOutcomeError(issues.join("\n"));
          }

          capture.finalized = true;
          capture.finalizedOutcome = outcome;
          capture.finalizedReason = comment;
          capture.submittedPayload = normalizedFinalizePayload(folded.payload);
          capture.finalizedViaTool = true;
          capture.finalizeFailureKind = "";
          // Event display reason (KB-263): typed outcomes render the payload's
          // operative prose (or a payload digest); schema-less contracts keep
          // the reason-or-comment render.
          capture.finalizedDisplayReason = resolveFinalizedDisplayReason(
            outcomeContract,
            rawReason || comment,
            capture.submittedPayload,
            heldSecrets
          );

          await helpers.log.adapterEvent("outcome.finalized", {
            outcome,
            reason: sanitizeReason(capture.finalizedDisplayReason, heldSecrets),
          });
          // Terminal for the turn: stop the in-flight query now instead of
          // letting it run to completion.
          onFinalize?.();

          return submitOutcomeSuccess(outcome, comment, heldSecrets);
        },
      },
      {
        name: ADAPTER_TOOL_TOOL_NAME,
        description: ADAPTER_TOOL_DESCRIPTION,
        inputSchema: {
          target: z.string().describe("Full adapter.<type>.<name>.tools[.<tool>] target"),
          args: z.record(z.string(), z.any()).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        handler: async (args: any) => {
          const target = (args?.target ?? "").trim() as string;
          const callArgs = args?.args as Record<string, unknown> | undefined;

          if (!target) {
            return adapterToolError(
              "adapter_tool requires a target in the adapter.<type>.<name>.tools[.<tool>] form."
            );
          }
          try {
            const result = await helpers.tools.callAdapterTool({
              target,
              args: callArgs,
            });
            await helpers.log.adapterEvent("adapter_tool.call", {
              target,
              status: "ok",
            });
            return adapterToolSuccess(result.outcome, result.outputs);
          } catch (err) {
            const failure = describeAdapterToolFailure(err);
            await helpers.log.adapterEvent("adapter_tool.call", {
              target,
              status: err instanceof ToolCallDeniedError ? "denied" : "error",
              ...(failure.code ? { code: failure.code } : {}),
            });
            return adapterToolError(failure.text);
          }
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
  /** Contract mode (v0.7.0): parsed contracts; enables fallback finalization. */
  contracts?: ContractModeContext | null;
}

/** Terminal finalize resolution, including the contract-mode wire extras. */
export type ResolvedOutcome = FinalizeResolution;

/**
 * Resolve the terminal outcome from the capture state and emit the
 * appropriate diagnostic event. This is the single place that decides between:
 *   - a valid submitted outcome
 *   - a timeout outcome
 *   - an error outcome (query failed)
 *   - a fallback outcome after exhausting reprompt attempts
 */
export async function resolveOutcome(options: ResolveOutcomeOptions): Promise<ResolvedOutcome> {
  const { state, allowedOutcomes, attempts, helpers, heldSecrets, contracts } = options;

  // 1. Valid submitted outcome: already emitted outcome.finalized by the tool.
  if (state.finalized && state.finalizedOutcome) {
    // KB-263: the event/verdict reason lane renders the operative prose —
    // the typed payload's display reason when the handler resolved one,
    // else the finalize reason (unchanged for legacy lanes and fallbacks).
    const display = state.finalizedDisplayReason !== "" ? state.finalizedDisplayReason : state.finalizedReason;
    const reason = sanitizeReason(display, heldSecrets);
    const resolution: ResolvedOutcome = {
      outcome: state.finalizedOutcome,
      reason,
    };
    if (contracts && state.finalizedViaTool) {
      // Contract-mode wire parity (contractResultEvent): the schema-validated
      // payload is forwarded verbatim and the comment rides the comment lane.
      // The comment lane stays the wire comment (sanitize once, here).
      resolution.comment = sanitizeReason(state.finalizedReason, heldSecrets);
      resolution.payload = state.submittedPayload ?? {};
    }
    return resolution;
  }

  // 1b. Contract mode: the model never produced a usable submission, but the
  // step's contracts declare a fallback outcome. Keep timeout/error semantics
  // below intact; this branch only runs for a cleanly-ended turn.
  if (contracts && contracts.fallback && !state.timedOut && !state.error) {
    const fallback = contracts.fallback;
    const reason = formatNeverFinalizedFallbackReason(attempts);
    await helpers.log.adapterEvent("outcome.finalized", {
      outcome: fallback.name,
      reason: sanitizeReason(reason, heldSecrets),
    });
    return { outcome: fallback.name, reason };
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
    invalid_params: "invalid parameters",
    comment_missing: "comment missing",
    // "payload validation failed" is the pinned exhaustion diagnosis for a
    // typed payload-schema rejection (test C); the label spells the same
    // finding the evaluator reported.
    invalid_payload: "payload validation failed",
    duplicate: "duplicate finalize",
    no_outcomes: "step has no declared outcomes",
    payload_validation_failed: "payload validation failed",
  };
  const reasonLabel = reasonLabels[kind] || "missing finalize";
  const allowedList = sortedAllowedOutcomes(allowedOutcomes);
  const baseReason = `Agent completed without submitting a valid outcome after ${attempts} finalize attempt(s) (${reasonLabel}).`;
  // Contract mode carries the last validation issues so the outcome reason is
  // actionable; legacy reasons stay byte-identical.
  const reasonText =
    (kind === "payload_validation_failed" || kind === "invalid_payload") &&
    state.finalizeFailureIssues.length > 0
      ? `${baseReason} Last validation issues: ${truncateText(
          state.finalizeFailureIssues.join("; "),
          400
        )}`
      : baseReason;
  const reason = sanitizeReason(reasonText, heldSecrets);

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
