import { describe, expect, test } from "bun:test";
import {
  buildContractModeContext,
  buildRejectionNote,
  buildRepairPrompt,
  ContractModeContext,
  decodeSchemaRaw,
  evaluateContractSubmission,
  extractExecutionRejection,
  formatFallbackFinalizeReason,
  formatRejectionIssuesForPrompt,
  ISSUE_BAD_SCHEMA,
  ISSUE_EMPTY_OUTCOME,
  ISSUE_OUTPUTS_NOT_OBJECT,
  jsonTypeName,
  missingCommentIssue,
  OutcomeContractView,
  outcomeNotAllowedIssue,
  outcomeUncontractedIssue,
  parseOutcomeSchemaText,
  payloadSchemaIssues,
  propertyMissingIssue,
  propertyTypeIssue,
  truncateText,
} from "./contract.js";

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    summary: { type: "string" },
    exit_code: { type: "number" },
  },
  required: ["summary", "exit_code"],
});

function ctxOf(
  contracts: Array<Record<string, unknown>>,
  extraReq: Record<string, unknown> = {}
): ContractModeContext {
  const ctx = buildContractModeContext({ outcomeContracts: contracts, ...extraReq });
  if (!ctx) throw new Error("expected contract context");
  return ctx;
}

function submit(
  ctx: ContractModeContext,
  outcome: string,
  payload: unknown,
  comment = "did the thing"
): string[] {
  return evaluateContractSubmission(ctx, [], { outcome, comment, payload });
}

describe("contract schema parsing (pinned subset)", () => {
  test("raw bytes decode to utf8 text", () => {
    expect(decodeSchemaRaw(Buffer.from('{"type":"object"}'))).toBe('{"type":"object"}');
    expect(decodeSchemaRaw("{})")).toBe("{})");
    expect(decodeSchemaRaw("")).toBeNull();
    expect(decodeSchemaRaw(undefined)).toBeNull();
    expect(decodeSchemaRaw(42 as any)).toBeNull();
  });

  test("full subset parses to required list + property type map", () => {
    expect(parseOutcomeSchemaText(SCHEMA)).toEqual({
      required: ["summary", "exit_code"],
      properties: { summary: "string", exit_code: "number" },
    });
  });

  test("JSON null root parses as an empty valid schema (Go zero-struct mirror)", () => {
    expect(parseOutcomeSchemaText("null")).toEqual({ required: [], properties: {} });
  });

  test("trim-empty schema text and whitespace-only bytes are invalid", () => {
    expect(parseOutcomeSchemaText("   \n ")).toBeNull();
    const view = payloadSchemaIssues;
    const contract: OutcomeContractView = {
      name: "completed",
      fallback: false,
      requireComment: false,
      schemaText: "  ",
      parsed: null,
      schemaInvalid: true,
    };
    expect(view(contract, {})).toEqual([ISSUE_BAD_SCHEMA]);
  });

  test("malformed JSON and non-object roots are invalid", () => {
    expect(parseOutcomeSchemaText("{")).toBeNull();
    expect(parseOutcomeSchemaText("42")).toBeNull();
    expect(parseOutcomeSchemaText('"object"')).toBeNull();
    expect(parseOutcomeSchemaText("[]")).toBeNull();
    expect(parseOutcomeSchemaText("true")).toBeNull();
  });

  test("root type must be exactly the object string", () => {
    expect(parseOutcomeSchemaText('{"type": "array"}')).toBeNull();
    expect(parseOutcomeSchemaText('{"type": 3}')).toBeNull();
    expect(parseOutcomeSchemaText('{"type": "OBJECT"}')).toBeNull();
    expect(parseOutcomeSchemaText('{"type": null}')).toEqual({ required: [], properties: {} });
    expect(parseOutcomeSchemaText('{"type": "object"}')).toEqual({ required: [], properties: {} });
  });

  test("required must be an array of strings; null tolerated as absent", () => {
    expect(parseOutcomeSchemaText('{"required": "a"}')).toBeNull();
    expect(parseOutcomeSchemaText('{"required": [1]}')).toBeNull();
    expect(parseOutcomeSchemaText('{"required": ["a", "a"]}')).toEqual({
      required: ["a", "a"],
      properties: {},
    });
    expect(parseOutcomeSchemaText('{"required": null}')).toEqual({ required: [], properties: {} });
    expect(parseOutcomeSchemaText('{"required": ["x"]}')).toEqual({ required: ["x"], properties: {} });
  });

  test("properties values must be objects with a pinned leaf type", () => {
    expect(parseOutcomeSchemaText('{"properties": {"a": {"type": "integer"}}}')).toBeNull();
    expect(parseOutcomeSchemaText('{"properties": {"a": "string"}}')).toBeNull();
    expect(parseOutcomeSchemaText('{"properties": {"a": []}}')).toBeNull();
    expect(parseOutcomeSchemaText('{"properties": null}')).toEqual({ required: [], properties: {} });
    expect(parseOutcomeSchemaText('{"properties": {"a": null}}')).toEqual({
      required: [],
      properties: { a: "" },
    });
    expect(parseOutcomeSchemaText('{"properties": {"a": {"type": "string", "maxLength": 5}}}')).toEqual({
      required: [],
      properties: { a: "string" },
    });
    expect(parseOutcomeSchemaText('{"properties": {"a": {"type": "object"}, "b": {"type": "array"}}}')).toEqual({
      required: [],
      properties: { a: "object", b: "array" },
    });
  });
});

describe("payload lanes", () => {
  const contract: OutcomeContractView = {
    name: "completed",
    fallback: false,
    requireComment: false,
    schemaText: SCHEMA,
    parsed: { required: ["summary", "exit_code"], properties: { summary: "string", exit_code: "number" } },
    schemaInvalid: false,
  };

  test("lane 1: non-object payloads report only the object-decode issue", () => {
    expect(payloadSchemaIssues(contract, [1, 2])).toEqual([ISSUE_OUTPUTS_NOT_OBJECT]);
    expect(payloadSchemaIssues(contract, "x")).toEqual([ISSUE_OUTPUTS_NOT_OBJECT]);
    expect(payloadSchemaIssues(contract, 5)).toEqual([ISSUE_OUTPUTS_NOT_OBJECT]);
    expect(payloadSchemaIssues(contract, true)).toEqual([ISSUE_OUTPUTS_NOT_OBJECT]);
  });

  test("absent/null payload = empty object (then only required-property rules apply)", () => {
    expect(payloadSchemaIssues(contract, undefined)).toEqual([
      propertyMissingIssue("summary"),
      propertyMissingIssue("exit_code"),
    ]);
    expect(payloadSchemaIssues(contract, null)).toEqual([
      propertyMissingIssue("summary"),
      propertyMissingIssue("exit_code"),
    ]);
  });

  test("lane 2: contract carrying an invalid schema reports the pinned invalid-schema issue", () => {
    const bad: OutcomeContractView = {
      name: "completed",
      fallback: false,
      requireComment: false,
      schemaText: "{",
      parsed: null,
      schemaInvalid: true,
    };
    expect(payloadSchemaIssues(bad, { anything: 1 })).toEqual([ISSUE_BAD_SCHEMA]);
  });

  test("no schema on the contract means no payload validation at all", () => {
    const plain: OutcomeContractView = {
      name: "completed",
      fallback: false,
      requireComment: false,
      schemaText: null,
      parsed: null,
      schemaInvalid: false,
    };
    expect(payloadSchemaIssues(plain, { anything: [1, "two", null] })).toEqual([]);
  });

  test("lane 3: required-array order, presence before type, extras forwarded", () => {
    // Mirrors conformance vector 02 issue order (summary type first, exit_code second).
    expect(
      payloadSchemaIssues(contract, { summary: 42, exit_code: "two", extra: "kept" })
    ).toEqual([
      propertyTypeIssue("summary", "string", "number"),
      propertyTypeIssue("exit_code", "number", "string"),
    ]);
    expect(payloadSchemaIssues(contract, { summary: "ok" })).toEqual([
      propertyMissingIssue("exit_code"),
    ]);
    // Presence issues and type issues compose: both reported.
    expect(payloadSchemaIssues(contract, { exit_code: "two" })).toEqual([
      propertyMissingIssue("summary"),
      propertyTypeIssue("exit_code", "number", "string"),
    ]);
  });

  test("lane 3: JSON null values use the null type name; presence-only properties skip types", () => {
    expect(jsonTypeName(null)).toBe("null");
    const presenceOnly: OutcomeContractView = {
      name: "completed",
      fallback: false,
      requireComment: false,
      schemaText: '{"required": ["a"]}',
      parsed: { required: ["a"], properties: { a: "" } },
      schemaInvalid: false,
    };
    expect(payloadSchemaIssues(presenceOnly, { a: null })).toEqual([]);
    expect(payloadSchemaIssues(presenceOnly, {})).toEqual([propertyMissingIssue("a")]);
  });

  test("nested object/array properties validate by JSON type", () => {
    const nested: OutcomeContractView = {
      name: "completed",
      fallback: false,
      requireComment: false,
      schemaText: '{"required": ["a", "b", "c"]}',
      parsed: { required: ["a", "b", "c"], properties: { a: "object", b: "array", c: "boolean" } },
      schemaInvalid: false,
    };
    expect(payloadSchemaIssues(nested, { a: {}, b: [], c: false })).toEqual([]);
    expect(payloadSchemaIssues(nested, { a: {}, b: {}, c: false })).toEqual([
      propertyTypeIssue("b", "array", "object"),
    ]);
  });
});

describe("empty schema on the wire (empty bytes = no payload contract)", () => {
  // Per the proto (OutcomeContract.schema_json): an empty bytes field — or an
  // already-decoded "" — means the outcome carries no payload contract and its
  // outputs_json is forwarded verbatim. Every zero-length wire shape must
  // collapse to that absent-schema view, never ISSUE_BAD_SCHEMA.

  function expectAbsentSchemaView(view: OutcomeContractView): void {
    expect(view.schemaText).toBeNull();
    // The empty (valid) schema — parseOutcomeSchemaText("null"). Inert for
    // validation (payloadSchemaIssues short-circuits on schemaText === null);
    // what pins "no contract" is schemaText === null + schemaInvalid false.
    expect(view.parsed).toEqual({ required: [], properties: {} });
    expect(view.schemaInvalid).toBe(false);
  }

  test("empty string schema collapses to the absent-schema view; payloads forward verbatim", () => {
    const ctx = ctxOf([{ name: "completed", schemaJson: "" }]);
    expectAbsentSchemaView(ctx.byName.get("completed")!);
    expect(payloadSchemaIssues(ctx.byName.get("completed")!, { anything: 1 })).toEqual([]);
  });

  test("zero-length bytes schema (Buffer.alloc(0)) collapses to the absent-schema view", () => {
    const ctx = ctxOf([{ name: "completed", schemaJson: Buffer.alloc(0) }]);
    expectAbsentSchemaView(ctx.byName.get("completed")!);
    expect(payloadSchemaIssues(ctx.byName.get("completed")!, { anything: 1 })).toEqual([]);
  });

  test("empty Uint8Array schema collapses to the absent-schema view", () => {
    const ctx = ctxOf([{ name: "completed", schemaJson: new Uint8Array(0) }]);
    expectAbsentSchemaView(ctx.byName.get("completed")!);
    expect(payloadSchemaIssues(ctx.byName.get("completed")!, { anything: 1 })).toEqual([]);
  });

  test("whitespace-only schema text is still an invalid schema, not empty", () => {
    const ctx = ctxOf([{ name: "completed", schemaJson: "  " }]);
    const view = ctx.byName.get("completed")!;
    expect(view.schemaInvalid).toBe(true);
    expect(payloadSchemaIssues(view, { anything: 1 })).toEqual([ISSUE_BAD_SCHEMA]);
  });

  test("empty-schema contract validates nothing end-to-end via evaluateContractSubmission", () => {
    const ctx = ctxOf([{ name: "plain", schemaJson: "" }]);
    expect(submit(ctx, "plain", { anything: [1, "two", null] })).toEqual([]);
  });

  test("empty-schema fallback contract finalizes any payload end-to-end", () => {
    const ctx = ctxOf([{ name: "gave_up", fallback: true, schemaJson: new Uint8Array(0) }]);
    expect(ctx.fallback?.name).toBe("gave_up");
    expect(submit(ctx, "gave_up", { reason: "tests blocked by bad input" })).toEqual([]);
  });

  test("non-empty bytes that fail to parse are still flagged invalid (whitespace-only bytes)", () => {
    const ctx = ctxOf([{ name: "completed", schemaJson: Buffer.from("  \n ") }]);
    const view = ctx.byName.get("completed")!;
    expect(view.schemaInvalid).toBe(true);
    expect(submit(ctx, "completed", { anything: 1 })).toEqual([ISSUE_BAD_SCHEMA]);
  });
});

describe("gate evaluation order", () => {
  const ctx = ctxOf([
    { name: "completed", schemaJson: SCHEMA },
    { name: "blocked", require_comment: true, schemaJson: '{"properties": {"a": {"type": "string"}}}' },
    { name: "fallback", fallback: true },
  ]);

  test("empty outcome is reported first", () => {
    expect(submit(ctx, "", {})).toEqual([ISSUE_EMPTY_OUTCOME]);
  });

  test("not-allowed fires only when the allowed list is non-empty", () => {
    expect(evaluateContractSubmission(ctx, ["other"], { outcome: "completed", comment: "c", payload: { summary: "s", exit_code: 0 } })).toEqual([
      outcomeNotAllowedIssue("completed"),
    ]);
    const valid = { outcome: "completed", comment: "c", payload: { summary: "s", exit_code: 0 } };
    expect(evaluateContractSubmission(ctx, [], valid)).toEqual([]);
  });

  test("uncontracted outcomes are rejected", () => {
    expect(evaluateContractSubmission(ctx, ["completed", "nope"], { outcome: "nope", comment: "c", payload: {} })).toEqual([
      outcomeUncontractedIssue("nope"),
    ]);
  });

  test("missing_comment precedes payload-schema issues", () => {
    expect(evaluateContractSubmission(ctx, [], { outcome: "blocked", comment: "  ", payload: 12 })).toEqual([
      missingCommentIssue("blocked"),
      ISSUE_OUTPUTS_NOT_OBJECT,
    ]);
    // Whitespace-only comment counts as missing.
    expect(evaluateContractSubmission(ctx, [], { outcome: "blocked", comment: "", payload: {} })).toEqual([
      missingCommentIssue("blocked"),
    ]);
    expect(submit(ctx, "blocked", undefined)).toEqual([]);
  });

  test("no-schema contract never validates payload shape", () => {
    const plain = ctxOf([{ name: "plain" }]);
    expect(submit(plain, "plain", { anything: [1, "two", null] })).toEqual([]);
  });

  test("gate short-circuits: a rejected outcome name drops contract issues", () => {
    expect(evaluateContractSubmission(ctx, ["completed"], { outcome: "nope", comment: "", payload: -1 })).toEqual([
      outcomeNotAllowedIssue("nope"),
    ]);
  });

  test("duplicate contract names: first entry governs", () => {
    const dup = ctxOf([
      { name: "completed", schemaJson: '{"required": ["a"]}' },
      { name: "completed", schemaJson: '{"required": ["b"]}' },
    ]);
    expect(submit(dup, "completed", { a: 1 })).toEqual([]);
    expect(submit(dup, "completed", {})).toEqual([propertyMissingIssue("a")]);
  });
});

describe("contract context build + identity cache", () => {
  test("legacy mode (absent or empty contracts) returns null", () => {
    expect(buildContractModeContext({})).toBeNull();
    expect(buildContractModeContext({ outcomeContracts: [] })).toBeNull();
    expect(buildContractModeContext(undefined)).toBeNull();
    expect(buildContractModeContext({ outcome_contracts: "nope" })).toBeNull();
  });

  test("entries without usable names are skipped; fallback flag and require_comment normalize", () => {
    const ctx = ctxOf([
      { name: "" },
      null,
      { name: "fb", fallback: "true" },
      { name: "plain", schema_json: Buffer.from('{"required":[]}') },
    ]);
    expect(ctx.contracts.map((view) => view.name)).toEqual(["fb", "plain"]);
    expect(ctx.fallback?.name).toBe("fb");
    expect(ctx.byName.has("plain")).toBe(true);
  });

  test("a list whose every entry is unusable is legacy mode, not an empty contract set", () => {
    expect(buildContractModeContext({ outcomeContracts: [{ name: "" }, null, "nope", {}] })).toBeNull();
  });

  test("schema_json parses once per identity: duplicate entries share the parsed view", () => {
    const req = {
      outcomeContracts: [
        { name: "completed", schemaJson: SCHEMA },
        { name: "completed_copy", schemaJson: SCHEMA },
      ],
    };
    const ctx = buildContractModeContext(req)!;
    expect(ctx.byName.get("completed")!.parsed).toBe(ctx.byName.get("completed_copy")!.parsed);
    expect(ctx.byName.get("completed")!.schemaText).toBe(ctx.byName.get("completed_copy")!.schemaText);
  });

  test("first fallback contract wins", () => {
    const ctx = ctxOf([
      { name: "a", fallback: true },
      { name: "b", fallback: true },
    ]);
    expect(ctx.fallback?.name).toBe("a");
  });

  test("schema text that is not bytes/text or corrupt is flagged invalid, not silent", () => {
    const ctx = ctxOf([{ name: "completed", schemaJson: 42 as any }]);
    expect(ctx.byName.get("completed")?.schemaInvalid).toBe(true);
    expect(submit(ctx, "completed", { anything: 1 })).toEqual([ISSUE_BAD_SCHEMA]);
  });
});

describe("formatting helpers", () => {
  test("fallback reason prefix and truncation", () => {
    expect(formatFallbackFinalizeReason(3, ['payload_schema: property "a": expected "string", got "number"'])).toBe(
      'payload validation failed 3 times: payload_schema: property "a": expected "string", got "number"'
    );
    const long = "x".repeat(1000);
    const reason = formatFallbackFinalizeReason(1, [long]);
    expect(reason.length).toBeLessThanOrEqual(601);
    expect(reason.startsWith("payload validation failed 1 times: ")).toBe(true);
    expect(reason.endsWith("…")).toBe(true);
  });

  test("structured issue echo keeps pinned codes, truncates, and never echoes freeform", () => {
    const rendered = formatRejectionIssuesForPrompt(
      [
        'outcome_not_allowed: outcome "shipped" is not in allowed_outcomes',
        'missing_comment: outcome "completed" requires a comment (require_comment)',
        'payload_schema: property "summary": required property is missing',
        'payload_schema: property "summary": expected "string", got "number"',
        ISSUE_OUTPUTS_NOT_OBJECT,
        ISSUE_BAD_SCHEMA,
        ISSUE_EMPTY_OUTCOME,
        "weird host note with a secret-ish token SUPERSECRET",
      ].join("\n")
    );
    expect(rendered).toContain('outcome_not_allowed — outcome "shipped" is not in allowed_outcomes');
    expect(rendered).toContain('missing_comment — outcome "completed" requires a non-empty comment');
    expect(rendered).toContain('payload_schema — field "summary" is required but missing');
    expect(rendered).toContain('payload_schema — field "summary" must be "string", got "number"');
    expect(rendered).toContain("SUPERSECRET"); // unparsable host note, truncated and tagged
    expect(rendered).toContain("host_note:");
    // Pinned issue strings are re-structured, never echoed freeform.
    expect(rendered).not.toContain("payload_schema: property");
  });

  test("structured echo truncates long lists and long text", () => {
    const many = Array.from({ length: 80 }, (_, i) => `payload_schema: property "f${i}": required property is missing`).join("\n");
    const rendered = formatRejectionIssuesForPrompt(many);
    expect(rendered.split("\n").length).toBeLessThanOrEqual(41);
    expect(rendered).toContain("(issue list truncated)");
    const rendered2 = formatRejectionIssuesForPrompt("");
    expect(rendered2.startsWith("- host_note:")).toBe(true);
  });

  test("truncateText marks dropped content", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("a".repeat(30), 10)).toBe("a".repeat(10) + "…");
  });
});

describe("repair prompt + rejection note", () => {
  const rejection = {
    outcome: "completed",
    issues: [
      'payload_schema: property "summary": required property is missing',
      'payload_schema: property "summary": expected "string", got "number"',
    ].join("\n"),
    attempt: 2,
  };

  test("repair prompt is minimal and does not resummarize the task", () => {
    const prompt = buildRepairPrompt({ rejection, contracts: [] });
    expect(prompt).toContain("rejected your previous submission");
    expect(prompt).toContain('Attempted outcome: "completed"');
    expect(prompt).toContain('field "summary" is required but missing');
    expect(prompt).toContain('field "summary" must be "string", got "number"');
    expect(prompt).toContain("Resubmit by calling the `submit_outcome` tool now");
    // No step prompt content, only rejection machinery.
    expect(prompt).not.toContain("The user");
  });

  test("rejection note rides full prompt re-execution when the session is dead", () => {
    const note = buildRejectionNote({ rejection, contracts: [] });
    expect(note).toContain("repair attempt 2");
    expect(note).toContain("Validation issues to address before finalizing:");
    expect(note.startsWith("NOTE:")).toBe(true);
  });

  test("empty issues still render a single host note", () => {
    const prompt = buildRepairPrompt({ rejection: { outcome: "", issues: "", attempt: 1 }, contracts: [] });
    expect(prompt).toContain("- host_note:");
  });
});

describe("rejection extraction", () => {
  test("absent rejection → null", () => {
    expect(extractExecutionRejection({})).toBeNull();
    expect(extractExecutionRejection(undefined)).toBeNull();
    expect(extractExecutionRejection({ rejection: null })).toBeNull();
    expect(extractExecutionRejection({ rejection: "x" })).toBeNull();
  });

  test("snake_case and malformed fields normalize defensively", () => {
    expect(
      extractExecutionRejection({
        rejection: { outcome: "completed", issues: "a\nb", attempt: 3 },
      })
    ).toEqual({ outcome: "completed", issues: "a\nb", attempt: 3 });
    expect(extractExecutionRejection({ rejection: { attempt: "NaN" } })).toEqual({
      outcome: "",
      issues: "",
      attempt: 0,
    });
    expect(
      extractExecutionRejection({ rejection: { outcome: 42, issues: null, attempt: -1 } })
    ).toEqual({ outcome: "", issues: "", attempt: -1 });
  });
});
