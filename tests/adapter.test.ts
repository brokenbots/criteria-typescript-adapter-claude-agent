import { describe, test, expect, mock } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";
// Avoid package-name resolution games for the deep import by using a file URL.
import { fromProtoStruct } from "../node_modules/@criteria/adapter-sdk/dist/plugin/server-v2.js";

// Mock the claude-agent-sdk so we don't need the real CLI binary
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => new MockQuery(opts),
  createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
}));

class MockQuery implements AsyncIterable<any> {
  private opts: any;
  constructor(opts: any) {
    this.opts = opts;
  }

  async *[Symbol.asyncIterator]() {
    const { canUseTool, allowedTools } = this.opts.options || {};
    if (canUseTool && allowedTools) {
      for (const tool of allowedTools) {
        const parts = tool.split("__");
        const toolName = parts[parts.length - 1];
        if (toolName === "submit_outcome") continue;
        const result = await canUseTool(toolName, {}, {
          signal: new AbortController().signal,
          toolUseID: `tool-${toolName}`,
        });
        yield { type: "tool_progress", tool_name: toolName, message: "done" };
      }
    }
    yield { type: "result", subtype: "success", result: "done", duration_ms: 100, num_turns: 1, total_cost_usd: 0 };
  }

  close() {}
  async interrupt() {}
}

class MockMcpServer {
  name: string;
  tools: any[];
  constructor(opts: any) {
    this.name = opts.name;
    this.tools = opts.tools || [];
  }
}

/**
 * Simulates an agent run that calls `submit_outcome` with the given outcome and
 * reason. The real SDK would invoke the MCP tool internally; this mock looks up
 * the tool in the supplied MCP server and calls its handler directly, which is
 * exactly what the adapter observes.
 */
class MockQueryWithOutcome implements AsyncIterable<any> {
  private opts: any;
  private outcome: string;
  private reason: string;

  constructor(opts: any, outcome: string, reason: string) {
    this.opts = opts;
    this.outcome = outcome;
    this.reason = reason;
  }

  async *[Symbol.asyncIterator]() {
    const { mcpServers, allowedTools } = this.opts.options || {};
    if (mcpServers && allowedTools) {
      for (const toolRef of allowedTools) {
        const parts = toolRef.split("__");
        const toolName = parts[parts.length - 1];
        if (toolName !== "submit_outcome") continue;

        const serverName = Object.keys(mcpServers)[0];
        const server = mcpServers[serverName];
        const tool = server?.tools?.find((t: any) => t.name === "submit_outcome");
        if (tool?.handler) {
          await tool.handler({ outcome: this.outcome, reason: this.reason });
        }
      }
    }
    yield { type: "result", subtype: "success", result: "done", duration_ms: 100, num_turns: 1, total_cost_usd: 0 };
  }

  close() {}
  async interrupt() {}
}

/**
 * Execute a step through a TestHost and return the full outputs map exposed by
 * the wire result event. TestHost only exposes `reason` on its friendly return
 * value, so we talk to the underlying gRPC client to capture the exact key set.
 */
async function executeWithOutputs(
  host: TestHost,
  opts: {
    stepName: string;
    input?: Record<string, unknown>;
    allowedOutcomes?: string[];
  }
): Promise<{ outcome: string; outputs: Record<string, string> }> {
  const client = (host as any).client;
  const sessionId = (host as any).sessionId;
  const autoGrant = (host as any)._autoGrantPermissions ?? false;
  const delayMs = (host as any)._permissionDelayMs ?? 0;
  if (!client || !sessionId) throw new Error("Host not started or session not open");

  const permStream = (host as any)._permStream ?? (client as any).Permissions();
  (host as any)._permStream = permStream;

  const result: any = await new Promise((resolve, reject) => {
    let resolved = false;
    const execStream = (client as any).Execute({
      sessionId,
      stepName: opts.stepName,
      input: opts.input ?? {},
      allowedOutcomes: opts.allowedOutcomes ?? [],
    });

    execStream.on("data", (evt: any) => {
      if (resolved) return;
      if (evt.result) {
        resolved = true;
        resolve(evt.result);
        return;
      }
      const adapterEvt = evt.adapter as Record<string, unknown> | undefined;
      if (adapterEvt?.eventKind === "permission.request") {
        const payload = adapterEvt.payload as Record<string, any> | undefined;
        const reqId =
          (payload?.fields?.request_id?.stringValue as string | undefined) ??
          (payload?.fields?.requestId?.stringValue as string | undefined);
        if (reqId && autoGrant) {
          if (delayMs > 0) {
            setTimeout(() => permStream.write({ request: { requestId: reqId } }), delayMs);
          } else {
            permStream.write({ request: { requestId: reqId } });
          }
        }
      }
    });

    execStream.on("error", (err: any) => {
      if (!resolved) reject(err);
    });
    execStream.on("end", () => {
      if (!resolved) reject(new Error("Execute stream ended without result"));
    });
    permStream.on("data", () => {});
    permStream.on("error", () => {});
  });

  // The SDK's ExecuteResult carries outputs in either the legacy
  // map<string,string> `outputs` field (pre v2 typed-outputs cutover) or the
  // JSON-encoded `outputsJson` bytes field (post cutover). Read both so this
  // helper works against either SDK revision — the SDK on the
  // chore/publish-github-packages branch still uses `outputs`, while the SDK
  // on `main` (used by CI) uses `outputsJson`.
  let outputs: Record<string, unknown> = {};
  if (result.outputs && Object.keys(result.outputs).length > 0) {
    outputs = result.outputs;
  } else if (result.outputsJson) {
    const buf = Buffer.isBuffer(result.outputsJson)
      ? result.outputsJson
      : Buffer.from(result.outputsJson);
    try {
      outputs = JSON.parse(buf.toString("utf8"));
    } catch {
      outputs = {};
    }
  }

  return { outcome: result.outcome ?? "", outputs: outputs as Record<string, string> };
}

/**
 * Execute a step through a TestHost without auto-granting permissions. The
 * caller receives the snake_case request_id from each permission.request event
 * and the Permissions stream so it can manually grant or deny.
 */
async function executeWithManualPermission(
  host: TestHost,
  opts: {
    stepName: string;
    input?: Record<string, unknown>;
    allowedOutcomes?: string[];
    onRequest: (requestId: string, permStream: any, payload: Record<string, any>) => void;
  }
): Promise<{ outcome: string; outputs: Record<string, string> }> {
  const client = (host as any).client;
  const sessionId = (host as any).sessionId;
  if (!client || !sessionId) throw new Error("Host not started or session not open");

  const permStream = (host as any)._permStream ?? (client as any).Permissions();
  (host as any)._permStream = permStream;

  const result: any = await new Promise((resolve, reject) => {
    let resolved = false;
    const execStream = (client as any).Execute({
      sessionId,
      stepName: opts.stepName,
      input: opts.input ?? {},
      allowedOutcomes: opts.allowedOutcomes ?? [],
    });

    execStream.on("data", (evt: any) => {
      if (resolved) return;
      if (evt.result) {
        resolved = true;
        resolve(evt.result);
        return;
      }
      const adapterEvt = evt.adapter as Record<string, unknown> | undefined;
      if (adapterEvt?.eventKind === "permission.request") {
        const payload = adapterEvt.payload as Record<string, any> | undefined;
        const reqId = payload?.fields?.request_id?.stringValue as string | undefined;
        if (reqId) opts.onRequest(reqId, permStream, payload);
      }
    });

    execStream.on("error", (err: any) => {
      if (!resolved) reject(err);
    });
    execStream.on("end", () => {
      if (!resolved) reject(new Error("Execute stream ended without result"));
    });
    permStream.on("data", () => {});
    permStream.on("error", () => {});
  });

  let outputs: Record<string, unknown> = {};
  if (result.outputs && Object.keys(result.outputs).length > 0) {
    outputs = result.outputs;
  } else if (result.outputsJson) {
    const buf = Buffer.isBuffer(result.outputsJson)
      ? result.outputsJson
      : Buffer.from(result.outputsJson);
    try {
      outputs = JSON.parse(buf.toString("utf8"));
    } catch {
      outputs = {};
    }
  }

  return { outcome: result.outcome ?? "", outputs: outputs as Record<string, string> };
}

const adapterPath = new URL("../index.ts", import.meta.url).href;

// The adapter resolves the Claude Code CLI up front and refuses to run without
// it. These tests mock the agent SDK so nothing is actually spawned, but the
// resolution still runs — point it at an executable that always exists.
const FAKE_CLI = process.execPath;

describe("claude-agent adapter v2", () => {
  test("open session, execute, and finalize success", async () => {
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
    // openSession normally seeds claudeExecutable from config, but restore
    // does not re-run openSession — the path must survive in the blob or the
    // adapter silently falls back to a PATH lookup.
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
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
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
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
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
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
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
      const host = new TestHost({
        config: mod.adapterConfig,
        autoGrantPermissions: true,
      });
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
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
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

  test("concurrent permission stress test — 50 parallel requests", async () => {
    let permissionCount = 0;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            const promises = [];
            for (let i = 0; i < 50; i++) {
              promises.push(
                canUseTool("Read", { path: `/tmp/file${i}.txt` }, {
                  signal: new AbortController().signal,
                  toolUseID: `tool-${i}`,
                })
              );
            }
            const results = await Promise.all(promises);
            for (const r of results) {
              permissionCount++;
              expect(r.behavior).toBe("allow");
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
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
      permissionDelayMs: 5,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "stress",
      input: { prompt: "stress test" },
      allowedOutcomes: ["success"],
    });

    expect(permissionCount).toBe(50);
    expect(["success", "failure", "needs_review"]).toContain(result.outcome);
    await host.stop();
  });

  test("permission.request event payload includes non-empty snake_case request_id matching internal id", async () => {
    let capturedSnake: string | undefined;
    let capturedCamel: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            const result = await canUseTool("Bash", { command: "git --version" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-1",
            });
            expect(result.behavior).toBe("allow");
          }
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
      autoGrantPermissions: false,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome } = await executeWithManualPermission(host, {
      stepName: "request-id-check",
      input: { prompt: "run git" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream, payload) => {
        capturedSnake = reqId;
        capturedCamel = payload?.fields?.requestId?.stringValue as string | undefined;
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedSnake).toBeDefined();
    expect(capturedSnake?.length).toBeGreaterThan(0);
    expect(capturedCamel).toBe(capturedSnake);
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-31: permission.request payload forwards full_command_text for Bash command", async () => {
    const commandText = "echo matched > /tmp/cri31-proof/PROOF.txt";
    let capturedPayload: Record<string, any> | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            const result = await canUseTool("Bash", { command: commandText }, {
              signal: new AbortController().signal,
              toolUseID: "tool-cri31",
            });
            expect(result.behavior).toBe("allow");
          }
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
      autoGrantPermissions: false,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome } = await executeWithManualPermission(host, {
      stepName: "cri31-fingerprint",
      input: { prompt: "run command" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream, payload) => {
        capturedPayload = payload ? fromProtoStruct(payload) : undefined;
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.tool).toBe("Bash");
    expect(capturedPayload?.full_command_text).toBe(commandText);
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-31: bare allow_tools = [\"Bash\"] still grants without fingerprint", async () => {
    let capturedBehavior: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            const result = await canUseTool("Bash", { command: "echo hello" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-bare",
            });
            capturedBehavior = result.behavior;
          }
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
      autoGrantPermissions: false,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome } = await executeWithManualPermission(host, {
      stepName: "cri31-bare-allow",
      input: { prompt: "run command" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream) => {
        // Grant without inspecting the payload, mirroring bare-tool-name policy.
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedBehavior).toBe("allow");
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-31: commands array is forwarded as a command fingerprint", async () => {
    const commands = ["echo one", "echo two"];
    let capturedPayload: Record<string, any> | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            const result = await canUseTool("Bash", { commands }, {
              signal: new AbortController().signal,
              toolUseID: "tool-commands",
            });
            expect(result.behavior).toBe("allow");
          }
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
      autoGrantPermissions: false,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome } = await executeWithManualPermission(host, {
      stepName: "cri31-commands",
      input: { prompt: "run commands" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream, payload) => {
        capturedPayload = payload ? fromProtoStruct(payload) : undefined;
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.tool).toBe("Bash");
    expect(capturedPayload?.commands).toEqual(commands);
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-31: non-command tools omit full_command_text and commands", async () => {
    let capturedPayload: Record<string, any> | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            const result = await canUseTool("Read", { path: "/tmp/readme.md" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-read",
            });
            expect(result.behavior).toBe("allow");
          }
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
      autoGrantPermissions: false,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome } = await executeWithManualPermission(host, {
      stepName: "cri31-non-command",
      input: { prompt: "read file" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream, payload) => {
        capturedPayload = payload ? fromProtoStruct(payload) : undefined;
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.tool).toBe("Read");
    expect(capturedPayload).not.toHaveProperty("full_command_text");
    expect(capturedPayload).not.toHaveProperty("commands");
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-32: declared permissions match runtime SDK tool names", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const declared = (mod.adapterConfig.permissions ?? []).map((p: any) =>
      typeof p === "string" ? p : p.name
    );
    expect(declared.sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    for (const oldName of ["read_file", "write_file", "edit_file", "run_command", "list_directory"]) {
      expect(declared).not.toContain(oldName);
    }

    const capturedTools: string[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            for (const tool of ["Read", "Bash", "Write", "Edit", "Glob", "Grep"]) {
              const result = await canUseTool(tool, { path: `/tmp/${tool.toLowerCase()}` }, {
                signal: new AbortController().signal,
                toolUseID: `tool-${tool}`,
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

    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: false,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome } = await executeWithManualPermission(host, {
      stepName: "cri32-declared-permissions",
      input: { prompt: "use all tools" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream, payload) => {
        const parsed = payload ? fromProtoStruct(payload) : undefined;
        if (typeof parsed?.tool === "string") capturedTools.push(parsed.tool);
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedTools.sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-32: allow_tools with a single declared name grants the matching runtime tool", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const declared = (mod.adapterConfig.permissions ?? []).map((p: any) =>
      typeof p === "string" ? p : p.name
    );

    for (const allowed of declared) {
      let requestedTool: string | undefined;

      mock.module("@anthropic-ai/claude-agent-sdk", () => ({
        query: (opts: any) => ({
          async *[Symbol.asyncIterator]() {
            const { canUseTool } = opts.options || {};
            if (canUseTool) {
              const result = await canUseTool(allowed, { path: "/tmp/x" }, {
                signal: new AbortController().signal,
                toolUseID: `tool-${allowed}`,
              });
              expect(result.behavior).toBe("allow");
            }
            yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
          },
          close() {},
          async interrupt() {},
        }),
        createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
      }));

      const host = new TestHost({
        config: mod.adapterConfig,
        autoGrantPermissions: false,
      });
      await host.start();
      await host.openSession({ config: { claude_executable: FAKE_CLI } });

      const { outcome } = await executeWithManualPermission(host, {
        stepName: `cri32-allow-${allowed}`,
        input: { prompt: `allow ${allowed}` },
        allowedOutcomes: ["success"],
        onRequest: (reqId, permStream, payload) => {
          const parsed = payload ? fromProtoStruct(payload) : undefined;
          requestedTool = parsed?.tool as string | undefined;
          if (requestedTool === allowed) {
            permStream.write({ request: { requestId: reqId } });
          } else {
            permStream.write({ cancel: { requestId: reqId, reason: "not in allow_tools" } });
          }
        },
      });

      expect(requestedTool).toBe(allowed);
      expect(["success", "failure", "needs_review"]).toContain(outcome);
      await host.stop();
    }
  });

  test("host permission.granted with matching request_id resolves to allow in under 1 second", async () => {
    let canUseToolStart = 0;
    let canUseToolEnd = 0;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            canUseToolStart = Date.now();
            const result = await canUseTool("Bash", { command: "git --version" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-1",
            });
            canUseToolEnd = Date.now();
            expect(result.behavior).toBe("allow");
          }
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
      autoGrantPermissions: false,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome } = await executeWithManualPermission(host, {
      stepName: "grant-latency",
      input: { prompt: "run git" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream) => {
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(canUseToolEnd).toBeGreaterThan(0);
    expect(canUseToolEnd - canUseToolStart).toBeLessThan(1000);
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("host permission.denied with matching request_id resolves to deny in under 1 second", async () => {
    let canUseToolStart = 0;
    let canUseToolEnd = 0;
    let capturedBehavior: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            canUseToolStart = Date.now();
            const result = await canUseTool("Bash", { command: "git --version" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-1",
            });
            canUseToolEnd = Date.now();
            capturedBehavior = result.behavior;
          }
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
      autoGrantPermissions: false,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const { outcome } = await executeWithManualPermission(host, {
      stepName: "deny-latency",
      input: { prompt: "run git" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream) => {
        permStream.write({ cancel: { requestId: reqId, reason: "denied by test" } });
      },
    });

    expect(canUseToolEnd).toBeGreaterThan(0);
    expect(canUseToolEnd - canUseToolStart).toBeLessThan(1000);
    expect(capturedBehavior).toBe("deny");
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

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
      query: (opts: any) => new MockQuery(opts),
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
    expect(outputs.reason).toContain("Agent completed without submitting an outcome");
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
});
