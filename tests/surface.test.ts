/**
 * Unit tests for the per-step submit_outcome surface module (KB-391): the
 * builder's schema-metadata policy (enum, payload branches, comment/reason
 * descriptions, digest), the strict typed decode, and the ensureStepSurface
 * KB-396 same-id resume guard.
 */
import { describe, test, expect } from "bun:test";
import { buildContractModeContext } from "../contract.js";
import {
  buildStepSurface,
  canonicalJson,
  decodeSubmitOutcomeArgs,
  declaredSubmitParamsFor,
  ensureStepSurface,
  quoteJoin,
  SUBMIT_SURFACE_DIGEST_PREFIX,
  SubmitArgsDecodeError,
  surfaceDigestOf,
} from "../surface.js";
import { createHash } from "node:crypto";
import { z } from "zod";

const COMMITTED_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" }, commit: { type: "string" } },
  required: ["summary", "commit"],
};

/** Render a surface's zod shape into the JSON schema the model sees. */
function renderSchema(surface: { zodShape: Record<string, z.ZodTypeAny> }): any {
  return z.toJSONSchema(z.object(surface.zodShape), { io: "input" });
}

function ctx(contracts: unknown) {
  return buildContractModeContext({ outcomeContracts: contracts });
}

describe("buildStepSurface", () => {
  test("uniform typed contracts collapse to one payload branch and drop the reason parameter", () => {
    const c = ctx([
      { name: "completed", schema_json: JSON.stringify(COMMITTED_SCHEMA) },
      { name: "failed", schema_json: JSON.stringify(COMMITTED_SCHEMA) },
    ])!;
    const surface = buildStepSurface(["completed", "failed"], c.contracts)!;
    expect(surface).not.toBeNull();

    const rendered = renderSchema(surface);
    expect(rendered.properties.outcome.enum).toEqual(["completed", "failed"]);
    expect(rendered.properties.reason).toBeUndefined();
    expect(rendered.properties.comment.type).toBe("string");
    expect(rendered.required).toEqual(["outcome"]);
    expect(surface.declared.sort()).toEqual(["comment", "outcome", "payload"]);

    const payload = rendered.properties.payload;
    expect(payload.type).toBe("object");
    expect(payload.properties.summary).toBeDefined();
    expect(payload.properties.commit).toBeDefined();
    expect(payload.description).toContain(quoteJoin(["completed", "failed"]));
    expect(payload.description).toContain("the payload IS the step's output");

    expect(surface.description).toContain("the payload IS the step's output");
    expect(surface.description).toContain("re-declared from the step's finalization contracts");
    // Typed-only step: no schemaless lane, so no reason prose teaching.
    expect(surface.description).not.toContain("`reason`");
  });

  test("diverging typed schemas surface one anyOf branch per distinct schema, ordered by outcome", () => {
    const other = {
      type: "object",
      properties: { error: { type: "string" } },
      required: ["error"],
    };
    const c = ctx([
      { name: "failed", schema_json: JSON.stringify(other) },
      { name: "completed", schema_json: JSON.stringify(COMMITTED_SCHEMA) },
    ])!;
    const surface = buildStepSurface(["completed", "failed"], c.contracts)!;
    const payload = (surface.params.properties as any).payload;
    expect(payload.anyOf).toHaveLength(2);
    // Branch order: first governing outcome sorted — completed before failed.
    expect(payload.anyOf[0].description).toContain(quoteJoin(["completed"]));
    expect(payload.anyOf[0].properties.summary).toBeDefined();
    expect(payload.anyOf[1].description).toContain(quoteJoin(["failed"]));
    expect(payload.anyOf[1].properties.error).toBeDefined();
    expect(payload.description).toContain("the payload IS the step's output");
  });

  test("identical schema documents from different byte layouts collapse into one branch", () => {
    const reordered = {
      required: ["summary", "commit"],
      properties: { commit: { type: "string" }, summary: { type: "string" } },
      type: "object",
    };
    const c = ctx([
      { name: "completed", schema_json: JSON.stringify(COMMITTED_SCHEMA) },
      { name: "failed", schema_json: JSON.stringify(reordered) },
    ])!;
    const surface = buildStepSurface([], c.contracts)!;
    const payload = (surface.params.properties as any).payload;
    expect(payload.anyOf).toBeUndefined();
    expect(payload.description).toContain(quoteJoin(["completed", "failed"]));
  });

  test("KB-261: a non-required contract property stays optional on the payload branch (no model-visible required)", () => {
    const loose = {
      type: "object",
      properties: { summary: { type: "string" }, notes: { type: "string" } },
      required: ["summary"],
    };
    const c = ctx([{ name: "completed", schema_json: JSON.stringify(loose) }])!;
    const surface = buildStepSurface(["completed"], c.contracts)!;
    const rendered = renderSchema(surface);

    // Declared names stay visible (unknown-typed, optional members).
    const payload = rendered.properties.payload;
    expect(payload.properties.summary).toBeDefined();
    expect(payload.properties.notes).toBeDefined();
    // zod 4's z.unknown() alone is non-optional and would list contract
    // fields in `required`, rejecting contract-valid payloads at the MCP
    // bridge before the handler runs — the branch must stay optional.
    expect(payload.required).toBeUndefined();
    expect(payload.required ?? []).not.toContain("notes");

    // And the shape accepts a contract-valid payload missing the
    // non-required field (decode still routes via the handler).
    const result = z.object(surface.zodShape).safeParse({ outcome: "completed", payload: { summary: "s" } });
    expect(result.success).toBe(true);
  });

  test("KB-261: diverging payload branches carry per-outcome descriptions on the model-visible anyOf", () => {
    const other = {
      type: "object",
      properties: { error: { type: "string" } },
      required: ["error"],
    };
    const c = ctx([
      { name: "failed", schema_json: JSON.stringify(other) },
      { name: "completed", schema_json: JSON.stringify(COMMITTED_SCHEMA) },
    ])!;
    const surface = buildStepSurface(["completed", "failed"], c.contracts)!;
    const payload = renderSchema(surface).properties.payload;

    // Assert on the MODEL-VISIBLE schema: every anyOf member names the
    // outcome(s) it finalizes, so the model can map a branch to its verdict.
    expect(payload.anyOf).toHaveLength(2);
    for (const member of payload.anyOf) {
      expect(member.description).toBeDefined();
      expect(member.description).toContain("Use only when finalizing with outcome");
    }
    expect(payload.anyOf[0].description).toContain(quoteJoin(["completed"]));
    expect(payload.anyOf[0].description).not.toContain(quoteJoin(["failed"]));
    expect(payload.anyOf[1].description).toContain(quoteJoin(["failed"]));
    expect(payload.anyOf[1].description).not.toContain(quoteJoin(["completed"]));
  });

  test("mixed steps keep the reason parameter with schemaless-only wording", () => {
    const c = ctx([
      { name: "completed", schema_json: JSON.stringify(COMMITTED_SCHEMA) },
      { name: "gave_up", fallback: true, schema_json: Buffer.alloc(0) },
    ])!;
    const surface = buildStepSurface(["completed", "gave_up"], c.contracts)!;
    const rendered = renderSchema(surface);
    expect(rendered.properties.reason).toBeDefined();
    expect(rendered.properties.reason.description).toContain(
      "only the step's schemaless outcomes consume it"
    );
    // Only the schema-carrying completed contributes a payload branch.
    const payload = rendered.properties.payload;
    expect(payload.properties.summary).toBeDefined();
    expect(surface.description).toContain("`reason`");
  });

  test("all-require_comment steps make comment a schema-required member and name it in the enum description", () => {
    const c = ctx([
      { name: "completed", require_comment: true, schema_json: JSON.stringify(COMMITTED_SCHEMA) },
      { name: "failed", require_comment: true, schema_json: Buffer.alloc(0) },
    ])!;
    const surface = buildStepSurface(["completed", "failed"], c.contracts)!;
    expect(surface.params.required).toEqual(["outcome", "comment"]);
    expect((surface.params.properties as any).comment.description).toContain("every outcome of this step requires a non-empty comment");
    expect((surface.params.properties as any).outcome.description).toContain(
      quoteJoin(["completed", "failed"])
    );
  });

  test("mixed require_comment keeps comment optional and names the requiring outcomes", () => {
    const c = ctx([
      { name: "completed", require_comment: true, schema_json: Buffer.alloc(0) },
      { name: "gave_up", fallback: true, schema_json: Buffer.alloc(0) },
    ])!;
    const surface = buildStepSurface(["completed", "gave_up"], c.contracts)!;
    expect(surface.params.required).toEqual(["outcome"]);
    expect((surface.params.properties as any).comment.description).toContain(
      quoteJoin(["completed"])
    );
  });

  test("schemaless-only steps keep the generic payload and the display-only reason", () => {
    const c = ctx([
      { name: "completed", schema_json: Buffer.alloc(0) },
      { name: "gave_up", fallback: true, schema_json: Buffer.alloc(0) },
    ])!;
    const surface = buildStepSurface(["completed"], c.contracts)!;
    const rendered = renderSchema(surface);
    expect(rendered.properties.payload.description).toBe(
      "Optional JSON object payload, forwarded to the workflow verbatim."
    );
    expect(rendered.properties.reason.description).toContain("shown to operators");
    expect(rendered.properties.reason.description).toContain(
      "NOT part of the step's forwarded output"
    );
    expect(surface.description).toContain("durable findings surface is `comment`");
  });

  test("a non-empty unparseable schema counts as schema-carrying and contributes no branch", () => {
    const c = ctx([
      { name: "completed", schema_json: Buffer.from("definitively not json") },
    ])!;
    const surface = buildStepSurface(["completed"], c.contracts)!;
    const rendered = renderSchema(surface);
    // Typed lane: no reason member; generic payload; the unparseable schema is
    // flagged at finalize time by the pinned contract gate.
    expect(rendered.properties.reason).toBeUndefined();
    expect(rendered.properties.payload.description).toBe(
      "Optional JSON object payload, forwarded to the workflow verbatim."
    );
    expect(rendered.properties.outcome.enum).toEqual(["completed"]);
  });

  test("blank contract names are dropped and contract names join the enum", () => {
    const c = ctx([{ name: "needs_human" }])!;
    const surface = buildStepSurface(["", "  needs_human "], c.contracts)!;
    expect(surface).not.toBeNull();
    const rendered = renderSchema(surface);
    expect(rendered.properties.outcome.enum).toEqual(["needs_human"]);
  });

  test("contract-less steps have no surface (static lane byte-identical)", () => {
    expect(buildStepSurface(["completed"], [])).toBeNull();
    expect(buildStepSurface([], [])).toBeNull();
  });
});

describe("surface digest", () => {
  test("is deterministic for equal surfaces and distinct for diverging ones", () => {
    const c1 = ctx([{ name: "completed", schema_json: JSON.stringify(COMMITTED_SCHEMA) }])!;
    const c2 = ctx([{ name: "completed", schema_json: JSON.stringify({ ...COMMITTED_SCHEMA }) }])!;
    const a = buildStepSurface(["completed"], c1.contracts)!;
    const b = buildStepSurface(["completed"], c2.contracts)!;
    expect(a.digest).toBe(b.digest);

    const c3 = ctx([{ name: "completed", require_comment: true, schema_json: JSON.stringify(COMMITTED_SCHEMA) }])!;
    const d = buildStepSurface(["completed"], c3.contracts)!;
    expect(d.digest).not.toBe(a.digest);
  });

  test("digest covers description and params via canonical JSON", () => {
    const expected = createHash("sha256")
      .update(`${SUBMIT_SURFACE_DIGEST_PREFIX}\ndescription\n${canonicalJson({ a: 1 })}`)
      .digest("hex");
    // Reimplementation check via the prefix constant only: digest() is the
    // sha256 of prefix + description + canonicalJson params.
    expect(SUBMIT_SURFACE_DIGEST_PREFIX).toBe("submit-surface-v1");
    expect(canonicalJson({ b: { c: [1, 2] }, a: 1 })).toBe('{"a":1,"b":{"c":[1,2]}}');
    expect(expected.startsWith("sha256")).toBe(false);
  });

  test("surfaceDigestOf(null) is the empty digest", () => {
    expect(surfaceDigestOf(null)).toBe("");
    const c = ctx([{ name: "x" }])!;
    const surface = buildStepSurface(["x"], c.contracts)!;
    expect(surfaceDigestOf(surface)).toBe(surface.digest);
  });
});

describe("decodeSubmitOutcomeArgs", () => {
  const schema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
  const surface = buildStepSurface(
    ["completed"],
    ctx([{ name: "completed", schema_json: JSON.stringify(schema) }])!.contracts
  );

  test("null/undefined/empty args decode to an empty object", () => {
    expect(decodeSubmitOutcomeArgs(undefined, surface)).toEqual({});
    expect(decodeSubmitOutcomeArgs(null, surface)).toEqual({});
    expect(decodeSubmitOutcomeArgs({}, surface)).toEqual({});
  });

  test("a non-object envelope is rejected typed invalid_outcome", () => {
    try {
      decodeSubmitOutcomeArgs("flat string", surface);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SubmitArgsDecodeError);
      expect((err as SubmitArgsDecodeError).kind).toBe("invalid_outcome");
      expect((err as Error).message).toBe(
        "submit_outcome arguments must be a JSON object with the declared fields"
      );
    }
  });

  test("undeclared parameters are rejected typed invalid_params with typed-lane guidance", () => {
    try {
      decodeSubmitOutcomeArgs({ outcome: "completed", reason: "findings text" }, surface);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SubmitArgsDecodeError);
      expect((err as SubmitArgsDecodeError).kind).toBe("invalid_params");
      expect((err as Error).message).toContain('unknown parameter(s) "reason"');
      expect((err as Error).message).toContain(
        'the declared parameters are "comment", "outcome", "payload"'
      );
      expect((err as Error).message).toContain(
        "the payload is this step's output: findings and structured results belong under the declared payload schema members, and no top-level reason parameter exists."
      );
    }
  });

  test("undeclared parameters on a reason-declared surface get reason-lane guidance", () => {
    const mixed = buildStepSurface(
      ["completed", "gave_up"],
      ctx([
        { name: "completed", schema_json: JSON.stringify(schema) },
        { name: "gave_up", fallback: true, schema_json: Buffer.alloc(0) },
      ]!)!.contracts
    )!;
    try {
      decodeSubmitOutcomeArgs({ outcome: "gave_up", reason: "ok", bogus: true }, mixed);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain(
        'the step\'s findings text belongs in the required "reason" parameter.'
      );
      expect((err as Error).message).toContain('unknown parameter(s) "bogus"');
    }
  });

  test("the static lane (null surface) keeps the legacy declared set", () => {
    expect(declaredSubmitParamsFor(null)).toEqual(["comment", "outcome", "payload", "reason"]);
    expect(decodeSubmitOutcomeArgs({ outcome: "done", reason: "r" }, null)).toEqual({
      outcome: "done",
      reason: "r",
    });
    try {
      decodeSubmitOutcomeArgs({ outcome: "done", junk: 1 }, null);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain('unknown parameter(s) "junk"');
    }
  });

  test("declared arguments pass through untouched (trimming is the handler's)", () => {
    const decoded = decodeSubmitOutcomeArgs(
      { outcome: " completed ", payload: { summary: "s" }, comment: "c" },
      surface
    );
    expect(decoded).toEqual({ outcome: " completed ", payload: { summary: "s" }, comment: "c" });
  });
});

describe("ensureStepSurface", () => {
  const surface = () =>
    buildStepSurface(
      ["completed"],
      ctx([{ name: "completed", schema_json: JSON.stringify(COMMITTED_SCHEMA) }])!.contracts
    )!;

  test("a same-shape consecutive step costs no re-bind and keeps the resume id", () => {
    const want = surface();
    const decision = ensureStepSurface({
      want,
      boundDigest: want.digest,
      persistedResumeId: "sess-1",
      sharesResumeChain: true,
    });
    expect(decision.rebind).toBe(false);
    expect(decision.resumeId).toBe("sess-1");
    expect(decision.boundDigest).toBe(want.digest);
  });

  test("a surface-changing step re-binds but PRESERVES the same-id resume chain (KB-396)", () => {
    const c2 = ctx([
      { name: "completed", require_comment: true, schema_json: JSON.stringify(COMMITTED_SCHEMA) },
    ])!;
    const other = buildStepSurface(["completed"], c2.contracts)!;
    const decision = ensureStepSurface({
      want: other,
      boundDigest: surface().digest,
      persistedResumeId: "sess-1",
      sharesResumeChain: true,
    });
    expect(decision.rebind).toBe(true);
    expect(decision.resumeId).toBe("sess-1");
    expect(decision.boundDigest).toBe(other.digest);
  });

  test("a concurrent sibling keeps no resume id across a re-bind", () => {
    const c2 = ctx([{ name: "needs_human" }])!;
    const decision = ensureStepSurface({
      want: buildStepSurface(["needs_human"], c2.contracts)!,
      boundDigest: surface().digest,
      persistedResumeId: "sess-9",
      sharesResumeChain: false,
    });
    expect(decision.rebind).toBe(true);
    expect(decision.resumeId).toBeNull();
  });

  test("entering and leaving contract mode is a guarded re-bind in both directions", () => {
    const enter = ensureStepSurface({
      want: surface(),
      boundDigest: "",
      persistedResumeId: "sess-2",
      sharesResumeChain: true,
    });
    expect(enter.rebind).toBe(true);
    expect(enter.resumeId).toBe("sess-2");

    const leave = ensureStepSurface({
      want: null,
      boundDigest: surface().digest,
      persistedResumeId: "sess-2",
      sharesResumeChain: true,
    });
    expect(leave.rebind).toBe(true);
    expect(leave.resumeId).toBe("sess-2");
    expect(leave.boundDigest).toBe("");
  });

  test("a static-lane step with no bound digest is not a re-bind", () => {
    const decision = ensureStepSurface({
      want: null,
      boundDigest: "",
      persistedResumeId: "sess-3",
      sharesResumeChain: true,
    });
    expect(decision.rebind).toBe(false);
    expect(decision.resumeId).toBe("sess-3");
  });
});
