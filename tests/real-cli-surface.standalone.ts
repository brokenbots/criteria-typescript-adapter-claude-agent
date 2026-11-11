/**
 * Real-CLI conformance harness (KB-391/396).
 *
 * Drives the adapter's REAL spawn path against @anthropic-ai/claude-agent-sdk
 * with a fake Claude Code CLI executable (tests/fake-claude-cli.mjs compiled
 * into an extensionless executable with the runtime's shebang). There is no
 * SDK mock in this file: the SDK spawns the fake CLI, negotiates its control
 * protocol, and serves submit_outcome through the SDK MCP bridge, so the
 * per-step contract surface arrives at the "CLI" exactly as it does in
 * production. What is pinned here — and can ONLY be pinned here, per the
 * KB-396 root-cause lesson — is the interaction between spawn/resume
 * lifecycle and the per-step surface re-bind:
 *
 *  - consecutive steps with different delivered contracts see each step's own
 *    allowed-outcome enum + per-outcome descriptions as the tool schema that
 *    the CLI receives over the wire that step (KB-391);
 *  - a surface-changing step on a RESUMED same-id live session keeps the live
 *    conversation: the spawn carries --resume with the persisted claude
 *    session id and the CLI continues the same session (KB-396, mirrors
 *    copilot's TestEnsureStepSurfaceSameIDResumeDoesNotDestroyConversation);
 *  - an undeclared verdict is rejected typed (invalid_outcome) over the real
 *    tools/call wire.
 *
 * This file deliberately does NOT match the default `bun test` glob (no
 * `.test.` in the filename): Bun's test runner shares one process — and one
 * module registry — across test files, so any sibling file that calls
 * `mock.module("@anthropic-ai/claude-agent-sdk")` would leak into this suite
 * and silently replace the SDK the harness must exercise (fake query objects
 * resolve without ever spawning the CLI). `tests/real-cli-contract.test.ts`
 * runs this file as a child process so it always sees the real SDK; it can
 * also be run directly for iteration:
 *
 *   bun test ./tests/real-cli-surface.standalone.ts
 *
 * The fake CLI is version-coupled to the installed agent-SDK control protocol;
 * set CRITERIA_CLAUDE_CLI_CONTRACT=0 to skip the suite (CI triage knob).
 */
import { describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { adapterPath } from "./helpers.js";
import { SUBMIT_OUTCOME_TOOL_NAME } from "../outcome.js";

const SKIP = process.env.CRITERIA_CLAUDE_CLI_CONTRACT === "0";
const cliSource = readFileSync(new URL("./fake-claude-cli.mjs", import.meta.url), "utf8");

const mod: any = await import(`${adapterPath}?real-cli`);
const execute = mod.adapterConfig.execute as (req: any, helpers: any) => Promise<void>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeCliHelpers {
  session: { get: (k: string) => any; set: (k: string, v: any) => void };
  secrets: { get: (name: string) => Promise<null> };
  log: {
    adapterEvent: (kind: string, payload: any) => Promise<void>;
    stdout: (line: string) => Promise<void>;
    stderr: (line: string) => Promise<void>;
  };
  permission: { request: (req: any) => Promise<any> };
  outcomes: { finalize: (outcome: string, opts: any) => Promise<void> };
  events: Array<{ kind: string; payload: any }>;
  finalizeCalls: Array<{ outcome: string; opts: any }>;
  stderr: string[];
}

function makeHelpers(): FakeCliHelpers {
  const sessionStore = new Map<string, any>();
  const events: Array<{ kind: string; payload: any }> = [];
  const finalizeCalls: Array<{ outcome: string; opts: any }> = [];
  const stderr: string[] = [];
  return {
    session: {
      get: (key: string) => sessionStore.get(key),
      set: (key: string, value: any) => void sessionStore.set(key, value),
    },
    // No secrets are held in these runs; redaction is a passthrough.
    secrets: { get: async (_name: string) => null },
    log: {
      adapterEvent: async (kind: string, payload: any) => void events.push({ kind, payload }),
      stdout: async () => {},
      stderr: async (line: string) => void stderr.push(line),
    },
    permission: { request: async () => ({ decision: "allow", reason: "" }) },
    outcomes: {
      finalize: async (outcome: string, opts: any) => void finalizeCalls.push({ outcome, opts }),
    },
    events,
    finalizeCalls,
    stderr,
  };
}

function eventsOf(helpers: FakeCliHelpers, kind: string): any[] {
  return helpers.events.filter((e) => e.kind === kind).map((e) => e.payload);
}

function readJSONL(file: string): any[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Builds the fake CLI as an extensionless executable (the agent SDK spawns
// non-JS-extension paths directly) whose shebang is the current runtime. The
// committed source carries its own `#!/usr/bin/env node` first line for
// standalone DX; strip it so the composed executable has exactly one shebang.
function buildFakeCli(workdir: string): string {
  const body = cliSource.replace(/^#![^\n]*\r?\n/, "");
  const cliPath = path.join(workdir, "claude-fake-code");
  writeFileSync(cliPath, `#!${process.execPath}\n` + body, { mode: 0o755 });
  chmodSync(cliPath, 0o755);
  return cliPath;
}

const COMMITTED_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" }, commit: { type: "string" } },
  required: ["summary", "commit"],
};

function contractReq(sessionId: string, workdir: string, overrides: Record<string, unknown> = {}): any {
  return {
    sessionId,
    stepName: "do-the-thing",
    input: {
      prompt: "Fix the flaky test in pkg/net. Verify with the full package suite.",
      cwd: workdir,
    },
    allowedOutcomes: ["completed", "failed"],
    outcomeContracts: [
      { name: "completed", schema_json: Buffer.from(JSON.stringify(COMMITTED_SCHEMA)) },
      { name: "failed", schema_json: Buffer.from(JSON.stringify(COMMITTED_SCHEMA)) },
      { name: "gave_up", fallback: true },
    ],
    ...overrides,
  };
}

function submitOutcomeTool(tools: any[]) {
  const tool = tools.find((t) => t.name === SUBMIT_OUTCOME_TOOL_NAME);
  if (!tool) throw new Error(`no ${SUBMIT_OUTCOME_TOOL_NAME} in listed tools: ${JSON.stringify(tools.map((t) => t.name))}`);
  return tool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("real CLI surface conformance (KB-391/396)", () => {
  test.skipIf(SKIP)(
    "consecutive steps re-bind the per-step surface over a resumed same-id live session",
    async () => {
      const workdir = mkdtempSync(path.join(os.tmpdir(), "claude-real-cli-"));
      const helpers = makeHelpers();
      helpers.session.set("claudeExecutable", buildFakeCli(workdir));

      // Step 1: typed contracts, submit the first allowed outcome.
      appendFileSync(
        path.join(workdir, "fake-cli-script.jsonl"),
        JSON.stringify({ outcome: "completed", comment: "c1", payload: { summary: "s", commit: "c" } }) + "\n"
      );
      await execute(contractReq("sess-real-1", workdir), helpers);

      const spawns = readJSONL(path.join(workdir, "fake-cli-spawns.jsonl"));
      expect(spawns.length).toBe(1);
      expect(spawns[0].resume).toBe(null);
      const stepOneSessionId = helpers.session.get("claudeSessionId") as string;
      expect(stepOneSessionId).toBe(spawns[0].sessionId);

      expect(eventsOf(helpers, "outcome.surface_rebind")).toEqual([
        { resumeId: null, sameId: false },
      ]);
      expect(helpers.finalizeCalls).toEqual([
        {
          outcome: "completed",
          opts: { comment: "c1", payload: { summary: "s", commit: "c" } },
        },
      ]);

      const tools0 = submitOutcomeTool(readJSONL(path.join(workdir, "fake-cli-tools.jsonl"))[0].tools);
      expect((tools0.inputSchema as any).properties.outcome.enum).toEqual(["completed", "failed", "gave_up"]);
      // The step carries a schemaless fallback (gave_up), so the union keeps a
      // display-only reason lane scoped to the schemaless outcomes.
      expect((tools0.inputSchema as any).properties.reason?.description).toContain("schemaless");
      // The typed payload lane carries the per-contract schema description,
      // not the generic schemaless text.
      expect((tools0.inputSchema as any).properties.payload.description).toContain(
        "payload IS the step's output"
      );
      // The tool description is the per-step re-declared submission schema
      // marker; the outcomes themselves live in the enum above.
      expect(tools0.description).toContain("re-declared from the step's finalization contracts");

      // Step 2 on the SAME live session with a different delivered contract
      // set (schema-less needs_human): the surface changes, the conversation
      // must not. This is the assertion class the in-process suite cannot
      // make: the actual spawn of a RESUMED session against a re-bound tool.
      appendFileSync(
        path.join(workdir, "fake-cli-script.jsonl"),
        JSON.stringify({ outcome: "needs_human", reason: "human review needed" }) + "\n"
      );
      await execute(
        contractReq("sess-real-1", workdir, {
          allowedOutcomes: ["needs_human"],
          outcomeContracts: [{ name: "needs_human", fallback: true }],
        }),
        helpers
      );

      const spawns2 = readJSONL(path.join(workdir, "fake-cli-spawns.jsonl"));
      expect(spawns2.length).toBe(2);
      // KB-396: the surface-changing step resumed the persisted session id.
      expect(spawns2[1].resume).toBe(stepOneSessionId);
      // The fake CLI continued the SAME session (live conversation preserved).
      expect(spawns2[1].sessionId).toBe(stepOneSessionId);

      expect(eventsOf(helpers, "outcome.surface_rebind")).toEqual([
        { resumeId: null, sameId: false },
        { resumeId: stepOneSessionId, sameId: true },
      ]);
      expect(helpers.finalizeCalls).toEqual([
        { outcome: "completed", opts: { comment: "c1", payload: { summary: "s", commit: "c" } } },
        { outcome: "needs_human", opts: { comment: "", payload: {} } },
      ]);

      const tools1 = submitOutcomeTool(
        readJSONL(path.join(workdir, "fake-cli-tools.jsonl")).find((e: any) => e.spawn === 1).tools
      );
      expect((tools1.inputSchema as any).properties.outcome.enum).toEqual(["needs_human"]);
      expect((tools1.inputSchema as any).properties.reason).toBeDefined();
      expect((tools1.inputSchema as any).properties.payload.description).toBe(
        "Optional JSON object payload, forwarded to the workflow verbatim."
      );
      expect(tools1.description).not.toBe(tools0.description);
      // Step 1's typed payload description is genuinely different from the
      // generic schemaless lane.
      expect((tools0.inputSchema as any).properties.payload.description).not.toBe(
        (tools1.inputSchema as any).properties.payload.description
      );

      // The bound digest reflects step 2's surface.
      expect(helpers.session.get("claudeSubmitSurfaceDigest")).toBeDefined();
    },
    120_000
  );

  test.skipIf(SKIP)(
    "typed rejections over the real wire: MCP pre-decode, handler wrong-lane gate, budget fallback",
    async () => {
      const workdir = mkdtempSync(path.join(os.tmpdir(), "claude-real-cli-reject-"));
      const helpers = makeHelpers();
      helpers.session.set("claudeExecutable", buildFakeCli(workdir));

      // Attempt 1: needs_human is NOT an allowed outcome this step. The MCP
      // bridge's zod pre-decode rejects it before the adapter handler ever
      // runs, echoing the per-step allowed enum (typed -32602).
      appendFileSync(
        path.join(workdir, "fake-cli-script.jsonl"),
        JSON.stringify({ outcome: "needs_human", reason: "not allowed this step" }) + "\n"
      );
      // Attempt 2: a declared outcome with a payload violating the step's
      // payload_schema (missing commit). The embedded contract schema rejects
      // it typed at the tool surface, naming the undeclared member.
      appendFileSync(
        path.join(workdir, "fake-cli-script.jsonl"),
        JSON.stringify({ outcome: "completed", comment: "partial", payload: { summary: "s" } }) + "\n"
      );
      // Attempt 3: a schema-valid typed submission that carries a stray
      // reason parameter — passes the zod pre-decode (reason is a declared
      // optional member) and is rejected typed by the handler's KB-263
      // wrong-lane gate (the invalid_params kind drives the
      // finalizeFailure diagnostics; the wire text is the typed message).
      appendFileSync(
        path.join(workdir, "fake-cli-script.jsonl"),
        JSON.stringify({ outcome: "completed", reason: "stray prose", payload: { summary: "s", commit: "c" } }) + "\n"
      );
      await execute(contractReq("sess-real-2", workdir), helpers);

      const calls = readJSONL(path.join(workdir, "fake-cli-calls.jsonl"));
      expect(calls).toHaveLength(3);

      expect(calls[0].isError).toBe(true);
      const rejected = (calls[0].content ?? []).map((block: any) => block?.text ?? "").join("");
      expect(rejected).toContain("Invalid arguments for tool submit_outcome");
      expect(rejected).toContain("Invalid option");
      expect(rejected).toContain('"completed"');
      expect(rejected).toContain('"failed"');
      expect(rejected).toContain('"gave_up"');

      expect(calls[1].isError).toBe(true);
      const schemaViolated = (calls[1].content ?? []).map((block: any) => block?.text ?? "").join("");
      expect(schemaViolated).toContain("Invalid arguments for tool submit_outcome");
      expect(schemaViolated).toContain("commit");

      expect(calls[2].isError).toBe(true);
      const wrongLane = (calls[2].content ?? []).map((block: any) => block?.text ?? "").join("");
      expect(wrongLane).toContain('"reason" is not consumed by this typed outcome');
      expect(wrongLane).toContain('Call submit_outcome again without the "reason" parameter');

      // The rejected attempts resumed the same-id chain (rejections are not
      // session-destroying either), and the exhausted budget fell back.
      const spawns = readJSONL(path.join(workdir, "fake-cli-spawns.jsonl"));
      expect(spawns.length).toBe(3);
      expect(spawns[1].resume).toBe(spawns[0].sessionId);
      expect(helpers.finalizeCalls).toHaveLength(1);
      expect(helpers.finalizeCalls[0].outcome).toBe("gave_up");
    },
    120_000
  );
});
