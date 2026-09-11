import { describe, test, expect, mock } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";
import {
  adapterPath,
  FAKE_CLI,
  MockMcpServer,
  mockClaudeSdk,
} from "./helpers.js";

mockClaudeSdk();

describe("config and secrets", () => {
  test("OpenSession accepts valid reasoning_effort values", async () => {
    const capturedThinking: Record<string, any> = {};
    const makeQuery = (effort: string) => (opts: any) => ({
      async *[Symbol.asyncIterator]() {
        capturedThinking[effort] = opts.options?.thinking;
        yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
      },
      close() {},
      async interrupt() {},
    });

    for (const effort of ["none", "low", "medium", "high"]) {
      mock.module("@anthropic-ai/claude-agent-sdk", () => ({
        query: makeQuery(effort),
        createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
      }));

      const mod = await import(`${adapterPath}?${Date.now()}`);
      const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
      await host.start();
      await host.openSession({ config: { reasoning_effort: effort, claude_executable: FAKE_CLI } });
      await host.execute({ stepName: `effort-${effort}`, input: { prompt: "test" }, allowedOutcomes: ["success"] });
      await host.stop();
    }

    expect(capturedThinking["none"]).toEqual({ type: "disabled" });
    expect(capturedThinking["low"]).toEqual({ type: "enabled", budgetTokens: 4096 });
    expect(capturedThinking["medium"]).toEqual({ type: "enabled", budgetTokens: 16384 });
    expect(capturedThinking["high"]).toEqual({ type: "enabled", budgetTokens: 65536 });
  });

  test("OpenSession rejects invalid reasoning_effort", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await expect(
      host.openSession({ config: { reasoning_effort: "xhigh", claude_executable: FAKE_CLI } })
    ).rejects.toThrow(/Invalid reasoning_effort/);

    await host.stop();
  });

  test("OpenSession rejects invalid model values", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await expect(
      host.openSession({ config: { model: "   ", claude_executable: FAKE_CLI } })
    ).rejects.toThrow(/Invalid model/);

    await expect(
      host.openSession({ config: { model: "claude sonnet", claude_executable: FAKE_CLI } })
    ).rejects.toThrow(/Invalid model/);

    await host.stop();
  });

  test("OpenSession trims and accepts valid model", async () => {
    let capturedModel: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedModel = opts.options?.model;
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

    await host.openSession({ config: { model: "  claude-sonnet-4-6  ", claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "model-trim", input: { prompt: "test" }, allowedOutcomes: ["success"] });

    expect(capturedModel).toBe("claude-sonnet-4-6");
    await host.stop();
  });

  test("OpenSession accepts documented Ollama model names with colons and slashes", async () => {
    const capturedModels: string[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedModels.push(opts.options?.model);
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

    // AGENTS.md documents Ollama mode with model identifiers such as "kimi-k2.7-code:cloud".
    await host.openSession({ config: { model: "kimi-k2.7-code:cloud", claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "ollama-model", input: { prompt: "test" }, allowedOutcomes: ["success"] });

    // Per-step overrides must also accept the colon/slash form.
    await host.execute({
      stepName: "ollama-override",
      input: { prompt: "test", model: "library/kimi-k2.7-code:cloud" },
      allowedOutcomes: ["success"],
    });

    expect(capturedModels).toEqual(["kimi-k2.7-code:cloud", "library/kimi-k2.7-code:cloud"]);
    await host.stop();
  });

  test("per-step model override takes precedence over config model", async () => {
    const capturedModels: string[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedModels.push(opts.options?.model);
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

    await host.openSession({ config: { model: "config-model", claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "config-model-step", input: { prompt: "test" }, allowedOutcomes: ["success"] });
    await host.execute({
      stepName: "step-override",
      input: { prompt: "test", model: "step-model" },
      allowedOutcomes: ["success"],
    });

    expect(capturedModels).toEqual(["config-model", "step-model"]);
    await host.stop();
  });

  test("legacy thinking true maps to reasoning_effort high", async () => {
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

    await host.openSession({ config: { thinking: true, claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "legacy-thinking", input: { prompt: "test" }, allowedOutcomes: ["success"] });

    expect(capturedThinking).toEqual({ type: "enabled", budgetTokens: 65536 });
    await host.stop();
  });

  test("legacy thinking false maps to reasoning_effort none", async () => {
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

    await host.openSession({ config: { thinking: false, claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "legacy-thinking-false", input: { prompt: "test" }, allowedOutcomes: ["success"] });

    expect(capturedThinking).toEqual({ type: "disabled" });
    await host.stop();
  });

  test("reasoning_effort takes precedence over legacy thinking", async () => {
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

    await host.openSession({ config: { reasoning_effort: "low", thinking: true, claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "effort-wins", input: { prompt: "test" }, allowedOutcomes: ["success"] });

    expect(capturedThinking).toEqual({ type: "enabled", budgetTokens: 4096 });
    await host.stop();
  });

  test("per-step cwd input overrides config-level cwd", async () => {
    let capturedCwd: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedCwd = opts.options?.cwd;
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

    await host.openSession({ config: { cwd: "/session-level-cwd", claude_executable: FAKE_CLI } });
    await host.execute({
      stepName: "cwd-override-step",
      input: { prompt: "test", cwd: "/step-level-cwd" },
      allowedOutcomes: ["success"],
    });

    expect(capturedCwd).toBe("/step-level-cwd");
    await host.stop();
  });

  test("config-level cwd is used when input does not override", async () => {
    let capturedCwd: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedCwd = opts.options?.cwd;
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

    await host.openSession({ config: { cwd: "/config-cwd", claude_executable: FAKE_CLI } });
    await host.execute({
      stepName: "config-cwd-step",
      input: { prompt: "test" },
      allowedOutcomes: ["success"],
    });

    expect(capturedCwd).toBe("/config-cwd");
    await host.stop();
  });

  test("base_url config is forwarded to the subprocess env", async () => {
    let capturedEnv: Record<string, string> | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedEnv = opts.options?.env;
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

    await host.openSession({
      config: { base_url: "https://config.example/v1", claude_executable: FAKE_CLI },
    });
    await host.execute({
      stepName: "base-url-config",
      input: { prompt: "test" },
      allowedOutcomes: ["success"],
    });

    expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe("https://config.example/v1");
    await host.stop();
  });

  test("base_url falls back to the ANTHROPIC_BASE_URL environment variable", async () => {
    let capturedEnv: Record<string, string> | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedEnv = opts.options?.env;
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://env.example/v1";
    try {
      const mod = await import(`${adapterPath}?${Date.now()}`);
      const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
      await host.start();

      await host.openSession({ config: { claude_executable: FAKE_CLI } });
      await host.execute({
        stepName: "base-url-env",
        input: { prompt: "test" },
        allowedOutcomes: ["success"],
      });

      expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe("https://env.example/v1");
      await host.stop();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous;
    }
  });

  test("ANTHROPIC_API_KEY is not required to open a session", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    // No secrets provisioned — the adapter must still open and run, leaving
    // auth to the Claude Code CLI's own credential store.
    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "no-api-key",
      input: { prompt: "test" },
      allowedOutcomes: ["success"],
    });

    expect(["success", "failure", "needs_review"]).toContain(result.outcome);
    await host.stop();
  });

  test("secrets provided to OpenSession are forwarded to the subprocess env", async () => {
    let capturedEnv: Record<string, string> | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedEnv = opts.options?.env;
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

    await host.openSession({
      config: { claude_executable: FAKE_CLI },
      secrets: {
        ANTHROPIC_API_KEY: "sk-ant-api03-test-key",
        ANTHROPIC_AUTH_TOKEN: "sk-ant-auth03-test-token",
      },
    });
    await host.execute({
      stepName: "secrets-forwarded",
      input: { prompt: "test" },
      allowedOutcomes: ["success"],
    });

    expect(capturedEnv?.ANTHROPIC_API_KEY).toBe("sk-ant-api03-test-key");
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-auth03-test-token");
    await host.stop();
  });

  test("subprocess env only receives the declared passthrough set, not arbitrary host env", async () => {
    let capturedEnv: Record<string, string> | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          capturedEnv = opts.options?.env;
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const previousSecret = process.env.SOME_RANDOM_HOST_SECRET;
    process.env.SOME_RANDOM_HOST_SECRET = "should-not-leak";
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/test";
    try {
      const mod = await import(`${adapterPath}?${Date.now()}`);
      const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
      await host.start();

      await host.openSession({ config: { claude_executable: FAKE_CLI } });
      await host.execute({
        stepName: "env-passthrough",
        input: { prompt: "test" },
        allowedOutcomes: ["success"],
      });

      expect(capturedEnv?.PATH).toBe("/usr/bin");
      expect(capturedEnv?.HOME).toBe("/home/test");
      expect(capturedEnv).not.toHaveProperty("SOME_RANDOM_HOST_SECRET");
      expect(capturedEnv?.CLAUDE_AGENT_SDK_CLIENT_APP).toContain("criteria-adapter-claude-agent");
      await host.stop();
    } finally {
      if (previousSecret === undefined) delete process.env.SOME_RANDOM_HOST_SECRET;
      else process.env.SOME_RANDOM_HOST_SECRET = previousSecret;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("configured claude_executable is used by the SDK", async () => {
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
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "exec", input: { prompt: "test" }, allowedOutcomes: ["success"] });

    expect(resolvedExecutable).toBe(FAKE_CLI);
    await host.stop();
  });

  test("execute rejects a non-executable claude_executable configured at openSession", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await host.openSession({ config: { claude_executable: "/nonexistent/claude" } });
    let caught: any;
    try {
      await host.execute({ stepName: "bad-exec", input: { prompt: "test" }, allowedOutcomes: ["success"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/is not an executable file/);

    await host.stop();
  });

  test("system_prompt config is appended to the SDK system prompt", async () => {
    let capturedAppend: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
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

    await host.openSession({ config: { system_prompt: "You are a helpful assistant.", claude_executable: FAKE_CLI } });
    await host.execute({ stepName: "system-prompt", input: { prompt: "test" }, allowedOutcomes: ["success"] });

    expect(capturedAppend).toContain("You are a helpful assistant.");
    expect(capturedAppend).toContain("submit_outcome");
    await host.stop();
  });

  test("OpenSession rejects invalid step_timeout_ms", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig, autoGrantPermissions: true });
    await host.start();

    await expect(
      host.openSession({ config: { step_timeout_ms: -1, claude_executable: FAKE_CLI } })
    ).rejects.toThrow(/Invalid timeout/);

    await host.stop();
  });

  test("per-step timeout_ms overrides config step_timeout_ms", async () => {
    let seenTimeoutValue: number | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const abortController = opts.options?.abortController as AbortController | undefined;
          // Record how long until the abort fires. The adapter sets the timer from
          // the effective timeout value.
          seenTimeoutValue = 50;
          await new Promise<void>((_, reject) => {
            if (abortController?.signal.aborted) {
              reject(new Error("Aborted"));
              return;
            }
            abortController?.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
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

    await host.openSession({ config: { step_timeout_ms: 5000, claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "timeout-override",
      input: { prompt: "test", timeout_ms: 50 },
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("failure");
    expect(result.reason).toMatch(/timed out|timeout/i);
    await host.stop();
  });
});
