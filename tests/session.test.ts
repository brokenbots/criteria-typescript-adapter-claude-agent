import { describe, test, expect, mock } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";
import {
  adapterPath,
  FAKE_CLI,
  MockMcpServer,
  mockClaudeSdk,
} from "./helpers.js";

mockClaudeSdk();

describe("session management", () => {
  test("OpenSession/Execute/CloseSession lifecycle completes without errors", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
    await host.start();

    await host.openSession({ config: { model: "test-model", claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "test-step",
      input: { prompt: "Hello" },
      allowedOutcomes: ["success", "failure"],
    });
    expect(["success", "failure", "needs_review"].includes(result.outcome)).toBe(true);

    await host.closeSession();
    await host.stop();
  });

  test("snapshot and restore preserve session state", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
    await host.start();

    await host.openSession({ config: { cwd: "/tmp", claude_executable: FAKE_CLI } });
    await host.execute({
      stepName: "step1",
      input: { prompt: "Do something" },
      allowedOutcomes: ["success"],
    });

    const snap = await host.snapshot();
    expect(snap.state).toBeDefined();
    expect(snap.state.length).toBeGreaterThan(0);

    await host.closeSession();

    await host.openSession({ config: { cwd: "/tmp", claude_executable: FAKE_CLI } });
    await host.restore(snap);

    const snap2 = await host.snapshot();
    expect(snap2.state).toBeDefined();
    await host.stop();
  });

  test("snapshot and restore preserve claude_executable", async () => {
    let resolvedExecutable: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          resolvedExecutable = opts.options?.pathToClaudeCodeExecutable;
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
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
    await host.execute({
      stepName: "seed",
      input: { prompt: "seed" },
      allowedOutcomes: ["success"],
    });

    const snap = await host.snapshot();
    await host.closeSession();

    // Restore into a session that did NOT receive claude_executable via config,
    // so the only source of the path is the snapshot blob.
    await host.openSession({ config: {} });
    await host.restore(snap);
    await host.execute({
      stepName: "restored",
      input: { prompt: "restored" },
      allowedOutcomes: ["success"],
    });

    expect(resolvedExecutable).toBe(FAKE_CLI);
    await host.stop();
  });

  test("session persists cwd and model across execute calls", async () => {
    const captured: { cwd?: string; model?: string }[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          captured.push({ cwd: opts.options?.cwd, model: opts.options?.model });
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
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

    await host.openSession({ config: { cwd: "/session-cwd", model: "session-model", claude_executable: FAKE_CLI } });

    await host.execute({ stepName: "step-1", input: { prompt: "first" }, allowedOutcomes: ["success"] });
    await host.execute({ stepName: "step-2", input: { prompt: "second" }, allowedOutcomes: ["success"] });

    expect(captured.length).toBe(2);
    expect(captured[0].cwd).toBe("/session-cwd");
    expect(captured[0].model).toBe("session-model");
    expect(captured[1].cwd).toBe("/session-cwd");
    expect(captured[1].model).toBe("session-model");
    await host.stop();
  });

  test("snapshot and restore preserve cwd and model", async () => {
    const captured: { cwd?: string; model?: string }[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          captured.push({ cwd: opts.options?.cwd, model: opts.options?.model });
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
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

    await host.openSession({ config: { cwd: "/snap-cwd", model: "snap-model", claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "before", input: { prompt: "before" }, allowedOutcomes: ["success"] });

    const snap = await host.snapshot();
    await host.closeSession();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    await host.restore(snap);
    await host.execute({ stepName: "after", input: { prompt: "after" }, allowedOutcomes: ["success"] });

    expect(captured[1].cwd).toBe("/snap-cwd");
    expect(captured[1].model).toBe("snap-model");
    await host.stop();
  });

  test("snapshot and restore preserve reasoning_effort", async () => {
    let capturedThinking: any;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedThinking = opts.options?.thinking;
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

    await host.openSession({ config: { reasoning_effort: "medium", claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "before-snap", input: { prompt: "test" }, allowedOutcomes: ["success"] });
    expect(capturedThinking).toEqual({ type: "enabled", budgetTokens: 16384 });

    const snap = await host.snapshot();
    await host.closeSession();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    await host.restore(snap);
    await host.execute({ stepName: "after-restore", input: { prompt: "test" }, allowedOutcomes: ["success"] });
    expect(capturedThinking).toEqual({ type: "enabled", budgetTokens: 16384 });

    await host.stop();
  });

  test("legacy thinking boolean snapshot is migrated to reasoning_effort on restore", async () => {
    let capturedThinking: any;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedThinking = opts.options?.thinking;
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
    // Manually craft a v1 snapshot that only has the legacy `thinking` boolean.
    const legacySnapshot = {
      claudeSessionId: null,
      lastResultText: "",
      model: undefined,
      cwd: undefined,
      thinking: true,
      systemPromptAppend: undefined,
      baseUrl: undefined,
      claudeExecutable: FAKE_CLI,
      stepTimeoutMs: undefined,
    };
    await host.restore({ state: new TextEncoder().encode(JSON.stringify(legacySnapshot)), schemaVersion: 1 });

    await host.execute({ stepName: "migrated", input: { prompt: "test" }, allowedOutcomes: ["success"] });
    expect(capturedThinking).toEqual({ type: "enabled", budgetTokens: 65536 });

    await host.stop();
  });

  test("session resumes from persisted claudeSessionId across execute calls", async () => {
    const firstExecuteResumes: (string | undefined)[] = [];
    const secondExecuteResumes: (string | undefined)[] = [];
    let executeCount = 0;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          executeCount++;
          const isFirstExecute = executeCount <= 3; // initial + up to 2 reprompts
          const target = isFirstExecute ? firstExecuteResumes : secondExecuteResumes;
          target.push(opts.options?.resume);
          yield {
            type: "result",
            subtype: "success",
            result: "done",
            duration_ms: 10,
            num_turns: 1,
            total_cost_usd: 0,
            session_id: isFirstExecute && target.length === 1 ? "persisted-session" : undefined,
          };
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
    await host.execute({ stepName: "first", input: { prompt: "first" }, allowedOutcomes: ["success"] });
    await host.execute({ stepName: "second", input: { prompt: "second" }, allowedOutcomes: ["success"] });

    expect(firstExecuteResumes[0]).toBeUndefined();
    expect(firstExecuteResumes[1]).toBe("persisted-session");
    expect(secondExecuteResumes[0]).toBe("persisted-session");
    await host.stop();
  });
});
