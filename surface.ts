/**
 * Per-step submit_outcome surface (KB-391 parity with the copilot adapter).
 *
 * One step's `submit_outcome` presentation is derived from the step's allowed
 * outcomes and DELIVERED outcome contracts — the allowed-outcome enum plus
 * per-outcome descriptions ride the tool the model sees that step, instead of
 * only prompt prose. The digest keys the currently bound surface so
 * consecutive same-shape steps cost no re-bind.
 *
 * Surface-aware strict decode rejects calls carrying keys outside the
 * step's declared set (typed `invalid_params`), so undeclared parameters
 * can never silently evaporate findings text.
 *
 * This mirrors the copilot adapter's copilot_surface.go (KB-391 close-out)
 * with deliberate TS-transport mappings documented at each deviation:
 *  - the tool schema the MODEL sees (params) is the canonical artifact and is
 *    built byte-parity with the copilot surface;
 *  - the zod inputSchema handed to the agent SDK stays validation-permissive
 *    on payload members (KB-46 ruling: an over-strict static schema would
 *    bypass the handler where the events and the finalize budget live), and
 *    the SDK transport layer pre-emptively rejects undeclared keys and
 *    verdicts before the handler runs;
 *  - the handler-side strict decode remains the authoritative lane on the
 *    direct-call surface (mock harnesses call tool handlers directly).
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { contractSchemaCarrying, OutcomeContractView } from "./contract.js";

/** Version prefix so a changed mapping policy re-binds every step surface. */
export const SUBMIT_SURFACE_DIGEST_PREFIX = "submit-surface-v1";

/** The max contract count shown in payload branches is unbounded here; each
 * distinct schema becomes one branch. Kept contracts bound the count. */

/**
 * One step's submit_outcome presentation: the JSON Schema the model sees
 * (canonical artifact), the tool description that teaches it, the declared
 * parameter set the strict decode allowlists for this step, and the zod raw
 * shape for the agent-SDK tool inputSchema.
 */
export interface StepSurface {
  digest: string;
  description: string;
  /** JSON Schema document (properties/required/additionalProperties:false). */
  params: Record<string, unknown>;
  /** Sorted declared parameter keys — the strict decode accept list. */
  declared: string[];
  /** Zod raw shape for the SDK tool inputSchema (permissive; see module doc). */
  zodShape: Record<string, z.ZodTypeAny>;
}

/**
 * A typed decode failure of the submit_outcome invocation envelope.
 * kind selects the finalize-failure classification: "invalid_params" for a
 * declared-contract violation the model repairs by retrying with the declared
 * names, "invalid_outcome" for a structurally undecodable envelope.
 */
export type SubmitArgsRejectionKind = "invalid_outcome" | "invalid_params";

export class SubmitArgsDecodeError extends Error {
  constructor(
    public readonly kind: SubmitArgsRejectionKind,
    message: string
  ) {
    super(message);
  }
}

/** Renders list items as quoted, comma-separated text for rejection messages. */
export function quoteJoin(items: string[]): string {
  return items.map((item) => JSON.stringify(item)).join(", ");
}

export function surfaceDigestOf(surface: StepSurface | null): string {
  return surface ? surface.digest : "";
}

/**
 * Derive the step's submit_outcome surface from the step's allowed outcomes
 * and outcome contracts. A null return is the static surface: contract-less
 * steps stay on the legacy lane byte-identically.
 *
 * Mapping policy (adapter-internal, mirroring copilot_surface.go):
 *  - outcome enum: the sorted union of the allowed set and the contract names.
 *  - schema-carrying contracts (even unparseable schema_json): the payload
 *    member embeds the contract schema and there is NO top-level reason
 *    member — the payload IS the output.
 *  - a non-empty but unparseable schema counts as schema-carrying and
 *    contributes no payload branch; the malformed schema is flagged at
 *    finalize time by the pinned contract gate.
 *  - schemaless contracts (no schema_json) keep the top-level reason member.
 *  - comment becomes a required member only when every contract sets
 *    require_comment; mixed steps keep it optional and the enum description
 *    names the outcomes that require it.
 */
export function buildStepSurface(
  allowed: string[],
  contracts: OutcomeContractView[]
): StepSurface | null {
  const names = new Set<string>();
  for (const raw of allowed) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name !== "") {
      names.add(name);
    }
  }
  const kept: OutcomeContractView[] = [];
  for (const contract of contracts) {
    if (!contract || contract.name.trim() === "") {
      continue;
    }
    names.add(contract.name);
    kept.push(contract);
  }
  if (kept.length === 0) {
    return null;
  }

  const enumValues = [...names].sort();

  let hasSchemalessContract = false;
  let hasSchemaCarryingContract = false;
  for (const contract of kept) {
    if (contractSchemaCarrying(contract)) {
      hasSchemaCarryingContract = true;
    } else {
      hasSchemalessContract = true;
    }
  }
  const branches = distinctPayloadSchemas(kept);

  const requiresComment: string[] = [];
  let allRequireComment = kept.length > 0;
  for (const contract of kept) {
    if (contract.requireComment) {
      requiresComment.push(contract.name);
    } else {
      allRequireComment = false;
    }
  }
  requiresComment.sort();

  const properties: Record<string, unknown> = {
    outcome: {
      type: "string",
      description: outcomeEnumDescription(requiresComment),
      enum: enumValues,
    },
    comment: {
      type: "string",
      description: commentParamDescription(allRequireComment, requiresComment),
    },
    payload: payloadParamDescription(branches),
  };
  if (hasSchemalessContract) {
    properties.reason = {
      type: "string",
      description: reasonParamDescription(hasSchemaCarryingContract),
    };
  }

  const required = ["outcome"];
  if (allRequireComment) {
    required.push("comment");
  }

  const declared = Object.keys(properties).sort();

  const description = stepSurfaceToolDescription(hasSchemaCarryingContract, hasSchemalessContract);
  const params = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };

  return {
    digest: surfaceDigest(description, params),
    description,
    params,
    declared,
    zodShape: stepSurfaceZodShape(properties, branches),
  };
}

/**
 * One payload-schema branch: the canonicalized schema document plus the
 * outcomes whose contracts declare it.
 */
interface SurfaceSchemaBranch {
  schema: Record<string, unknown>;
  outcomes: string[];
}

/**
 * Collect the distinct payload schema documents among the step's contracts,
 * canonicalized (key-order normalized) so byte layouts of one schema collapse
 * into one branch. Branch order is by first governing outcome (then the
 * outcomes within a branch sort). Unparseable schemas are skipped here.
 */
function distinctPayloadSchemas(contracts: OutcomeContractView[]): SurfaceSchemaBranch[] {
  const branches: SurfaceSchemaBranch[] = [];
  const seen = new Map<string, number>();

  for (const contract of contracts) {
    if (!contractSchemaCarrying(contract) || contract.schemaText === null) {
      continue;
    }
    let doc: Record<string, unknown>;
    try {
      const parsed = JSON.parse(contract.schemaText);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      doc = parsed;
    } catch {
      continue;
    }
    const canonical = canonicalJson(doc);
    const idx = seen.get(canonical);
    if (idx !== undefined) {
      branches[idx].outcomes.push(contract.name);
      continue;
    }
    seen.set(canonical, branches.length);
    branches.push({ schema: doc, outcomes: [contract.name] });
  }

  branches.sort((a, b) => (a.outcomes[0] < b.outcomes[0] ? -1 : a.outcomes[0] > b.outcomes[0] ? 1 : 0));
  for (const branch of branches) {
    branch.outcomes.sort();
  }
  return branches;
}

/** Description for the outcome member (comment requirements named up-front). */
function outcomeEnumDescription(requiresComment: string[]): string {
  let text =
    "Required. The step's final outcome; must be one of the outcomes declared in this step's submission schema, which mirror the step's allowed outcomes.";
  if (requiresComment.length > 0) {
    text += ` Finalizing with outcome ${quoteJoin(requiresComment)} requires a non-empty comment (require_comment).`;
  }
  return text;
}

/** Description for the comment member (required vs. per-outcome rule). */
function commentParamDescription(required: boolean, requiresComment: string[]): string {
  if (required) {
    return "Required. The step's finalize comment (require_comment): every outcome of this step requires a non-empty comment, which is forwarded to the workflow with the result.";
  }
  let text = "Optional finalize comment, forwarded to the workflow with the result.";
  if (requiresComment.length > 0) {
    text += ` Required (non-empty) when finalizing with outcome ${quoteJoin(requiresComment)}.`;
  }
  return text;
}

/** Description for the top-level reason member on schemaless-contract steps. */
function reasonParamDescription(mixed: boolean): string {
  if (mixed) {
    return "Optional prose; only the step's schemaless outcomes consume it (display-only for operators, shown on the outcome.finalized event of those outcomes). Finalizing with one of this step's typed outcomes instead: the payload IS the output — put the findings under the payload's declared fields; a top-level reason is folded in only when the contract's schema declares a reason field, and is rejected otherwise.";
  }
  return "Optional display prose: it is shown to operators on the outcome.finalized event but is NOT part of the step's forwarded output. Durable findings text belongs under comment — or, when the chosen outcome declares a payload schema, under the payload's declared fields.";
}

/** Builds the payload member: uniform collapse vs. diverging anyOf vs. generic. */
function payloadParamDescription(branches: SurfaceSchemaBranch[]): Record<string, unknown> {
  if (branches.length === 0) {
    return {
      type: "object",
      description: "Optional JSON object payload, forwarded to the workflow verbatim.",
    };
  }
  if (branches.length === 1) {
    const prop = { ...branches[0].schema };
    prop.description = payloadSchemaDescription(branches[0].outcomes);
    return prop;
  }
  const members = branches.map((branch) => {
    const member = { ...branch.schema };
    member.description = payloadBranchDescription(branch.outcomes);
    return member;
  });
  return {
    type: "object",
    description:
      "Required when the chosen outcome declares it (see the branches): the payload IS the step's output — the findings belong under the payload's declared fields, which are forwarded to the workflow verbatim.",
    anyOf: members,
  };
}

/** Description for the uniform typed payload member. */
function payloadSchemaDescription(outcomes: string[]): string {
  return `Required when finalizing with outcome ${quoteJoin(outcomes)}: the payload IS the step's output — the declared schema's fields are the submission surface; the payload must satisfy this schema and is forwarded to the workflow verbatim. Put the step's findings under these declared fields.`;
}

/** Description for one diverging-schema payload branch. */
function payloadBranchDescription(outcomes: string[]): string {
  return `Use only when finalizing with outcome ${quoteJoin(outcomes)}: the payload IS the step's output — the declared schema's fields are the submission surface, forwarded to the workflow verbatim. Put the step's findings under these declared fields.`;
}

/** Step tool description: teaches the step-declared submission lanes. */
function stepSurfaceToolDescription(typed: boolean, reasonDeclared: boolean): string {
  let text =
    "Finalize the outcome for the current step. Call this exactly once with one of the outcomes in the schema's `outcome` enum below: this step's submission schema is re-declared from the step's finalization contracts, so it declares the required shape — the outcome choice, the `payload` schema per outcome (when any contract declares one, the payload IS the step's output and the findings belong under its declared fields), and the `comment` requirement per outcome. Submit exactly the declared shape; parameters outside this step's declared set are rejected, and failure to call this tool with a valid finalize for the step will fail it.";
  if (reasonDeclared) {
    if (typed) {
      text +=
        " On this step `reason` prose belongs only to the schemaless outcomes (shown on their outcome.finalized event); for the typed outcomes the payload is the output and the findings belong under the payload's declared fields.";
    } else {
      text +=
        " On this step the durable findings surface is `comment` (and the payload when an outcome declares a payload schema); `reason` is display-only prose for operators.";
    }
  }
  return text;
}

/**
 * Digest fingerprints one surface's presentation (description + params) from
 * canonical JSON: equal inputs yield an equal digest, so consecutive
 * same-shape steps cost no re-bind.
 */
function surfaceDigest(description: string, params: Record<string, unknown>): string {
  const sum = createHash("sha256");
  sum.update(`${SUBMIT_SURFACE_DIGEST_PREFIX}\n${description}\n${canonicalJson(params)}`);
  return sum.digest("hex");
}

/**
 * Canonical JSON: object keys sorted (byte layouts collapse), arrays in
 * order. Matches the Go reference's json.Marshal map-key sorting closely
 * enough that the digest is stable for a given surface within this adapter.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${parts.join(",")}}`;
}

/**
 * The zod raw shape for the SDK tool inputSchema. Validation-permissive on
 * the payload lane (KB-46 ruling: rejections must happen in the handler,
 * where the events and the finalize budget live); the enum lane is strict so
 * the transport layer pre-emptively rejects undeclared verdicts.
 */
function stepSurfaceZodShape(
  properties: Record<string, unknown>,
  branches: SurfaceSchemaBranch[]
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {
    outcome: z
      .enum([...((properties.outcome as Record<string, unknown>).enum as string[])] as [string, ...string[]])
      .describe((properties.outcome as Record<string, unknown>).description as string),
    comment: z
      .string()
      .optional()
      .describe((properties.comment as Record<string, unknown>).description as string),
  };
  const payloadDoc = properties.payload as Record<string, unknown>;
  const payloadDescription = payloadDoc.description as string;
  if (branches.length === 0) {
    shape.payload = z.record(z.string(), z.unknown()).optional().describe(payloadDescription);
  } else if (branches.length === 1) {
    shape.payload = looseObjectFromSchema(branches[0].schema).optional().describe(payloadDescription);
  } else {
    shape.payload = z
      .union(branches.map((branch) => looseObjectFromSchema(branch.schema)))
      .optional()
      .describe(payloadDescription);
  }
  const reasonDoc = properties.reason as Record<string, unknown> | undefined;
  if (reasonDoc) {
    shape.reason = z.string().optional().describe(reasonDoc.description as string);
  }
  return shape;
}

/**
 * A permissive per-branch payload shape: the schema's declared property names
 * stay visible as unknown-typed optional fields, and unknown keys are
 * preserved (loose object). Field types are not enforced — the handler's
 * pinned evaluator is the enforcement point.
 */
function looseObjectFromSchema(schema: Record<string, unknown>): z.ZodTypeAny {
  const fields: Record<string, z.ZodTypeAny> = {};
  const props = schema.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    for (const key of Object.keys(props)) {
      fields[key] = z.unknown();
    }
  }
  return z.looseObject(fields);
}

/**
 * The declared parameter set in force for a surface. A null surface (the
 * legacy static lane) declares the legacy four-parameter set; a step surface
 * declares exactly its schema's keys.
 */
export function declaredSubmitParamsFor(surface: StepSurface | null): string[] {
  if (surface === null) {
    return ["comment", "outcome", "payload", "reason"];
  }
  return surface.declared;
}

/**
 * Surface-aware strict decode of the submit_outcome arguments (KB-216/391):
 * keys outside the declared set are rejected BEFORE any handler validation —
 * unknown-key tolerance would silently drop values, the exact class the
 * rejection exists to prevent. A non-object envelope is a typed
 * invalid_outcome rejection. A null envelope decodes to zero args.
 */
export function decodeSubmitOutcomeArgs(
  args: unknown,
  surface: StepSurface | null
): Record<string, unknown> {
  if (args === undefined || args === null) {
    return {};
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new SubmitArgsDecodeError(
      "invalid_outcome",
      "submit_outcome arguments must be a JSON object with the declared fields"
    );
  }
  const envelope = args as Record<string, unknown>;
  if (Object.keys(envelope).length === 0) {
    return {};
  }
  const declared = declaredSubmitParamsFor(surface);
  const declaredSet = new Set(declared);
  const unexpected = Object.keys(envelope)
    .filter((key) => !declaredSet.has(key))
    .sort();
  if (unexpected.length > 0) {
    // Retry guidance is surface-aware: on a lane whose surface still declares
    // reason the findings text belongs in reason; on a typed step the payload
    // schema's declared members are the submission surface.
    const guidance =
      surface !== null && !declared.includes("reason")
        ? "the payload is this step's output: findings and structured results belong under the declared payload schema members, and no top-level reason parameter exists."
        : 'the step\'s findings text belongs in the required "reason" parameter.';
    throw new SubmitArgsDecodeError(
      "invalid_params",
      `submit_outcome rejected: unknown parameter(s) ${quoteJoin(unexpected)}; the declared parameters are ${quoteJoin(
        declared
      )}. Retry with the declared names — ${guidance}`
    );
  }
  return envelope;
}

// ============================================================================
// Re-bind guard (KB-396 parity)
// ============================================================================

export interface EnsureStepSurfaceInput {
  /** The surface this execute's delivered contracts demand; null = static. */
  want: StepSurface | null;
  /** Digest of the surface bound by the previous execute; "" = static. */
  boundDigest: string;
  /** The live resume-chain conversation id (null on a fresh conversation). */
  persistedResumeId: string | null;
  /** CRI-306: whether this execute takes over the shared resume chain. */
  sharesResumeChain: boolean;
}

export interface EnsureStepSurfaceResult {
  /** The surface to serve this execute. */
  surface: StepSurface | null;
  /**
   * THE GUARD (KB-396): the id to resume. A surface re-bind must never break
   * the live resume chain — the re-opened conversation is the resumed
   * persisted session id, never a fresh one, exactly as the copilot adapter
   * skips Disconnect on the superseded same-id wrapper. A null here is
   * legitimate only when this execute legitimately starts a fresh
   * conversation (no chain, or a CRI-306 sibling takeover).
   */
  resumeId: string | null;
  /** True when the bound surface digest changed (or static → step/steps → static). */
  rebind: boolean;
  /** Digest to persist onto the session for the next execute. */
  boundDigest: string;
}

/**
 * Decide the surface binding for one execute: serve the arriving contracts'
 * surface, keep the digest bookkeeping, and preserve the live resume chain
 * across surface-changing re-binds.
 */
export function ensureStepSurface(input: EnsureStepSurfaceInput): EnsureStepSurfaceResult {
  const wantDigest = surfaceDigestOf(input.want);
  const rebind = input.boundDigest !== wantDigest;
  return {
    surface: input.want,
    resumeId: input.sharesResumeChain ? input.persistedResumeId : null,
    rebind,
    boundDigest: wantDigest,
  };
}
