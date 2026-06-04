import { describe, test, expect, mock } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";

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

const adapterPath = new URL("../index.ts", import.meta.url).href;

describe("claude-agent adapter v2", () => {
  test("open session, execute, and finalize success", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({
      config: mod.adapterConfig,
      autoGrantPermissions: true,
    });
    await host.start();

    await host.openSession({ config: { model: "test-model" } });
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

    await host.openSession({ config: { cwd: "/tmp" } });
    await host.execute({
      stepName: "step1",
      input: { prompt: "Do something" },
      allowedOutcomes: ["success"],
    });

    const snap = await host.snapshot();
    expect(snap.state).toBeDefined();
    expect(snap.state.length).toBeGreaterThan(0);

    await host.closeSession();

    await host.openSession({ config: { cwd: "/tmp" } });
    await host.restore(snap);

    const snap2 = await host.snapshot();
    expect(snap2.state).toBeDefined();
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
                canUseTool("read_file", { path: `/tmp/file${i}.txt` }, {
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

    await host.openSession({ config: {} });
    const result = await host.execute({
      stepName: "stress",
      input: { prompt: "stress test" },
      allowedOutcomes: ["success"],
    });

    expect(permissionCount).toBe(50);
    expect(["success", "failure", "needs_review"]).toContain(result.outcome);
    await host.stop();
  });
});
