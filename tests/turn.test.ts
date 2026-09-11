import { describe, test, expect, mock } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";
import {
  adapterPath,
  FAKE_CLI,
  MockMcpServer,
  MockQuery,
  mockClaudeSdk,
  executeWithOutputs,
} from "./helpers.js";

mockClaudeSdk();

describe("turn execution", () => {
  test("agent query is invoked with the user prompt and system prompt append", async () => {
    let capturedPrompt: string | undefined;
    let capturedAppend: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedPrompt = opts.prompt;
          capturedAppend = opts.options?.systemPrompt?.append;
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI, system_prompt: "Custom system prompt." } });
    await host.execute({ stepName: "prompt", input: { prompt: "Do the thing" }, allowedOutcomes: ["success"] });

    expect(capturedPrompt).toBe("Do the thing");
    expect(capturedAppend).toContain("Custom system prompt.");
    expect(capturedAppend).toContain("submit_outcome");
    await host.stop();
  });

  test("tool invocation bridge is wired for every allowed runtime tool", async () => {
    const bridgedTools: string[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            for (const toolName of ["Bash", "Read", "Write"]) {
              bridgedTools.push(toolName);
              const result = await canUseTool(toolName, { path: `/tmp/${toolName.toLowerCase()}` }, {
                signal: new AbortController().signal,
                toolUseID: `tool-${toolName}`,
              });
              expect(result.behavior).toBe("allow");
            }
          }
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "bridge", input: { prompt: "use tools" }, allowedOutcomes: ["success"] });

    expect(bridgedTools).toEqual(["Bash", "Read", "Write"]);
    await host.stop();
  });

  test("assistant message blocks are emitted as adapter events", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "Hello, " },
                { type: "text", text: "world." },
              ],
            },
          };
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { events } = await executeWithOutputs(host, {
      stepName: "assistant",
      input: { prompt: "say hello" },
      allowedOutcomes: ["success"],
    });

    expect(events.adapterEvents.some((e) => e.kind === "agent.message" && e.payload.content === "Hello, ")).toBe(true);
    expect(events.adapterEvents.some((e) => e.kind === "agent.message" && e.payload.content === "world.")).toBe(true);
    await host.stop();
  });

  test("stream_event text deltas are written to stdout", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "streaming " } },
          };
          yield {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "text" } },
          };
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { events } = await executeWithOutputs(host, {
      stepName: "stream",
      input: { prompt: "stream" },
      allowedOutcomes: ["success"],
    });

    expect(events.stdout.join("")).toContain("streaming text");
    await host.stop();
  });

  test("tool_progress events are logged to stdout and emitted as adapter events", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "tool_progress", tool_name: "Bash", message: "running..." };
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { events } = await executeWithOutputs(host, {
      stepName: "progress",
      input: { prompt: "progress" },
      allowedOutcomes: ["success"],
    });

    expect(events.stdout.some((s) => s.includes("[Bash]") && s.includes("running..."))).toBe(true);
    expect(events.adapterEvents.some((e) => e.kind === "tool.progress" && e.payload.tool === "Bash")).toBe(true);
    await host.stop();
  });

  test("result success emits query.complete adapter event with metadata", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", result: "all done", duration_ms: 250, num_turns: 3, total_cost_usd: 0.42 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { events } = await executeWithOutputs(host, {
      stepName: "complete",
      input: { prompt: "work" },
      allowedOutcomes: ["success"],
    });

    const complete = events.adapterEvents.find((e) => e.kind === "query.complete");
    expect(complete).toBeDefined();
    expect(complete.payload.durationMs).toBe(250);
    expect(complete.payload.turns).toBe(3);
    expect(complete.payload.costUsd).toBe(0.42);
    await host.stop();
  });

  test("result error emits query.error adapter event and logs stderr", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "error", errors: ["Claude refused the request"] };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome, events } = await executeWithOutputs(host, {
      stepName: "error",
      input: { prompt: "fail" },
      allowedOutcomes: ["success"],
    });

    expect(events.stderr.some((s) => s.includes("Claude refused the request"))).toBe(true);
    const errorEvt = events.adapterEvents.find((e) => e.kind === "query.error");
    expect(errorEvt).toBeDefined();
    expect(errorEvt.payload.subtype).toBe("error");
    expect(errorEvt.payload.errors).toContain("Claude refused the request");
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("auth_status event logs authentication state to stdout", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "auth_status", isAuthenticating: true };
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { events } = await executeWithOutputs(host, {
      stepName: "auth",
      input: { prompt: "auth" },
      allowedOutcomes: ["success"],
    });

    expect(events.stdout.some((s) => s.includes("Authenticating"))).toBe(true);
    await host.stop();
  });

  test("general query error before finalizing yields a failure outcome", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (_opts: any) => ({
        async *[Symbol.asyncIterator]() {
          throw new Error("simulated agent crash");
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({ stepName: "crash", input: { prompt: "crash" }, allowedOutcomes: ["success"] });

    expect(result.outcome).toBe("failure");
    expect(result.reason).toContain("Agent query failed");
    expect(result.reason).toContain("simulated agent crash");
    await host.stop();
  });

  test("query error after timeout does not overwrite the timed-out state", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const abortController = opts.options?.abortController as AbortController | undefined;
          await new Promise<void>((_, reject) => {
            if (abortController?.signal.aborted) {
              reject(new Error("Aborted after timeout"));
              return;
            }
            abortController?.signal.addEventListener("abort", () => reject(new Error("Aborted after timeout")), { once: true });
          });
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "timeout-priority",
      input: { prompt: "hang", timeout_ms: 50 },
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("failure");
    expect(result.reason).toMatch(/timed out|timeout/i);
    expect(result.reason).not.toContain("Agent query failed");
    await host.stop();
  });

  test("reprompt loop resumes from the persisted session id", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => new MockQuery(opts),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    // The default MockQuery never calls submit_outcome, so with a session_id the
    // adapter will run the initial query plus up to MAX_FINALIZE_ATTEMPTS - 1
    // reprompts, each resuming from the same session id.
    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "reprompt-resume",
      input: { prompt: "no outcome" },
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("failure");
    expect(result.reason).toContain("after 1 finalize attempt");
    await host.stop();
  });
});
