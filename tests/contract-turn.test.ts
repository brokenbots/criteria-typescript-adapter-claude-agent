/**
 * End-to-end contract-mode turn tests (KB-46): these drive the adapter's
 * real `executeStep` through `adapterConfig.execute` with raw request fields
 * (`outcomeContracts` / `rejection`) — the shape the v0.7.0 SDK will forward —
 * against a scripted fake claude query. Unit tests pin the policy module's
 * pure functions; these tests verify the full turn wiring: terminal finalize
 * via AbortController, payload-verbatim finalize seam, the in-turn rejection
 * repair loop with the MAX_FINALIZE_ATTEMPTS budget, fallback synthesis,
 * host-rejection repair prompts, and the no-contract passthrough.
 */
import { describe, test, expect, mock } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { FAKE_CLI, adapterPath } from "./helpers.js";
import { missingCommentIssue, SUBMIT_OUTCOME_TOOL_NAME } from "../contract.js";
import { MAX_FINALIZE_ATTEMPTS, REDACTED_PLACEHOLDER } from "../outcome.js";
import { canonicalJson, sanitizeReason } from "../redaction.js";

/** The KB-263 typed display reason: a sha256 digest of the redacted canonical payload rendering (with no held secrets, redaction is identity). */
function digestOf(value: unknown): string {
  return "sha256:" + createHash("sha256").update(sanitizeReason(canonicalJson(value), [])).digest("hex");
}

// ---------------------------------------------------------------------------
// Fake claude SDK
// ---------------------------------------------------------------------------

class MockMcpServer {
  name: string;
  tools: any[];
  constructor(opts: any) {
    this.name = opts.name;
    this.tools = opts.tools || [];
  }
}

interface Script {
  calls: Array<Record<string, unknown>>;
  hang?: boolean;
  sessionId?: string;
}

interface CapturedQuery {
  prompt: string;
  resume: string | undefined;
  /** Set by the fake generator when the abort actually interrupted the stream. */
  hangObserved: boolean;
  /** The registered submit_outcome tool (schema + handler). */
  tool: any;
}

class ScriptedQuery implements AsyncIterable<any> {
  constructor(private opts: any, private script: Script, private entry: CapturedQuery) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<any> {
    const { mcpServers } = this.opts.options ?? {};
    const serverName = Object.keys(mcpServers ?? {})[0];
    const tool = mcpServers?.[serverName]?.tools?.find((t: any) => t.name === SUBMIT_OUTCOME_TOOL_NAME);
    if (!tool) {
      throw new Error("submit_outcome tool not registered in fake mcp server");
    }
    for (const args of this.script.calls) {
      handlerResults.push(await tool.handler(args));
    }
    if (this.script.hang) {
      // Simulate ongoing agent work that only ends when the host aborts the
      // query — the terminal-finalize path under test.
      const abortController = this.opts.options?.abortController;
      await new Promise<void>((_resolve, reject) => {
        if (abortController?.signal.aborted) {
          this.entry.hangObserved = true;
          reject(new Error("Aborted by host finalize"));
          return;
        }
        abortController?.signal.addEventListener(
          "abort",
          () => {
            this.entry.hangObserved = true;
            reject(new Error("Aborted by host finalize"));
          },
          { once: true }
        );
      });
    }
    const result: any = {
      type: "result",
      subtype: "success",
      result: "scripted turn complete",
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 0,
    };
    if (this.script.sessionId) {
      result.session_id = this.script.sessionId;
    }
    yield result;
  }

  close() {}
  interrupt() {}
}

// Mutable per-test script; the mocked `query` reads it at call time. State
// resets in startTurn(); the adapter module itself is imported once below.
let script: Script = { calls: [] };
const captured: CapturedQuery[] = [];
const handlerResults: any[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    const { mcpServers } = opts.options ?? {};
    const serverName = Object.keys(mcpServers ?? {})[0];
    const entry: CapturedQuery = {
      prompt: opts.prompt,
      resume: opts.options?.resume,
      hangObserved: false,
      tool: mcpServers?.[serverName]?.tools?.find((t: any) => t.name === SUBMIT_OUTCOME_TOOL_NAME),
    };
    captured.push(entry);
    return new ScriptedQuery(opts, script, entry);
  },
  createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
}));

const mod: any = await import(`${adapterPath}?contract-turn`);
const execute = mod.adapterConfig.execute as (req: any, helpers: any) => Promise<void>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHelpers(heldSecrets?: { apiKey?: string; authToken?: string }): any {
  const sessionStore = new Map<string, any>();
  const events: Array<{ kind: string; payload: any }> = [];
  const finalizeCalls: Array<{ outcome: string; opts: any }> = [];
  const stderr: string[] = [];
  return {
    session: {
      get: (key: string) => sessionStore.get(key),
      set: (key: string, value: any) => void sessionStore.set(key, value),
    },
    secrets: {
      get: async (name: string) => {
        if (name === "ANTHROPIC_API_KEY") return heldSecrets?.apiKey ?? null;
        if (name === "ANTHROPIC_AUTH_TOKEN") return heldSecrets?.authToken ?? null;
        return null;
      },
    },
    log: {
      adapterEvent: async (kind: string, payload: any) => {
        events.push({ kind, payload });
      },
      stdout: async () => {},
      stderr: async (line: string) => {
        stderr.push(line);
      },
    },
    permission: { request: async () => ({ decision: "allow", reason: "" }) },
    tools: {
      callAdapterTool: async () => {
        throw new Error("not used in these tests");
      },
    },
    outcomes: {
      finalize: async (outcome: string, opts: any) => {
        finalizeCalls.push({ outcome, opts });
      },
    },
    events,
    finalizeCalls,
    stderr,
    sessionStore,
  };
}

function startTurn(s: Script, heldSecrets?: { apiKey?: string; authToken?: string }): any {
  script = s;
  captured.length = 0;
  handlerResults.length = 0;
  const helpers = makeHelpers(heldSecrets);
  helpers.session.set("claudeExecutable", FAKE_CLI);
  return helpers;
}

function eventsOf(helpers: any, kind: string): any[] {
  return helpers.events.filter((e: any) => e.kind === kind).map((e: any) => e.payload);
}

const COMMITTED_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" }, commit: { type: "string" } },
  required: ["summary", "commit"],
};

function contractReq(overrides: Record<string, unknown> = {}, sessionId = "turn-turn"): any {
  return {
    sessionId,
    stepName: "do-the-thing",
    input: { prompt: "Fix the flaky test in pkg/net. Verify with the full package suite." },
    allowedOutcomes: ["completed", "failed"],
    // snake_case wire form with bytes; the adapter accepts both styles.
    outcomeContracts: [
      { name: "completed", schema_json: Buffer.from(JSON.stringify(COMMITTED_SCHEMA)) },
      { name: "failed", schema_json: Buffer.from(JSON.stringify(COMMITTED_SCHEMA)) },
      { name: "gave_up", fallback: true },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contract-mode turn (integration via adapterConfig.execute)", () => {
  test("A: valid finalize is terminal — aborts the in-flight query and finalizes payload verbatim + comment", async () => {
    const payload = { summary: "fixed the net flake", commit: "abc123", extra: { nested: [1, 2, 3] } };
    const helpers = startTurn({ calls: [{ outcome: "completed", comment: "Fixed the flake.", payload }], hang: true, sessionId: "sess-a" });
    await execute(contractReq({}, "sess-a"), helpers);

    // The finalize aborted the (still-running) query mid-stream.
    expect(captured[0].hangObserved).toBe(true);
    expect(helpers.stderr.join("")).toContain("Aborted by host finalize");
    expect(helpers.stderr.join("")).not.toContain("Timed out");

    // Finalize: verbatim payload (nested keys intact) + comment, and never a
    // "reason" carrier for a contract finalize.
    expect(helpers.finalizeCalls).toEqual([
      {
        outcome: "completed",
        opts: {
          comment: "Fixed the flake.",
          payload: { summary: "fixed the net flake", commit: "abc123", extra: { nested: [1, 2, 3] } },
        },
      },
    ]);

    expect(eventsOf(helpers, "outcome.finalized")).toEqual([
      { outcome: "completed", reason: digestOf(payload) },
    ]);
    expect(eventsOf(helpers, "outcome.payload_invalid")).toEqual([]);
    expect(eventsOf(helpers, "outcome.recovered")).toEqual([]);
    expect(handlerResults[0].isError).toBeFalsy();
    expect(handlerResults[0].metadata.outcome).toBe("completed");
  });

  test("A2: the payload digest is a hash of the secret-REDACTED canonical rendering (KB-261)", async () => {
    const apiKey = "sk-ant-api03-SECRET-VALUE-123456";
    const payload = { summary: `used key ${apiKey} locally`, commit: "abc123" };
    const helpers = startTurn(
      { calls: [{ outcome: "completed", comment: "Fixed.", payload }], hang: true, sessionId: "sess-a2" },
      { apiKey }
    );
    await execute(contractReq({}, "sess-a2"), helpers);

    const events = eventsOf(helpers, "outcome.finalized");
    expect(events).toHaveLength(1);
    const reason = events[0].reason as string;
    // The digest is computed over the redacted canonical payload, so it
    // matches the same payload with the secret replaced by the placeholder —
    // and differs from a digest of the raw secret-bearing payload (which
    // would make the display lane a fingerprint of secret material).
    const redactedPayload = { summary: `used key ${REDACTED_PLACEHOLDER} locally`, commit: "abc123" };
    expect(reason).toBe(digestOf(redactedPayload));
    expect(reason).not.toBe(digestOf(payload));
    // The payload still travels on the finalize lane verbatim (redaction is
    // the digest input's concern, not the result lane's).
    expect(helpers.finalizeCalls[0].opts.payload).toEqual(payload);
    expect(eventsOf(helpers, "outcome.payload_invalid")).toEqual([]);
  });

  test("A3: payload key order does not change the digest (canonical, key-sorted rendering)", async () => {
    const first = startTurn({
      calls: [{ outcome: "completed", comment: "done", payload: { summary: "s", commit: "abc" } }],
      hang: true,
      sessionId: "sess-a3-a",
    });
    await execute(contractReq({}, "sess-a3-a"), first);

    const second = startTurn({
      calls: [{ outcome: "completed", comment: "done", payload: { commit: "abc", summary: "s" } }],
      hang: true,
      sessionId: "sess-a3-b",
    });
    await execute(contractReq({}, "sess-a3-b"), second);

    expect(eventsOf(first, "outcome.finalized")[0].reason).toBe(eventsOf(second, "outcome.finalized")[0].reason);
    expect(eventsOf(first, "outcome.finalized")[0].reason).toBe(digestOf({ summary: "s", commit: "abc" }));
  });

  test("B: rejected payloads loop in-turn and the contract fallback fires at budget exhaustion", async () => {
    const helpers = startTurn({
      calls: [
        { outcome: "completed", comment: "try one", payload: { summary: 42, commit: "abc" } },
        { outcome: "completed", comment: "try two", payload: { summary: "x" } }, // commit missing
        { outcome: "completed", comment: "try three", payload: "not an object" },
      ],
      sessionId: "sess-b",
    });
    await execute(contractReq({}, "sess-b"), helpers);

    const invalid = eventsOf(helpers, "outcome.payload_invalid");
    expect(invalid).toHaveLength(3);
    expect(invalid[0]).toEqual({
      outcome: "completed",
      issues: ['payload_schema: property "summary": expected "string", got "number"'],
    });
    expect(invalid[1]).toEqual({
      outcome: "completed",
      issues: ['payload_schema: property "commit": required property is missing'],
    });
    expect(invalid[2]).toEqual({
      outcome: "completed",
      issues: ["payload_schema: outputs_json does not decode to a JSON object"],
    });

    // Every rejection surfaced to the model with the issue list (in-turn repair);
    // the budget-exhaustion call returns the synthesized fallback SUCCESS so
    // the model stops retrying.
    expect(handlerResults[0].isError).toBe(true);
    expect(handlerResults[1].isError).toBe(true);
    expect(handlerResults[2].isError).toBeFalsy();
    expect(handlerResults[2].metadata.outcome).toBe("gave_up");

    // Budget exhausted + a fallback contract → synthesized fallback finalize
    // with the spec-mandated reason listing the issues of the exhausting
    // (last) rejection; a reason-only carrier, no payload.
    expect(eventsOf(helpers, "outcome.finalized")).toEqual([
      {
        outcome: "gave_up",
        reason:
          `payload validation failed ${MAX_FINALIZE_ATTEMPTS} times: ` +
          "payload_schema: outputs_json does not decode to a JSON object",
      },
    ]);
    expect(helpers.finalizeCalls).toHaveLength(1);
    expect(helpers.finalizeCalls[0].outcome).toBe("gave_up");
    expect(helpers.finalizeCalls[0].opts.reason).toContain("payload validation failed 3 times");
    expect(helpers.finalizeCalls[0].opts).not.toHaveProperty("payload");
    expect(helpers.finalizeCalls[0].opts).not.toHaveProperty("comment");
  });

  test("C: budget exhaustion without a fallback contract is a failure carrying the last issues", async () => {
    const helpers = startTurn({
      calls: Array.from({ length: MAX_FINALIZE_ATTEMPTS }, (_v, i) => ({
        outcome: "completed",
        comment: `attempt ${i + 1}`,
        payload: { summary: 42 },
      })),
      sessionId: "sess-c",
    });
    const req = contractReq(
      {
        outcomeContracts: [{ name: "completed", schema_json: Buffer.from(JSON.stringify(COMMITTED_SCHEMA)) }],
      },
      "sess-c"
    );
    await execute(req, helpers);

    expect(eventsOf(helpers, "outcome.payload_invalid")).toHaveLength(MAX_FINALIZE_ATTEMPTS);
    // No fallback → legacy needs_review-else-failure; failure here.
    expect(eventsOf(helpers, "outcome.finalized")).toEqual([]);
    expect(helpers.finalizeCalls).toHaveLength(1);
    expect(helpers.finalizeCalls[0].outcome).toBe("failure");
    expect(helpers.finalizeCalls[0].opts.reason).toContain("payload validation failed");
    expect(helpers.finalizeCalls[0].opts.reason).toContain(
      'payload_schema: property "summary": expected "string", got "number"'
    );
    expect(helpers.finalizeCalls[0].opts).not.toHaveProperty("payload");
  });

  test("D: require_comment is enforced in-turn; the next call with a comment finalizes", async () => {
    const helpers = startTurn({
      calls: [
        { outcome: "completed", payload: { summary: "ok", commit: "abc" } }, // comment missing
        { outcome: "completed", comment: "done now", payload: { summary: "ok", commit: "abc" } },
      ],
      sessionId: "sess-d",
    });
    const req = contractReq(
      {
        outcomeContracts: [
          { name: "completed", require_comment: true, schema_json: Buffer.from(JSON.stringify(COMMITTED_SCHEMA)) },
          { name: "gave_up", fallback: true },
        ],
      },
      "sess-d"
    );
    await execute(req, helpers);

    expect(eventsOf(helpers, "outcome.payload_invalid")).toEqual([
      {
        outcome: "completed",
        issues: ['missing_comment: outcome "completed" requires a comment (require_comment)'],
      },
    ]);
    expect(eventsOf(helpers, "outcome.finalized")).toEqual([
      { outcome: "completed", reason: digestOf({ summary: "ok", commit: "abc" }) },
    ]);
    expect(helpers.finalizeCalls).toEqual([
      { outcome: "completed", opts: { comment: "done now", payload: { summary: "ok", commit: "abc" } } },
    ]);
    expect(handlerResults[0].isError).toBe(true);
    expect(handlerResults[1].isError).toBeFalsy();
  });

  test("E: an outcome contracted but outside allowed_outcomes finalizes fine in contract mode", async () => {
    const helpers = startTurn({ calls: [{ outcome: "gave_up", comment: "giving up" }], sessionId: "sess-e" });
    const req = contractReq(
      {
        allowedOutcomes: [], // contract mode: contracts, not the allowed list, govern
        outcomeContracts: [{ name: "gave_up", fallback: true }],
      },
      "sess-e"
    );
    await execute(req, helpers);

    expect(eventsOf(helpers, "outcome.finalized")).toEqual([
      { outcome: "gave_up", reason: "giving up" },
    ]);
    expect(helpers.finalizeCalls).toEqual([
      { outcome: "gave_up", opts: { comment: "giving up", payload: {} } },
    ]);
  });

  test("F: no-contract steps keep the legacy flow (reason-only finalize, no payload key on the tool)", async () => {
    const helpers = startTurn({ calls: [{ outcome: "completed", reason: "did the thing" }], sessionId: "sess-f" });
    await execute(
      {
        sessionId: "sess-f",
        stepName: "do-the-thing",
        input: { prompt: "Fix the flaky test in pkg/net." },
        allowedOutcomes: ["completed", "failed"],
      },
      helpers
    );

    expect(helpers.finalizeCalls).toEqual([
      { outcome: "completed", opts: { reason: "did the thing" } },
    ]);
    expect(helpers.events.filter((e: any) => e.kind === "outcome.payload_invalid")).toEqual([]);
    expect(helpers.events.some((e: any) => e.kind === "query.complete")).toBe(true);

    // Legacy tool schema: enum-style outcome + reason carrier, no payload key.
    expect(captured[0].tool.inputSchema.outcome).toBeDefined();
    expect(captured[0].tool.inputSchema.reason).toBeDefined();
    expect(captured[0].tool.inputSchema.payload).toBeUndefined();
  });

  test("G: never-finalized contract turn reprompts in the same session and lands the never-finalized fallback", async () => {
    const helpers = startTurn({ calls: [], sessionId: "sess-g" });
    await execute(contractReq({}, "sess-g"), helpers);

    // 1 initial + 2 reprompts within the shared budget, all in one session.
    expect(captured).toHaveLength(3);
    expect(eventsOf(helpers, "outcome.reprompt")).toHaveLength(2);
    expect(captured[0].prompt).toBe("Fix the flaky test in pkg/net. Verify with the full package suite.");
    expect(captured[0].resume).toBeUndefined();
    expect(captured[1].resume).toBe("sess-g");

    expect(eventsOf(helpers, "outcome.finalized")).toEqual([
      {
        outcome: "gave_up",
        reason: "agent did not submit a valid outcome after 3 attempt(s); contract fallback outcome applied",
      },
    ]);
    expect(helpers.finalizeCalls).toHaveLength(1);
    expect(helpers.finalizeCalls[0].outcome).toBe("gave_up");
    expect(helpers.finalizeCalls[0].opts.reason).toContain(
      "agent did not submit a valid outcome after 3 attempt"
    );
    expect(eventsOf(helpers, "outcome.recovered")).toEqual([]);
  });

  test("H: host-rejection repair on a live session sends the minimal repair prompt and emits outcome.recovered", async () => {
    const helpers = startTurn({
      calls: [
        { outcome: "failed", comment: "corrected", payload: { summary: "blocked on upstream", commit: "def456" } },
      ],
      sessionId: "sess-h",
    });
    helpers.session.set("claudeSessionId", "live-claude-session");
    const req = contractReq(
      {
        rejection: {
          outcome: "failed",
          issues: 'payload_schema: property "summary": required property is missing',
          attempt: 2,
        },
      },
      "sess-h"
    );
    await execute(req, helpers);

    // Repair prompt replaces the full step prompt and carries the structured
    // (re-parsed, field-path) issue echo — never freeform echo.
    const prompt = captured[0].prompt;
    expect(prompt.startsWith("The host rejected your previous submission")).toBe(true);
    expect(prompt).toContain('field "summary" is required but missing');
    expect(prompt).toContain("Resubmit by calling the `submit_outcome` tool");
    expect(prompt).not.toContain("Fix the flaky test in pkg/net");

    // Same live session: the query resumes it.
    expect(captured[0].resume).toBe("live-claude-session");

    expect(eventsOf(helpers, "outcome.recovered")).toEqual([
      { attempt: 2, outcome: "failed" },
    ]);
    expect(helpers.finalizeCalls).toEqual([
      { outcome: "failed", opts: { comment: "corrected", payload: { summary: "blocked on upstream", commit: "def456" } } },
    ]);
  });

  test("I: host-rejection repair with a dead session degrades to full re-execute with the rejection note attached", async () => {
    const helpers = startTurn({
      calls: [{ outcome: "completed", comment: "after note", payload: { summary: "ok", commit: "abc" } }],
      sessionId: "sess-i",
    });
    const req = contractReq(
      {
        rejection: {
          outcome: "completed",
          issues: 'payload_schema: property "commit": expected "string", got "number"',
          attempt: 1,
        },
      },
      "sess-i"
    );
    await execute(req, helpers);

    const prompt = captured[0].prompt;
    // Full step prompt first, then the appended rejection note.
    expect(prompt.startsWith("Fix the flaky test in pkg/net")).toBe(true);
    expect(prompt).toContain("NOTE: a previous execution of this step was rejected by the host");
    expect(prompt).toContain('field "commit" must be "string", got "number"');
    expect(captured[0].resume).toBeUndefined();

    expect(eventsOf(helpers, "outcome.recovered")).toEqual([
      { attempt: 1, outcome: "completed" },
    ]);
    expect(helpers.finalizeCalls).toEqual([
      { outcome: "completed", opts: { comment: "after note", payload: { summary: "ok", commit: "abc" } } },
    ]);
  });

  test("J: the contract-mode tool schema exposes the nested payload + comment parameters", async () => {
    const helpers = startTurn({
      calls: [{ outcome: "completed", comment: "c", payload: { summary: "s", commit: "c" } }],
      sessionId: "sess-j",
    });
    const req = contractReq(
      {
        allowedOutcomes: ["completed"],
        outcomeContracts: [{ name: "completed", fallback: false, schema_json: Buffer.from(JSON.stringify(COMMITTED_SCHEMA)) }],
      },
      "sess-j"
    );
    await execute(req, helpers);

    expect(captured[0].tool.inputSchema.payload).toBeDefined();
    expect(captured[0].tool.inputSchema.comment).toBeDefined();
    expect(captured[0].tool.inputSchema.outcome).toBeDefined();
    // KB-391: the description is the per-step surface render (not the old
    // contract-liner appendix), COMMITTED_SCHEMA declares no reason member so
    // the declared set carries no reason parameter, and the allowed-outcome
    // enum rides the schema metadata the model sees.
    expect(captured[0].tool.description).toContain("the payload IS the step's output");
    expect(captured[0].tool.inputSchema.reason).toBeUndefined();
    const rendered = z.toJSONSchema(z.object(captured[0].tool.inputSchema), { io: "input" });
    expect(rendered.properties.outcome.enum).toEqual(["completed"]);
    expect(helpers.finalizeCalls).toEqual([
      { outcome: "completed", opts: { comment: "c", payload: { summary: "s", commit: "c" } } },
    ]);
  });

  test("K: an empty schema_json (zero-length bytes) carries no payload contract — the turn still finalizes end-to-end", async () => {
    const helpers = startTurn({
      calls: [{ outcome: "completed", comment: "done", payload: { summary: "ok", commit: "abc123" } }],
      hang: true,
      sessionId: "sess-k",
    });
    await execute(
      contractReq(
        {
          outcomeContracts: [
            { name: "completed", schema_json: Buffer.alloc(0) },
            { name: "failed", schema_json: Buffer.alloc(0) },
            { name: "gave_up", fallback: true },
          ],
        },
        "sess-k"
      ),
      helpers
    );

    // Empty bytes = no payload contract: the first submission is accepted
    // (payload forwarded verbatim) as the terminal finalize, not burned as
    // ISSUE_BAD_SCHEMA.
    expect(captured[0].hangObserved).toBe(true);
    expect(eventsOf(helpers, "outcome.payload_invalid")).toEqual([]);
    expect(eventsOf(helpers, "outcome.finalized")).toEqual([
      { outcome: "completed", reason: "done" },
    ]);
    expect(helpers.finalizeCalls).toEqual([
      { outcome: "completed", opts: { comment: "done", payload: { summary: "ok", commit: "abc123" } } },
    ]);
    expect(handlerResults[0].isError).toBeFalsy();
    expect(handlerResults[0].metadata.outcome).toBe("completed");
  });

  test("L: an empty-schema require_comment contract burns budget on missing_comment only and the fallback fires", async () => {
    const helpers = startTurn({
      calls: [
        { outcome: "completed", payload: {} },
        { outcome: "completed", payload: { anything: 1 } },
        { outcome: "completed", payload: { anything: [1, "two", null] } },
      ],
      sessionId: "sess-l",
    });
    await execute(
      contractReq(
        {
          outcomeContracts: [
            { name: "completed", require_comment: true, schema_json: "" },
            { name: "gave_up", fallback: true },
          ],
        },
        "sess-l"
      ),
      helpers
    );

    // Without the empty-schema normalization every call would have been
    // poisoned by payload_schema: contract schema_json is not a valid schema;
    // only the require_comment gate rejects here.
    const invalid = eventsOf(helpers, "outcome.payload_invalid");
    expect(invalid).toHaveLength(MAX_FINALIZE_ATTEMPTS);
    expect(invalid.map((e: any) => e.issues)).toEqual(
      Array.from({ length: MAX_FINALIZE_ATTEMPTS }, () => [missingCommentIssue("completed")])
    );

    expect(handlerResults[MAX_FINALIZE_ATTEMPTS - 1].isError).toBeFalsy();
    expect(handlerResults[MAX_FINALIZE_ATTEMPTS - 1].metadata.outcome).toBe("gave_up");
    expect(helpers.finalizeCalls).toHaveLength(1);
    expect(helpers.finalizeCalls[0].outcome).toBe("gave_up");
    expect(helpers.finalizeCalls[0].opts.reason).toContain(
      `payload validation failed ${MAX_FINALIZE_ATTEMPTS} times`
    );
    expect(helpers.finalizeCalls[0].opts.reason).toContain("requires a comment");
    expect(helpers.finalizeCalls[0].opts.reason).not.toContain("not a valid schema");
  });

  // -----------------------------------------------------------------------
  // KB-391/396 surface re-bind parity
  // -----------------------------------------------------------------------

  test("N: consecutive steps with different contracts re-bind the surface per step while the same-id session resumes", async () => {
    // Step 1: typed contracts; the execute persists its claude session id and
    // the bound surface digest on the shared chain.
    const helpers = startTurn({
      calls: [{ outcome: "completed", comment: "c1", payload: { summary: "s", commit: "c" } }],
      sessionId: "sess-n",
    });
    await execute(contractReq({}, "sess-n"), helpers);
    expect(helpers.session.get("claudeSessionId")).toBe("sess-n");

    // Step 2 on the SAME live session, with a different delivered contract
    // set (schema-less) — the KB-396 shape: a surface change must not destroy
    // the resumed conversation.
    const firstResume = captured[0].resume;
    const firstSchema = { ...captured[0].tool.inputSchema };
    const firstDescription = captured[0].tool.description;
    script = {
      calls: [{ outcome: "needs_human", reason: "human review needed" }],
      sessionId: "sess-n",
    };
    captured.length = 0;
    handlerResults.length = 0;
    (helpers as any).finalizeCalls.length = 0;
    const finalizedBeforeStep2 = eventsOf(helpers, "outcome.finalized");
    await execute(
      contractReq({ allowedOutcomes: ["needs_human"], outcomeContracts: [{ name: "needs_human", fallback: true }] }, "sess-n"),
      helpers
    );

    // SAME-ID resume: step 2 resumed step 1's reported claude session id.
    expect(firstResume).toBeUndefined();
    expect(captured[0].resume).toBe("sess-n");
    // The re-bind event carries the guard signal (sameId).
    expect(eventsOf(helpers, "outcome.surface_rebind")).toEqual([
      { resumeId: null, sameId: false },
      { resumeId: "sess-n", sameId: true },
    ]);

    // Per-step surface: step 2's own contract set, unioned enum, reason
    // member back (schema-less step), generic payload lane.
    const first = z.toJSONSchema(z.object(firstSchema), { io: "input" });
    expect(first.properties.outcome.enum).toEqual(["completed", "failed", "gave_up"]);
    const second = z.toJSONSchema(z.object(captured[0].tool.inputSchema), { io: "input" });
    expect(second.properties.outcome.enum).toEqual(["needs_human"]);
    expect(second.properties.reason).toBeDefined();
    expect(second.properties.payload.description).toBe(
      "Optional JSON object payload, forwarded to the workflow verbatim."
    );
    // A genuinely different per-step surface than step 1's.
    expect(captured[0].tool.description).not.toBe(firstDescription);

    // The schemaless finalize forwards the payload verbatim ({} — nothing
    // submitted) plus the comment lane, per contract-mode wire parity.
    expect(helpers.finalizeCalls).toEqual([
      { outcome: "needs_human", opts: { comment: "", payload: {} } },
    ]);
    expect(eventsOf(helpers, "outcome.finalized")).toEqual(
      finalizedBeforeStep2.concat([{ outcome: "needs_human", reason: "human review needed" }])
    );
  });

  test("O: consecutive steps with an identical surface cost no re-bind", async () => {
    const helpers = startTurn({
      calls: [{ outcome: "completed", comment: "c1", payload: { summary: "s", commit: "c" } }],
      sessionId: "sess-o",
    });
    await execute(contractReq({}, "sess-o"), helpers);
    const bindsAfterStep1 = eventsOf(helpers, "outcome.surface_rebind");
    expect(bindsAfterStep1).toHaveLength(1); // entering contract mode

    script = {
      calls: [{ outcome: "failed", comment: "c2", payload: { summary: "still broken" } }],
      sessionId: "sess-o",
    };
    captured.length = 0;
    handlerResults.length = 0;
    await execute(contractReq({}, "sess-o"), helpers);

    // Same delivered contracts → same digest → no re-bind event on step 2,
    // and the same-id resume still continues the chain.
    expect(eventsOf(helpers, "outcome.surface_rebind")).toEqual(bindsAfterStep1);
    expect(captured[1].resume).toBe("sess-o");
  });

  test("P: an undeclared verdict is rejected typed (invalid_outcome) with the allowed-set chooser", async () => {
    const helpers = startTurn({
      calls: [
        { outcome: "bogus_outcome", comment: "try one", payload: { summary: "s", commit: "c" } },
        { outcome: "bogus_outcome", comment: "try two", payload: { summary: "s", commit: "c" } },
        { outcome: "bogus_outcome", comment: "try three", payload: { summary: "s", commit: "c" } },
      ],
      sessionId: "sess-p",
    });
    await execute(
      contractReq({ outcomeContracts: [{ name: "completed", schema_json: Buffer.from(JSON.stringify(COMMITTED_SCHEMA)) }] }, "sess-p"),
      helpers
    );

    // Typed model-facing rejection: the allowed-set chooser, not the raw
    // evaluator issue string.
    expect(handlerResults[0].isError).toBe(true);
    expect(handlerResults[0].content[0].text).toBe(
      'Outcome "bogus_outcome" is not in the allowed set; choose one of: completed, failed'
    );

    // The budget-costing event keeps the pinned evaluator issue.
    expect(eventsOf(helpers, "outcome.payload_invalid")).toEqual(
      Array.from({ length: MAX_FINALIZE_ATTEMPTS }, () => ({
        outcome: "bogus_outcome",
        issues: ['outcome_not_allowed: outcome "bogus_outcome" is not in allowed_outcomes'],
      }))
    );

    // Exhaustion carries the typed classification in the failure reason.
    expect(helpers.finalizeCalls[0].opts.reason).toContain("(invalid outcome)");
  });

  test("Q1: a top-level reason folds into a contract-schema-required reason member (mixed-step reason preservation)", async () => {
    const REASON_SCHEMA = {
      type: "object",
      properties: {
        summary: { type: "string" },
        commit: { type: "string" },
        reason: { type: "string" },
      },
      required: ["summary", "commit", "reason"],
    };
    const helpers = startTurn({
      calls: [{ outcome: "completed", reason: "the flake was a race", payload: { summary: "s", commit: "c" } }],
      hang: true,
      sessionId: "sess-q1",
    });
    // Mixed step: the schemaless gave_up keeps the top-level reason lane
    // declared, which is exactly the lane the fold reconciles for the typed
    // outcome's contract-required reason member.
    await execute(
      contractReq(
        {
          outcomeContracts: [
            { name: "completed", schema_json: Buffer.from(JSON.stringify(REASON_SCHEMA)) },
            { name: "gave_up", fallback: true },
          ],
        },
        "sess-q1"
      ),
      helpers
    );

    // The fold moved the top-level reason into the payload (contract-required
    // order) so the evaluator's required-member gate passes.
    expect(helpers.finalizeCalls).toEqual([
      {
        outcome: "completed",
        opts: {
          comment: "",
          payload: { summary: "s", commit: "c", reason: "the flake was a race" },
        },
      },
    ]);
    // Display lane: the folded reason prose is the operative output text.
    expect(eventsOf(helpers, "outcome.finalized")).toEqual([
      { outcome: "completed", reason: "the flake was a race" },
    ]);
  });

  test("Q2: a top-level reason on a typed outcome without a schema reason member is rejected typed (invalid_params)", async () => {
    const helpers = startTurn({
      calls: [
        { outcome: "completed", reason: "findings as prose", payload: { summary: "s", commit: "c" } },
        { outcome: "completed", comment: "fixed", payload: { summary: "s2", commit: "c2" } },
      ],
      sessionId: "sess-q2",
    });
    await execute(contractReq({}, "sess-q2"), helpers);

    expect(handlerResults[0].isError).toBe(true);
    expect(handlerResults[0].content[0].text).toContain(
      'submit_outcome rejected: "reason" is not consumed by this typed outcome (its contract declares a payload schema, so the payload is the output).'
    );
    expect(handlerResults[0].content[0].text).toContain(
      "The step's findings belong under the payload's declared fields — the schema's reason field when the contract declares one. Call submit_outcome again without the \"reason\" parameter."
    );

    // One budget attempt burned by the wrong-lane rejection; the retry (without
    // reason) finalizes.
    expect(eventsOf(helpers, "outcome.payload_invalid")).toEqual([]);
    expect(helpers.finalizeCalls).toEqual([
      { outcome: "completed", opts: { comment: "fixed", payload: { summary: "s2", commit: "c2" } } },
    ]);
  });
});
