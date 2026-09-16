import { describe, test, expect, mock } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";
import type { ToolCallReplay } from "@criteria/adapter-sdk/testing";
import { ADAPTER_TOOL_TOOL_NAME, SUBMIT_OUTCOME_TOOL_NAME } from "../outcome.js";
import {
  adapterPath,
  FAKE_CLI,
  MockMcpServer,
  mockClaudeSdk,
} from "./helpers.js";

mockClaudeSdk();

/** Cheap per-test cache-busting: Date.now() collides within the same ms. */
let importCounter = 0;
const nextAdapterPath = () => `${adapterPath}?${Date.now()}-${importCounter++}`;

interface ReplaySpec {
  kind: "result" | "deny" | "bare_grant" | "silence";
  outcome?: string;
  outputs?: Record<string, unknown>;
  callError?: string;
  reason?: string;
}

interface CapturedToolCall {
  target?: string;
  args?: Record<string, unknown>;
  request_id?: string;
  kind?: string;
}

/**
 * Query factory whose agent turns: call the adapter_tool MCP tool (capturing
 * the returned MCP result), then finalize with submit_outcome. This mirrors
 * what the real CLI does: the agent decides to invoke the tool mid-turn.
 */
function makeAdapterToolQuery(opts: {
  target: string;
  args?: Record<string, unknown>;
  /**
   * When false the factory only captures the query options and finishes —
   * used by the registration test, which must not let the tool handler
   * block on a host reply (with no replay knob a bare-grant host waits out
   * the SDK's DefaultToolCallTimeout).
   */
  callTool?: boolean;
  /** Number of adapter_tool invocations (for the session-cache test). */
  times?: number;
}) {
  const captured: { toolResults: any[] } = { toolResults: [] };
  return {
    captured,
    factory: (queryOpts: any) => ({
      async *[Symbol.asyncIterator]() {
        const { mcpServers } = queryOpts.options || {};
        const serverName = Object.keys(mcpServers)[0];
        const server = mcpServers[serverName];
        const adapterTool = server?.tools?.find(
          (t: any) => t.name === ADAPTER_TOOL_TOOL_NAME
        );
        if (!adapterTool) throw new Error("adapter_tool tool not registered");

        if (opts.callTool !== false) {
          const times = opts.times ?? 1;
          for (let i = 0; i < times; i++) {
            captured.toolResults.push(
              await adapterTool.handler({
                target: opts.target,
                args: opts.args,
              })
            );
          }
        }

        const outcomeTool = server?.tools?.find(
          (t: any) => t.name === SUBMIT_OUTCOME_TOOL_NAME
        );
        await outcomeTool.handler({ outcome: "success", reason: "called adapter tool" });
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          duration_ms: 10,
          num_turns: 1,
          total_cost_usd: 0,
        };
      },
      close() {},
      async interrupt() {},
    }),
  };
}

async function runWithReplay(
  replay: ReplaySpec | undefined,
  opts: { callTool?: boolean; times?: number } = {}
) {
  const capturedToolCalls: CapturedToolCall[] = [];
  let capturedOptions: any;

  const spec: any = {
    target: "adapter.greet.hello.tools.greet",
    args: { name: "world" },
    callTool: opts.callTool,
    times: opts.times,
  };
  const built = makeAdapterToolQuery(spec);
  const replayKnob = replay
    ? (payload: CapturedToolCall) => {
        capturedToolCalls.push(payload);
        return replay as ToolCallReplay;
      }
    : undefined;

  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: (queryOpts: any) => {
      capturedOptions = queryOpts;
      return built.factory(queryOpts);
    },
    createSdkMcpServer: (serverOpts: any) => new MockMcpServer(serverOpts),
  }));

  const mod = await import(nextAdapterPath());
  const host = new TestHost({
    config: mod.adapterConfig,
    autoGrantPermissions: true,
    toolCallResult: replayKnob,
  });
  await host.start();
  await host.openSession({ config: { claude_executable: FAKE_CLI } });
  const result = await host.execute({
    stepName: "adapter-tool",
    input: { prompt: "call the other adapter's greet tool" },
    allowedOutcomes: ["success"],
  });
  await host.stop();
  return {
    result,
    toolResult: built.captured.toolResults[0],
    toolResults: built.captured.toolResults,
    replayPayloads: capturedToolCalls,
    options: capturedOptions,
    mod,
  };
}

describe("adapter_tool (CRI-180)", () => {
  test("registers the tool, advertises adapter_tools, and allows the mcp form", async () => {
    // No tool invocation here: with no replay knob the host bare-grants and
    // the SDK would wait out its DefaultToolCallTimeout. Registration only.
    const { options, mod } = await runWithReplay(undefined, { callTool: false });

    expect(options.options.allowedTools).toContain("mcp__criteria-workflow__adapter_tool");
    expect(options.options.allowedTools).toContain("mcp__criteria-workflow__submit_outcome");

    const serverNames = Object.keys(options.options.mcpServers);
    expect(serverNames).toEqual(["criteria-workflow"]);
    const toolNames = options.options.mcpServers["criteria-workflow"].tools.map(
      (t: any) => t.name
    );
    expect(toolNames).toEqual(["submit_outcome", "adapter_tool"]);

    expect(mod.adapterConfig.capabilities).toContain("adapter_tools");
  });

  test("successful call surfaces the callee's typed outputs as the tool's content", async () => {
    const outputs = { answer: 42, nested: { ok: true } };
    const { toolResult, replayPayloads } = await runWithReplay({
      kind: "result",
      outcome: "greeted",
      outputs,
    });

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0].type).toBe("text");
    expect(toolResult.content[0].text).toBe(JSON.stringify(outputs));
    expect(toolResult.structuredContent).toEqual(outputs);

    // The wire payload carried the kind, target, and args through to the host.
    expect(replayPayloads).toHaveLength(1);
    expect(replayPayloads[0].kind).toBe("adapter_tool");
    expect(replayPayloads[0].target).toBe("adapter.greet.hello.tools.greet");
    expect(replayPayloads[0].args).toEqual({ name: "world" });
  });

  test("deny produces an isError tool result the agent can report and continue from", async () => {
    const { toolResult } = await runWithReplay({
      kind: "deny",
      reason: "target not in allow_tools",
    });

    expect(toolResult.isError).toBe(true);
    const text = toolResult.content[0].text;
    expect(text).toContain("denied by host policy");
    expect(text).toContain("target not in allow_tools");
    expect(text).toContain("Report the denial");
  });

  test("unknown_tool tells the agent to correct the target", async () => {
    const { toolResult } = await runWithReplay({
      kind: "result",
      outcome: "",
      callError: "unknown_tool",
    });

    expect(toolResult.isError).toBe(true);
    const text = toolResult.content[0].text;
    expect(text).toContain("unknown_tool");
    expect(text).toContain("correct the target");
  });

  test("host_unsupported via call_error tells the agent to give up", async () => {
    const { toolResult } = await runWithReplay({
      kind: "result",
      outcome: "",
      callError: "host_unsupported",
    });

    expect(toolResult.isError).toBe(true);
    const text = toolResult.content[0].text;
    expect(text).toContain("host_unsupported");
    expect(text).toContain("give up");
  });

  // The bare-grant scenario is the one test that rides the SDK helper's
  // real DefaultToolCallTimeout (60s). `bun test` runs every file's tests
  // concurrently in a single process, and the SDK's server-v2 keeps a
  // module-level sessions map whose Permissions-stream drain rejects
  // in-flight adapter tool calls across every server — so another test
  // file's stream teardown kills the 60s wait (ToolCallStreamClosedError)
  // and makes the assertions nondeterministic. Run the scenario in its own
  // bun process to keep it deterministic; the inner test only executes when
  // this file re-invokes itself with the marker env var set.
  test("bare-grant old host degrades to host_unsupported and caches the session", async () => {
    if (process.env.ADAPTER_TOOL_BARE_GRANT_IN_PROCESS !== "1") {
      // Outer wrapper: re-run this file filtered to the inner test in a
      // fresh process where no other file's streams can interfere.
      const proc = Bun.spawnSync({
        cmd: [
          process.execPath,
          "test",
          import.meta.path,
          "-t",
          "in-process bare-grant old host",
        ],
        env: { ...process.env, ADAPTER_TOOL_BARE_GRANT_IN_PROCESS: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
      expect(proc.exitCode).toBe(0);
      expect(output).toContain("1 pass");
      expect(output).not.toContain("(fail)");
      return;
    }
    // In-process bare-grant old host: SDK helper times out on the real
    // DefaultToolCallTimeout deadline and degrades to typed host_unsupported.
    const { toolResult, toolResults, replayPayloads } = await runWithReplay(
      { kind: "bare_grant" },
      { callTool: true, times: 2 }
    );

    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0].text).toContain("host_unsupported");
    // The session is cached as unsupported: the second call fails fast
    // with the same typed error and sends nothing further on the wire.
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1].isError).toBe(true);
    expect(toolResults[1].content[0].text).toContain("host_unsupported");
    expect(replayPayloads).toHaveLength(1);
  }, 90_000);

  // Inner test: only executes in the self-spawned subprocess (see the
  // wrapper above); the env guard makes it a no-op in the shared suite
  // process so its 60s DefaultToolCallTimeout window never overlaps other
  // files' streams.
  test("in-process bare-grant old host degrades to host_unsupported", async () => {
    if (process.env.ADAPTER_TOOL_BARE_GRANT_IN_PROCESS !== "1") {
      return;
    }
    const { toolResult, toolResults, replayPayloads } = await runWithReplay(
      { kind: "bare_grant" },
      { callTool: true, times: 2 }
    );

    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0].text).toContain("host_unsupported");
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1].isError).toBe(true);
    expect(toolResults[1].content[0].text).toContain("host_unsupported");
    expect(replayPayloads).toHaveLength(1);
  }, 75_000);
});