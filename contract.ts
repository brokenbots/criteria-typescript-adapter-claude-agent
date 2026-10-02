/**
 * Outcome-contract machinery for the claude-agent adapter (v0.7.0, KB-46).
 *
 * This module mirrors the pinned contract-validation pieces of
 * `criteriav2.EvaluateOutcomeContracts` (criteria-adapter-proto v0.7.0,
 * conformance/README.md + outcome_contract.go) so the adapter's in-session
 * submit_outcome enforcement, event payloads, and repair prompts use the same
 * byte-identical issue vocabulary as the host and the other SDKs:
 *
 * - defensive extraction of ExecuteRequest.outcome_contracts / .rejection
 *   (camelCase and snake_case, schema_json as bytes or text) so the adapter
 *   lights up the moment the TS SDK forwards the v0.7.0 fields;
 * - one-time per-execute schema_json parsing, cached by contract identity;
 * - the pinned payload-schema subset walker producing the exact issue strings;
 * - ordered gate evaluation (outcome gates → missing_comment → payload);
 * - prompt builders for the host-rejection repair mode and contract guidance;
 * - the finalizeopts seam the adapter hands to the SDK's outcomes.finalize
 *   (payload verbatim + comment; see the SDK-card note below).
 *
 * Scope note (KB-46 known-gap): the TS SDK (0.5.x) does not yet decode the
 * v0.7.0 fields or forward them to the adapter, and its outcomes.finalize
 * writes outputs_json as {"reason"} only. The SDK half (descriptor regen +
 * pass-through + finalize opts) tracks as its own card; this module keeps the
 * adapter side complete and wire-shaped so no adapter change is required when
 * the SDK lands.
 */

// ============================================================================
// Pinned issue-string vocabulary (conformance/README.md, v0.7.0)
// ============================================================================

/** The MCP tool the model calls to finalize a step. */
export const SUBMIT_OUTCOME_TOOL_NAME = "submit_outcome";

export const ISSUE_NO_RESULT = "no_result: step ended without a finalized result";
export const ISSUE_EMPTY_OUTCOME = "empty_outcome: result has no outcome";
export const ISSUE_OUTPUTS_NOT_OBJECT = "payload_schema: outputs_json does not decode to a JSON object";
export const ISSUE_BAD_SCHEMA = "payload_schema: contract schema_json is not a valid schema";

export function outcomeNotAllowedIssue(name: string): string {
  return `outcome_not_allowed: outcome "${name}" is not in allowed_outcomes`;
}

export function outcomeUncontractedIssue(name: string): string {
  return `outcome_uncontracted: outcome "${name}" has no outcome_contracts entry`;
}

export function missingCommentIssue(name: string): string {
  return `missing_comment: outcome "${name}" requires a comment (require_comment)`;
}

export function propertyMissingIssue(prop: string): string {
  return `payload_schema: property "${prop}": required property is missing`;
}

export function propertyTypeIssue(prop: string, want: string, got: string): string {
  return `payload_schema: property "${prop}": expected "${want}", got "${got}"`;
}

// ============================================================================
// Wire extraction and parsing
// ============================================================================

/**
 * A parsed pinned-subset schema: the required-name list in declared order and
 * the declared property types (absent/empty = presence-only).
 */
export interface PayloadContractSchema {
  required: string[];
  properties: Record<string, string>;
}

/** One outcome contract, normalized and parsed once per Execute. */
export interface OutcomeContractView {
  name: string;
  fallback: boolean;
  requireComment: boolean;
  /** Decoded schema text; null when the contract carries no schema payloads. */
  schemaText: string | null;
  /** Pinned-subset parse result; null when unparsed (no schema or invalid). */
  parsed: PayloadContractSchema | null;
  /** True when the contract carries a schema that is not valid pinned-subset JSON. */
  schemaInvalid: boolean;
}

/**
 * Per-Execute contract context. `contracts` keeps wire order (first-match
 * semantics for duplicate names); byName maps outcome → first governing
 * contract; fallback is the first fallback=true contract (null when none).
 */
export interface ContractModeContext {
  hasContracts: true;
  contracts: OutcomeContractView[];
  byName: Map<string, OutcomeContractView>;
  fallback: OutcomeContractView | null;
}

/** The host-rejection context an Execute (v0.7.0) may carry, normalized. */
export interface ExecutionRejectionView {
  outcome: string;
  issues: string;
  attempt: number;
}

/** Leaf types allowed by the pinned schema subset. */
const SCHEMA_LEAF_TYPES = ["string", "number", "boolean", "object", "array"];

function identityKey(rawSchema: unknown): string {
  let schemaPart: string;
  if (typeof rawSchema === "string") {
    schemaPart = rawSchema;
  } else if (rawSchema instanceof Uint8Array) {
    schemaPart = "b64:" + Buffer.from(rawSchema).toString("base64");
  } else {
    schemaPart = String(rawSchema);
  }
  // The subset schemas in the wild are small; hard-cap so pathological raw
  // values cannot bloat the key.
  return schemaPart.slice(0, 4096);
}

/**
 * Decode a schema_json raw value (bytes per the proto, or already-decoded
 * text) into schema text. Returns null when the contract carries no schema
 * payloads at all. Text is preferred verbatim; on a non-JSON UTF-8 string the
 * proto3-JSON base64 encoding of bytes is attempted second, per the vector
 * fixture encoding.
 */
export function decodeSchemaRaw(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (typeof raw === "string") {
    return raw;
  }
  // bytes fields never decode to other JSON types; anything else is invalid.
  return null;
}

/**
 * Parse schema text into the pinned subset. Mirrors the Go reference's struct
 * decode: a JSON `null` root parses to an empty (valid) schema; malformed
 * JSON, non-object roots, a root `type` other than "object", malformed
 * `required`/`properties` values, or a leaf type outside the pinned enum
 * return null (= `payload_schema: contract schema_json is not a valid schema`).
 */
export function parseOutcomeSchemaText(schemaText: string | null): PayloadContractSchema | null {
  if (schemaText === null) {
    return null;
  }
  const trimmed = schemaText.trim();
  if (trimmed === "") {
    // Whitespace-only schema bytes still ride the non-empty-schema gate and
    // therefore take the invalid-schema lane (mirrors the Go reference).
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (doc === null) {
    // Go mirror: json.Unmarshal("null", &struct) parses harmlessly to zero.
    return { required: [], properties: {} };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return null;
  }
  const root = doc as Record<string, unknown>;

  const typeValue = root.type;
  if (typeValue !== undefined && typeValue !== null) {
    if (typeof typeValue !== "string" || typeValue !== "object") {
      return null;
    }
  }

  let required: string[] = [];
  const requiredValue = root.required;
  if (requiredValue !== undefined && requiredValue !== null) {
    if (!Array.isArray(requiredValue) || !requiredValue.every((r) => typeof r === "string")) {
      return null;
    }
    required = requiredValue as string[];
  }

  const properties: Record<string, string> = {};
  const propertiesValue = root.properties;
  if (propertiesValue !== undefined && propertiesValue !== null) {
    if (typeof propertiesValue !== "object" || Array.isArray(propertiesValue)) {
      return null;
    }
    for (const [name, prop] of Object.entries(propertiesValue as Record<string, unknown>)) {
      if (prop === null) {
        // null → zero struct: type-less, presence-only.
        properties[name] = "";
        continue;
      }
      if (typeof prop !== "object" || Array.isArray(prop)) {
        return null;
      }
      const propObj = prop as Record<string, unknown>;
      // Unknown leaf keywords (pattern, maxLength, …) are ignored by design;
      // only `type` is understood, and only as a pinned leaf type.
      const entries = Object.entries(propObj);
      if (entries.some(([, v]) => v === undefined)) {
        return null;
      }
      const typeField = propObj.type;
      if (typeField === undefined || typeField === null) {
        properties[name] = "";
      } else if (typeof typeField === "string" && SCHEMA_LEAF_TYPES.includes(typeField)) {
        properties[name] = typeField;
      } else {
        return null;
      }
    }
  }

  return { required, properties };
}

/**
 * Build the per-Execute contract context from a raw ExecuteRequest. Parses
 * every schema_json exactly once, caching by (name, schema) identity so
 * duplicate contract entries share their parse. Returns null in legacy mode
 * (no outcome_contracts key or an empty/unusable list) so the adapter keeps
 * byte-identical pre-v0.7.0 behavior.
 */
export function buildContractModeContext(req: any): ContractModeContext | null {
  if (req === null || req === undefined) {
    return null;
  }
  const rawContracts =
    (req as Record<string, unknown>).outcomeContracts ??
    (req as Record<string, unknown>).outcome_contracts;
  if (!Array.isArray(rawContracts) || rawContracts.length === 0) {
    return null;
  }

  const cache = new Map<string, {
    schemaText: string | null;
    parsed: PayloadContractSchema | null;
    schemaInvalid: boolean;
  }>();
  const contracts: OutcomeContractView[] = [];
  const byName = new Map<string, OutcomeContractView>();
  let fallback: OutcomeContractView | null = null;

  for (const raw of rawContracts) {
    if (raw === null || raw === undefined || typeof raw !== "object") {
      continue;
    }
    const rawObj = raw as Record<string, unknown>;
    const name = rawObj.name;
    if (typeof name !== "string" || name === "") {
      continue;
    }

    const rawSchema = rawObj.schemaJson ?? rawObj.schema_json;
    const key = String(rawSchema === undefined || rawSchema === null ? "\u0000absent" : identityKey(rawSchema));
    let cached = cache.get(key);
    if (cached === undefined) {
      let schemaText: string | null = null;
      if (typeof rawSchema === "string") {
        schemaText = rawSchema;
      } else if (rawSchema instanceof Uint8Array) {
        schemaText = Buffer.from(rawSchema).toString("utf8");
      }
      // Anything non-empty that is neither text nor bytes (a decoder artifact)
      // is surfaced as a schema that does not parse rather than "no schema".
      const hasSchemaValue = rawSchema !== undefined && rawSchema !== null && rawSchema !== "";
      const parsed = parseOutcomeSchemaText(schemaText);
      cached = {
        schemaText,
        parsed,
        schemaInvalid: hasSchemaValue && (schemaText === null || parsed === null),
      };
      cache.set(key, cached);
    }

    const requireComment =
      rawObj.requireComment === true || rawObj.require_comment === true ||
      rawObj.requireComment === "true" || rawObj.require_comment === "true";
    const isFallback = rawObj.fallback === true || rawObj.fallback === "true";
    const view: OutcomeContractView = {
      name,
      fallback: isFallback,
      requireComment,
      schemaText: cached.schemaText,
      parsed: cached.parsed,
      schemaInvalid: cached.schemaInvalid,
    };
    contracts.push(view);
    if (!byName.has(name)) {
      byName.set(name, view);
    }
    if (view.fallback && fallback === null) {
      fallback = view;
    }
  }

  return { hasContracts: true, contracts, byName, fallback };
}

// Kept as a named export for direct unit testing of raw decode behavior.

/**
 * Read the ExecuteRequest's host-rejection context, defensively across
 * camelCase and snake_case decoders. Returns null for a normal (non-repair)
 * execute.
 */
export function extractExecutionRejection(req: any): ExecutionRejectionView | null {
  const raw = (req as Record<string, unknown> | undefined)?.rejection;
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const attempt = Number(obj.attempt);
  return {
    outcome: typeof obj.outcome === "string" ? obj.outcome : "",
    issues: typeof obj.issues === "string" ? obj.issues : "",
    attempt: Number.isFinite(attempt) ? attempt : 0,
  };
}

// ============================================================================
// Pinned validation (mirrors criteriav2.EvaluateOutcomeContracts)
// ============================================================================

/**
 * The JSON type vocabulary used by property type issues.
 */
export function jsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "number":
      return "number";
    case "object":
      return "object";
    default:
      return "invalid";
  }
}

/**
 * Validate one contract's payload. The three payload rules are exclusive
 * lanes, in this priority: (1) the payload must be (or decode to) a JSON
 * object — absent/null payloads are an empty object; (2) a contract that
 * carries a schema it does not parse as the pinned subset; (3) otherwise one
 * rule per `required` entry in declared order, presence before type per
 * property, a missing property reported only as missing.
 */
export function payloadSchemaIssues(view: OutcomeContractView, payload: unknown): string[] {
  // Lane 1: object decode.
  let payloadObject: Record<string, unknown>;
  if (payload === undefined || payload === null) {
    payloadObject = {}; // absent/null = empty object
  } else if (typeof payload === "object" && !Array.isArray(payload)) {
    payloadObject = payload as Record<string, unknown>;
  } else {
    return [ISSUE_OUTPUTS_NOT_OBJECT];
  }

  // Lane 2: schema validity (only when the contract carries a schema).
  if (view.schemaText === null) {
    if (view.schemaInvalid) return [ISSUE_BAD_SCHEMA];
    return [];
  }
  if (view.schemaInvalid || view.parsed === null) {
    return [ISSUE_BAD_SCHEMA];
  }

  // Lane 3: required-property rules in required-array order.
  const issues: string[] = [];
  for (const prop of view.parsed.required) {
    if (!Object.prototype.hasOwnProperty.call(payloadObject, prop)) {
      issues.push(propertyMissingIssue(prop));
      continue;
    }
    const want = view.parsed.properties[prop];
    if (!want) {
      continue; // presence-only property
    }
    const got = jsonTypeName(payloadObject[prop]);
    if (got !== want) {
      issues.push(propertyTypeIssue(prop, want, got));
    }
  }
  return issues;
}

export interface ContractSubmission {
  outcome: string;
  comment: string;
  payload: unknown;
}

/**
 * Evaluate a model-submitted finalize against the step's contracts, mirroring
 * the host's ordered gates: empty outcome → not-allowed (only when the
 * allowed list is non-empty) → uncontracted → missing_comment → payload
 * lanes. Empty issue list = accept.
 */
export function evaluateContractSubmission(
  ctx: ContractModeContext,
  allowedOutcomes: string[],
  submission: ContractSubmission
): string[] {
  const name = submission.outcome;
  if (name === "") {
    return [ISSUE_EMPTY_OUTCOME];
  }
  if (allowedOutcomes.length > 0 && !allowedOutcomes.includes(name)) {
    return [outcomeNotAllowedIssue(name)];
  }
  const contract = ctx.byName.get(name);
  if (!contract) {
    return [outcomeUncontractedIssue(name)];
  }
  const issues: string[] = [];
  if (contract.requireComment && submission.comment.trim() === "") {
    issues.push(missingCommentIssue(name));
  }
  if (contract.schemaText !== null || contract.schemaInvalid) {
    issues.push(...payloadSchemaIssues(contract, submission.payload));
  }
  return issues;
}

// ============================================================================
// Formatting helpers
// ============================================================================

/**
 * Truncate text and append a visible marker when anything was dropped.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + "…";
}

export const FALLBACK_REASON_ISSUES_MAX_CHARS = 400;
export const FALLBACK_REASON_MAX_CHARS = 600;

/**
 * The budget-exhaustion finalize reason mandated by the workstream spec:
 * "payload validation failed N times: <issues>". Long issue text is
 * truncated to keep the reason actionable as an outcome reason.
 */
export function formatFallbackFinalizeReason(
  attempts: number,
  issues: string[]
): string {
  const joined = truncateText(issues.join("; "), FALLBACK_REASON_ISSUES_MAX_CHARS);
  const text = `payload validation failed ${attempts} times: ${joined}`;
  return truncateText(text, FALLBACK_REASON_MAX_CHARS);
}

/**
 * The never-finalized fallback reason: the model produced no usable
 * submission at all.
 */
export function formatNeverFinalizedFallbackReason(attempts: number): string {
  return `agent did not submit a valid outcome after ${attempts} attempt(s); contract fallback outcome applied`;
}

// ============================================================================
// Structured issue echo + repair prompts
// ============================================================================

export const REPAIR_ISSUES_MAX_LINES = 40;
export const REPAIR_ISSUES_MAX_CHARS = 2000;

/**
 * Structure one host-issued issue line for the repair prompt. Issue text
 * arriving on ExecutionRejection is host content built from the pinned
 * vocabulary (and possibly echoed model content); it is re-parsed into
 * "code + field path" form and truncated — never echoed freeform.
 * Lines outside the pinned vocabulary are kept truncated and tagged.
 */
function formatIssueLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") {
    return null;
  }

  const notAllowed = /^outcome_not_allowed: outcome "(.*)" is not in allowed_outcomes$/.exec(trimmed);
  if (notAllowed) {
    return `outcome_not_allowed — outcome "${notAllowed[1]}" is not in allowed_outcomes`;
  }
  const uncontracted = /^outcome_uncontracted: outcome "(.*)" has no outcome_contracts entry$/.exec(trimmed);
  if (uncontracted) {
    return `outcome_uncontracted — outcome "${uncontracted[1]}" has no outcome_contracts entry`;
  }
  const missingComment = /^missing_comment: outcome "(.*)" requires a comment \(require_comment\)$/.exec(trimmed);
  if (missingComment) {
    return `missing_comment — outcome "${missingComment[1]}" requires a non-empty comment`;
  }
  const propMissing = /^payload_schema: property "(.*)": required property is missing$/.exec(trimmed);
  if (propMissing) {
    return `payload_schema — field "${propMissing[1]}" is required but missing`;
  }
  const propType = /^payload_schema: property "(.*)": expected "(.*)", got "(.*)"$/.exec(trimmed);
  if (propType) {
    return `payload_schema — field "${propType[1]}" must be "${propType[2]}", got "${propType[3]}"`;
  }
  if (trimmed === ISSUE_OUTPUTS_NOT_OBJECT) {
    return "payload_schema — the submitted payload did not decode to a JSON object";
  }
  if (trimmed === ISSUE_BAD_SCHEMA) {
    return "payload_schema — the host rejected this step's contract schema (not fixable by editing the payload)";
  }
  if (trimmed === ISSUE_EMPTY_OUTCOME) {
    return "empty_outcome — the submission had no outcome";
  }
  if (trimmed === ISSUE_NO_RESULT) {
    return "no_result — the step ended without a finalized result";
  }
  // Unstructured host text: keep it, truncated, clearly not a contract issue.
  return `host_note: ${truncateText(trimmed, 120)}`;
}

/**
 * Render ExecutionRejection.issues into a structured, truncated block for the
 * repair prompt. Output is model-facing; long values and long lists can never
 * exceed the caps.
 */
export function formatRejectionIssuesForPrompt(issues: string): string {
  const rawLines = issues.split(/\r?\n/).slice(0, REPAIR_ISSUES_MAX_LINES);
  const formatted: string[] = [];
  for (const line of rawLines) {
    const rendered = formatIssueLine(line);
    if (rendered !== null) {
      formatted.push(`- ${rendered}`);
    }
  }
  if (formatted.length === 0) {
    formatted.push(`- host_note: ${truncateText(truncateText(issues, 120), 120)}`);
  }
  let text = formatted.join("\n");
  if (text.length > REPAIR_ISSUES_MAX_CHARS) {
    text = text.slice(0, REPAIR_ISSUES_MAX_CHARS) + "…";
  }
  if (issues.split(/\r?\n/).length > REPAIR_ISSUES_MAX_LINES) {
    text += "\n… (issue list truncated)";
  }
  return text;
}

/**
 * One-line-per-requirement summary of an outcome contract's payload schema,
 * injected into the tool description and instructions.
 */
export function buildContractLine(view: OutcomeContractView): string {
  const bits: string[] = [];
  if (view.requireComment) {
    bits.push(`comment REQUIRED`);
  }
  if (view.schemaText !== null) {
    const schema = view.parsed;
    if (schema === null) {
      bits.push("payload schema: (host-provided schema is not parseable)");
    } else if (schema.required.length === 0) {
      bits.push("payload: JSON object (no required properties)");
    } else {
      const parts = schema.required.map((prop) => {
        const type = schema.properties[prop];
        return type ? `${prop}: ${type}` : `${prop}`;
      });
      bits.push(`payload: object with required properties { ${parts.join(", ")} }`);
    }
  }
  if (view.fallback) {
    bits.push("no-result fallback");
  }
  const prefix = `"${view.name}"`;
  return bits.length > 0 ? `${prefix}: ${bits.join("; ")}` : prefix;
}

/**
 * Contract guidance appended to the submit_outcome tool description.
 */
export function buildContractToolDescription(contracts: OutcomeContractView[]): string {
  const lines = contracts.slice(0, 24).map((view) => `  - ${truncateText(buildContractLine(view), 240)}`);
  const suffix = contracts.length > 24 ? `\n  - … (${contracts.length - 24} more):` : "";
  return (
    "\n\nOutcome contracts: when choosing an outcome, submit its payload as a NESTED JSON object " +
    "(never flattened into the tool arguments) and match the contract below:\n" +
    lines.join("\n") + suffix
  );
}

/**
 * The contract-mode system-prompt appendix: what submit_outcome now requires
 * with contracts attached (nested payload, comment requirement, fallbacks).
 */
export function buildContractOutcomeInstructions(
  allowedOutcomes: string[],
  contracts: OutcomeContractView[]
): string {
  let text = (
    `You are integrated into a workflow system. When you have completed your task, you MUST call the \`${SUBMIT_OUTCOME_TOOL_NAME}\` tool to finalize the step. ` +
    `Do not stop or explain that you are done — just call the tool.`
  );
  if (allowedOutcomes.length > 0) {
    text += ` The allowed outcomes are: ${allowedOutcomes.join(", ")}.`;
  }
  const contractLines = contracts
    .slice(0, 24)
    .map((view) => `  - ${truncateText(buildContractLine(view), 200)}`);
  if (contractLines.length > 0) {
    text += `\nEach outcome may carry a contract. When submitting, use this shape: { outcome: string, comment?: string, payload?: object } — the payload is a NESTED JSON object validated against the outcome's contract (never flattened into the tool arguments):\n${contractLines.join("\n")}`;
    if (contracts.length > 24) {
      text += `\n  - … (${contracts.length - 24} more)`;
    }
  }
  return text;
}

/**
 * The corrective user prompt for a contract-mode reprompt turn, mentioning
 * pending validation issues so the model repairs them.
 */
export function buildContractRepromptPrompt(
  allowedOutcomes: string[],
  contracts: OutcomeContractView[],
  pendingIssues: string[]
): string {
  const list = allowedOutcomes.length > 0 ? allowedOutcomes.join(", ") : "(see the step's contracts)";
  let text = (
    `You have not finalized this workflow step. Call the \`${SUBMIT_OUTCOME_TOOL_NAME}\` tool now with one of: ${list}. ` +
    `Use the args shape { outcome, comment?, payload? } with a nested payload matching the step's outcome contract.`
  );
  if (contracts.length > 0) {
    const summary = contracts
      .slice(0, 8)
      .map((view) => `- ${truncateText(buildContractLine(view), 240)}`)
      .join("\n");
    text += `\nContract summary:\n${summary}`;
  }
  if (pendingIssues.length > 0) {
    const pending = truncateText(pendingIssues.join("; "), FALLBACK_REASON_ISSUES_MAX_CHARS);
    text += ` Your previous submission was rejected with these issues: ${pending}. Fix them before resubmitting.`;
  }
  text += ` Respond with the tool call only.`;
  return text;
}

export interface RejectionPromptContext {
  rejection: ExecutionRejectionView;
  contracts: OutcomeContractView[];
}

/**
 * The minimal repair prompt sent into the SAME live session when an execute
 * arrives in host-rejection repair mode. It must never resummarize the task:
 * the session already has it; this only carries what the host rejected.
 */
export function buildRepairPrompt({ rejection, contracts }: RejectionPromptContext): string {
  const lines: string[] = [];
  lines.push(
    `The host rejected your previous submission for this workflow step (repair attempt ${rejection.attempt}).`
  );
  if (rejection.outcome) {
    lines.push(`Attempted outcome: "${rejection.outcome}".`);
    const contract = contracts.find((view) => view.name === rejection.outcome);
    if (contract) {
      lines.push(`Requirements for "${contract.name}": ${truncateText(buildContractLine(contract), 240)}`);
    }
  }
  lines.push("Validation issues requiring correction:");
  lines.push(formatRejectionIssuesForPrompt(rejection.issues));
  lines.push(
    `Resubmit by calling the \`${SUBMIT_OUTCOME_TOOL_NAME}\` tool now with corrected arguments ` +
      `{ outcome, comment?, payload? } (nested payload, never flattened). Respond with the tool call only.`
  );
  return lines.join("\n\n");
}

/**
 * When the repair cannot reuse the live session (fresh conversation), the
 * rejection note rides the full re-executed prompt so the model still sees
 * what was rejected.
 */
export function buildRejectionNote({ rejection, contracts }: RejectionPromptContext): string {
  const lines: string[] = [];
  lines.push(
    `NOTE: a previous execution of this step was rejected by the host (repair attempt ${rejection.attempt}).` +
      (rejection.outcome ? ` Attempted outcome: "${rejection.outcome}".` : "")
  );
  const contract = contracts.find((view) => view.name === rejection.outcome);
  if (contract) {
    lines.push(`Requirements for "${contract.name}": ${truncateText(buildContractLine(contract), 240)}`);
  }
  lines.push("Validation issues to address before finalizing:");
  lines.push(formatRejectionIssuesForPrompt(rejection.issues));
  lines.push(
    `When you are done, finalize via \`${SUBMIT_OUTCOME_TOOL_NAME}\` with corrected arguments ` +
      `{ outcome, comment?, payload? }.`
  );
  return lines.join("\n");
}

export function buildRejectionNoteAppend(rejection: ExecutionRejectionView, contracts: OutcomeContractView[]): string {
  return "\n\n" + buildRejectionNote({ rejection, contracts });
}

// ============================================================================
// Finalize seam
// ============================================================================

/**
 * The adapter's finalize options handed to `helpers.outcomes.finalize`.
 * Legacy mode passes only `reason`; contract mode passes the validate
 * payload (verbatim) plus the finalize comment. The current TS SDK (0.5.x)
 * accepts only `reason`; extra keys are inert until the SDK card lands, and
 * this type is the seam the SDK regen takes over.
 */
export interface OutcomeFinalizeWireOpts {
  reason?: string;
  comment?: string;
  payload?: Record<string, unknown>;
}

export interface FinalizeResolution {
  outcome: string;
  /** Event-facing reason: the sanitized comment for contract finalizes, the
   * diagnostic reason otherwise. Rides the outcome.finalized event payload. */
  reason: string;
  /** ExecutResult comment (contract finalize); undefined in other modes. */
  comment?: string;
  /** The validated model payload, forwarded VERBATIM (contract finalize). */
  payload?: Record<string, unknown>;
}

/**
 * Build the finalize options for a resolved terminal outcome. Payload-verbatim
 * finalize passes only comment+payload (never a session-state assembly);
 * reason-only finalizes (legacy mode and adapter-side fallbacks) keep the
 * pre-v0.7.0 {"reason"} carrier.
 */
export function finalizeWireOptsFor(
  resolution: FinalizeResolution,
  contractMode: boolean
): OutcomeFinalizeWireOpts {
  if (contractMode && resolution.payload !== undefined) {
    return { comment: resolution.comment, payload: resolution.payload };
  }
  const opts: OutcomeFinalizeWireOpts = { reason: resolution.reason };
  if (contractMode && resolution.comment !== undefined) {
    opts.comment = resolution.comment;
  }
  return opts;
}