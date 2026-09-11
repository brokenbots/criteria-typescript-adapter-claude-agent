import { describe, test, expect, mock } from "bun:test";
import {
  SUBMIT_OUTCOME_TOOL_NAME,
  MAX_FINALIZE_ATTEMPTS,
  REDACTED_PLACEHOLDER,
  createOutcomeState,
  buildOutcomeMcpServer,
  buildOutcomeInstructions,
  buildRepromptPrompt,
  resolveOutcome,
  sanitizeReason,
} from "../outcome.js";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

class MockMcpServer {
  name: string;
  tools: any[];
  constructor(opts: any) {
    this.name = opts.name;
    this.tools = opts.tools || [];
  }
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
}));

function makeHelpers(): any {
  const events: any[] = [];
  return {
    log: {
      adapterEvent: async (kind: string, payload: any) => {
        events.push({ kind, payload });
      },
      stdout: async (_: string) => {},
      stderr: async (_: string) => {},
    },
    events,
  };
}

async function callSubmitOutcome(
  server: MockMcpServer,
  args: { outcome?: string; reason?: string }
): Promise<any> {
  const tool = server.tools.find((t: any) => t.name === SUBMIT_OUTCOME_TOOL_NAME);
  if (!tool) throw new Error("submit_outcome tool not found");
  return tool.handler(args);
}

describe("outcome module", () => {
  test("createOutcomeState returns an empty, unfinalized state", () => {
    const state = createOutcomeState();
    expect(state.finalized).toBe(false);
    expect(state.finalizedOutcome).toBeNull();
    expect(state.finalizedReason).toBe("");
    expect(state.finalizeAttempts).toBe(0);
    expect(state.finalizeFailureKind).toBe("");
    expect(state.timedOut).toBe(false);
    expect(state.error).toBeNull();
  });

  test("sanitizeReason redacts held secrets", () => {
    const secret = "sk-ant-api03-held-secret-12345";
    const reason = `I used ${secret} during my work.`;
    expect(sanitizeReason(reason, [secret])).toBe(`I used ${REDACTED_PLACEHOLDER} during my work.`);
  });

  test("sanitizeReason leaves unrelated text alone", () => {
    const reason = "Task completed successfully.";
    expect(sanitizeReason(reason, ["a-different-secret"])).toBe(reason);
  });

  test("buildOutcomeInstructions mentions allowed outcomes", () => {
    const instructions = buildOutcomeInstructions(["success", "failure"]);
    expect(instructions).toContain("submit_outcome");
    expect(instructions).toContain("success, failure");
  });

  test("buildOutcomeInstructions falls back when no outcomes are declared", () => {
    const instructions = buildOutcomeInstructions([]);
    expect(instructions).toContain("workflow system");
    expect(instructions).not.toContain("submit_outcome");
  });

  test("buildRepromptPrompt lists allowed outcomes", () => {
    const prompt = buildRepromptPrompt(["success", "failure"]);
    expect(prompt).toContain("submit_outcome");
    expect(prompt).toContain("success, failure");
  });

  test("buildOutcomeMcpServer registers submit_outcome tool", () => {
    const state = createOutcomeState();
    const server = buildOutcomeMcpServer({
      allowedOutcomes: ["success", "failure"],
      capture: state,
      heldSecrets: [],
      helpers: makeHelpers(),
    }) as MockMcpServer;

    expect(server.name).toBe("criteria-workflow");
    expect(server.tools.length).toBe(1);
    expect(server.tools[0].name).toBe(SUBMIT_OUTCOME_TOOL_NAME);
    expect(server.tools[0].inputSchema.outcome).toBeDefined();
  });

  test("submit_outcome records a valid outcome", async () => {
    const state = createOutcomeState();
    const helpers = makeHelpers();
    const server = buildOutcomeMcpServer({
      allowedOutcomes: ["success", "failure"],
      capture: state,
      heldSecrets: [],
      helpers,
    }) as MockMcpServer;

    const result = await callSubmitOutcome(server, { outcome: "success", reason: "Done" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('"success" recorded successfully');
    expect(state.finalized).toBe(true);
    expect(state.finalizedOutcome).toBe("success");
    expect(state.finalizedReason).toBe("Done");
    expect(state.finalizeAttempts).toBe(1);
    expect(helpers.events).toHaveLength(1);
    expect(helpers.events[0].kind).toBe("outcome.finalized");
  });

  test("submit_outcome rejects an outcome not in the allowed set", async () => {
    const state = createOutcomeState();
    const helpers = makeHelpers();
    const server = buildOutcomeMcpServer({
      allowedOutcomes: ["success", "failure"],
      capture: state,
      heldSecrets: [],
      helpers,
    }) as MockMcpServer;

    const result = await callSubmitOutcome(server, { outcome: "not_allowed", reason: "Oops" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"not_allowed" is not in the allowed set');
    expect(state.finalized).toBe(false);
    expect(state.finalizeFailureKind).toBe("invalid_outcome");
    expect(state.finalizeAttempts).toBe(1);
  });

  test("submit_outcome rejects a missing outcome", async () => {
    const state = createOutcomeState();
    const helpers = makeHelpers();
    const server = buildOutcomeMcpServer({
      allowedOutcomes: ["success", "failure"],
      capture: state,
      heldSecrets: [],
      helpers,
    }) as MockMcpServer;

    const result = await callSubmitOutcome(server, { reason: "No outcome" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Outcome is required");
    expect(state.finalized).toBe(false);
    expect(state.finalizeFailureKind).toBe("missing");
  });

  test("submit_outcome rejects a duplicate finalize", async () => {
    const state = createOutcomeState();
    const helpers = makeHelpers();
    const server = buildOutcomeMcpServer({
      allowedOutcomes: ["success", "failure"],
      capture: state,
      heldSecrets: [],
      helpers,
    }) as MockMcpServer;

    const first = await callSubmitOutcome(server, { outcome: "success" });
    expect(first.isError).toBeFalsy();

    const second = await callSubmitOutcome(server, { outcome: "failure" });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("already finalized");
    expect(state.finalizeFailureKind).toBe("duplicate");
    expect(state.finalizedOutcome).toBe("success");
  });

  test("submit_outcome reports no_outcomes when the step declares none", async () => {
    const state = createOutcomeState();
    const helpers = makeHelpers();
    const server = buildOutcomeMcpServer({
      allowedOutcomes: [],
      capture: state,
      heldSecrets: [],
      helpers,
    }) as MockMcpServer;

    const result = await callSubmitOutcome(server, { outcome: "success" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No outcomes are declared");
    expect(state.finalizeFailureKind).toBe("no_outcomes");
  });

  test("resolveOutcome returns a valid finalized outcome", async () => {
    const state = createOutcomeState();
    state.finalized = true;
    state.finalizedOutcome = "success";
    state.finalizedReason = "All good";

    const helpers = makeHelpers();
    const resolved = await resolveOutcome({
      state,
      allowedOutcomes: ["success", "failure"],
      attempts: 1,
      helpers,
      heldSecrets: [],
    });

    expect(resolved.outcome).toBe("success");
    expect(resolved.reason).toBe("All good");
  });

  test("resolveOutcome emits timeout and returns failure when timed out", async () => {
    const state = createOutcomeState();
    state.timedOut = true;

    const helpers = makeHelpers();
    const resolved = await resolveOutcome({
      state,
      allowedOutcomes: ["success", "failure"],
      attempts: 1,
      helpers,
      heldSecrets: [],
    });

    expect(resolved.outcome).toBe("failure");
    expect(resolved.reason).toContain("timed out");
    expect(helpers.events).toHaveLength(1);
    expect(helpers.events[0].kind).toBe("outcome.timeout");
  });

  test("resolveOutcome returns needs_review on timeout when allowed", async () => {
    const state = createOutcomeState();
    state.timedOut = true;

    const helpers = makeHelpers();
    const resolved = await resolveOutcome({
      state,
      allowedOutcomes: ["success", "needs_review"],
      attempts: 1,
      helpers,
      heldSecrets: [],
    });

    expect(resolved.outcome).toBe("needs_review");
  });

  test("resolveOutcome emits failure and returns failure after exhausted attempts", async () => {
    const state = createOutcomeState();
    state.finalizeFailureKind = "invalid_outcome";

    const helpers = makeHelpers();
    const resolved = await resolveOutcome({
      state,
      allowedOutcomes: ["success", "failure"],
      attempts: MAX_FINALIZE_ATTEMPTS,
      helpers,
      heldSecrets: [],
    });

    expect(resolved.outcome).toBe("failure");
    expect(resolved.reason).toContain("invalid outcome");
    expect(helpers.events).toHaveLength(1);
    expect(helpers.events[0].kind).toBe("outcome.failure");
    expect(helpers.events[0].payload.kind).toBe("invalid_outcome");
  });

  test("resolveOutcome returns needs_review on exhaustion when allowed", async () => {
    const state = createOutcomeState();

    const helpers = makeHelpers();
    const resolved = await resolveOutcome({
      state,
      allowedOutcomes: ["success", "needs_review"],
      attempts: MAX_FINALIZE_ATTEMPTS,
      helpers,
      heldSecrets: [],
    });

    expect(resolved.outcome).toBe("needs_review");
  });

  test("resolveOutcome emits failure for a general agent error", async () => {
    const state = createOutcomeState();
    state.error = new Error("the agent crashed");

    const helpers = makeHelpers();
    const resolved = await resolveOutcome({
      state,
      allowedOutcomes: ["success", "failure"],
      attempts: 1,
      helpers,
      heldSecrets: [],
    });

    expect(resolved.outcome).toBe("failure");
    expect(resolved.reason).toContain("Agent query failed");
    expect(resolved.reason).toContain("the agent crashed");
  });
});
