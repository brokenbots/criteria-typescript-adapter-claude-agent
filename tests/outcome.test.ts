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
import { TestHost } from "@criteria/adapter-sdk/testing";
import {
  adapterPath,
  FAKE_CLI,
  executeWithOutputs,
  MockMcpServer,
  MockQueryWithOutcome,
  MockQueryWithOutcomeAndSession,
  MockQueryHangs,
  MockQueryNoOutcome,
} from "./helpers.js";

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

describe("outcome integration", () => {
  test("declared output_schema keys match emitted outputs when agent submits outcome", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQueryWithOutcome(opts, "success", "Task completed successfully."),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome, outputs } = await executeWithOutputs(host, {
      stepName: "submit-outcome-outputs",
      input: { prompt: "Do the thing" },
      allowedOutcomes: ["success", "failure"],
    });

    expect(outcome).toBe("success");
    expect(Object.keys(outputs).sort()).toEqual(Object.keys(mod.adapterConfig.output_schema.fields).sort());
    expect(outputs.reason).toBe("Task completed successfully.");
    await host.stop();
  });

  test("declared output_schema keys match emitted outputs on fallback path", async () => {
    // The default MockQuery never calls submit_outcome, so the adapter takes
    // the fallback path after re-prompting.
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool, allowedTools } = opts.options || {};
          if (canUseTool && allowedTools) {
            for (const tool of allowedTools) {
              const parts = tool.split("__");
              const toolName = parts[parts.length - 1];
              if (toolName === "submit_outcome") continue;
              await canUseTool(toolName, {}, {
                signal: new AbortController().signal,
                toolUseID: `tool-${toolName}`,
              });
            }
          }
          yield { type: "result", subtype: "success", result: "done", duration_ms: 100, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome, outputs } = await executeWithOutputs(host, {
      stepName: "fallback-outputs",
      input: { prompt: "Do the thing" },
      allowedOutcomes: ["success", "failure"],
    });

    expect(["failure", "needs_review"]).toContain(outcome);
    expect(Object.keys(outputs).sort()).toEqual(Object.keys(mod.adapterConfig.output_schema.fields).sort());
    expect(outputs.reason).toContain("Agent completed without submitting a valid outcome");
    expect(outputs.reason).toContain("missing finalize");
    // No session_id is produced by the default MockQuery, so no reprompt turns occur.
    expect(outputs.reason).toContain("after 1 finalize attempt");
    await host.stop();
  });

  test("declared output_schema types match emitted types", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQueryWithOutcome(opts, "success", "Typed reason value"),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outputs } = await executeWithOutputs(host, {
      stepName: "type-check-outputs",
      input: { prompt: "Do the thing" },
      allowedOutcomes: ["success", "failure"],
    });

    const declaredType = mod.adapterConfig.output_schema.fields.reason?.type;
    expect(declaredType).toBe("string");
    expect(typeof outputs.reason).toBe("string");
    await host.stop();
  });

  test("adapter does not declare outcome as a step output", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    expect(mod.adapterConfig.output_schema.fields).not.toHaveProperty("outcome");
  });

  test("reason output is declared and not marked sensitive", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const reasonField = mod.adapterConfig.output_schema.fields.reason;
    expect(reasonField).toBeDefined();
    expect(reasonField.type).toBe("string");
    expect(reasonField.sensitive).toBeFalsy();
  });

  test("held secret echoed into reason is redacted to a placeholder", async () => {
    const secretApiKey = "sk-ant-api03-held-secret-12345";
    const secretAuthToken = "sk-ant-auth03-held-secret-67890";
    const rawReason = `I used key ${secretApiKey} and token ${secretAuthToken} during my work.`;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQueryWithOutcome(opts, "success", rawReason),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
    await host.start();

    await host.openSession({
      config: { claude_executable: FAKE_CLI },
      secrets: {
        ANTHROPIC_API_KEY: secretApiKey,
        ANTHROPIC_AUTH_TOKEN: secretAuthToken,
      },
    });
    const { outcome, outputs } = await executeWithOutputs(host, {
      stepName: "redact-secrets",
      input: { prompt: "Do the thing" },
      allowedOutcomes: ["success", "failure"],
    });

    expect(outcome).toBe("success");
    expect(outputs.reason).not.toContain(secretApiKey);
    expect(outputs.reason).not.toContain(secretAuthToken);
    expect(outputs.reason).toContain("[REDACTED]");
    expect(outputs.reason).toBe(
      "I used key [REDACTED] and token [REDACTED] during my work."
    );
    await host.stop();
  });

  test("reason is passed through unchanged when it contains no held secret", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQueryWithOutcome(opts, "success", "Task completed successfully."),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
    await host.start();

    await host.openSession({
      config: { claude_executable: FAKE_CLI },
      secrets: {
        ANTHROPIC_API_KEY: "a-different-secret-value",
      },
    });
    const { outcome, outputs } = await executeWithOutputs(host, {
      stepName: "passthrough-reason",
      input: { prompt: "Do the thing" },
      allowedOutcomes: ["success", "failure"],
    });

    expect(outcome).toBe("success");
    expect(outputs.reason).toBe("Task completed successfully.");
    await host.stop();
  });

  test("invalid submitted outcome is rejected and falls back to failure after max attempts", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQueryWithOutcomeAndSession(opts, "not_allowed", "I picked this"),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "invalid-outcome",
      input: { prompt: "test" },
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("failure");
    expect(result.reason).toContain("invalid outcome");
    expect(result.reason).toContain("after 3 finalize attempt(s)");
    await host.stop();
  });

  test("timeout emits failure outcome when step exceeds timeout_ms", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQueryHangs(opts),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "timeout",
      input: { prompt: "test", timeout_ms: 50 },
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("failure");
    expect(result.reason).toMatch(/timed out|timeout/i);
    await host.stop();
  });

  test("timeout returns needs_review when it is an allowed outcome", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQueryHangs(opts),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "timeout-review",
      input: { prompt: "test", timeout_ms: 50 },
      allowedOutcomes: ["success", "needs_review"],
    });

    expect(result.outcome).toBe("needs_review");
    expect(result.reason).toMatch(/timed out|timeout/i);
    await host.stop();
  });

  test("max attempts exhausted emits fallback failure outcome", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQueryNoOutcome(opts),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "no-outcome",
      input: { prompt: "test" },
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("failure");
    expect(result.reason).toContain("missing finalize");
    expect(result.reason).toContain("after 3 finalize attempt(s)");
    await host.stop();
  });

  test("no declared allowed outcomes disables finalization via submit_outcome", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQueryWithOutcomeAndSession(opts, "success", "No outcomes"),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "no-outcomes",
      input: { prompt: "test" },
      allowedOutcomes: [],
    });

    expect(result.outcome).toBe("failure");
    expect(result.reason).toContain("step has no declared outcomes");
    expect(result.reason).toContain("after 1 finalize attempt");
    await host.stop();
  });
});
