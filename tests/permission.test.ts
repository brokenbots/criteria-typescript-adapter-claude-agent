import { beforeAll, describe, test, expect, mock } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";
import {
  adapterPath,
  FAKE_CLI,
  MockMcpServer,
  mockClaudeSdk,
  executeWithManualPermission,
  executeWithOutputs,
  parsePermissionPayload,
} from "./helpers.js";

mockClaudeSdk();

describe("permission handling", () => {
  test("permission.request event payload includes a non-empty requestId", async () => {
    let capturedId: string | undefined;

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
      onRequest: (reqId, permStream) => {
        capturedId = reqId;
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedId).toBeDefined();
    expect(capturedId?.length).toBeGreaterThan(0);
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("permission bridge forwards tool name and args to the host", async () => {
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
      stepName: "forward-tool-args",
      input: { prompt: "read file" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream, payload) => {
        capturedPayload = parsePermissionPayload(payload);
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.tool).toBe("Read");
    expect(capturedPayload?.argsPreview).toBe(JSON.stringify({ path: "/tmp/readme.md" }));
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-31: permission.request payload carries the Bash command digest and preview", async () => {
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
        capturedPayload = parsePermissionPayload(payload);
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.tool).toBe("Bash");
    // CRI-179 SDK contract: raw args no longer travel on the wire — a sha256
    // args_digest plus a (possibly truncated) args_preview do.
    expect(capturedPayload?.argsPreview).toBe(JSON.stringify({ command: commandText }));
    expect(capturedPayload?.argsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-31: commands array is carried in the args digest and preview", async () => {
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
        capturedPayload = parsePermissionPayload(payload);
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.tool).toBe("Bash");
    expect(capturedPayload?.argsPreview).toBe(JSON.stringify({ commands }));
    expect(capturedPayload?.argsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-31: non-command tool args are digested and previewed without command shapes", async () => {
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
        capturedPayload = parsePermissionPayload(payload);
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.tool).toBe("Read");
    expect(capturedPayload?.argsPreview).toBe(JSON.stringify({ path: "/tmp/readme.md" }));
    expect(capturedPayload?.argsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(capturedPayload).not.toHaveProperty("full_command_text");
    expect(capturedPayload).not.toHaveProperty("commands");
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  test("CRI-31: bare allow_tools = ['Bash'] still grants without fingerprint", async () => {
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
        const parsed = parsePermissionPayload(payload);
        if (typeof parsed?.tool === "string") capturedTools.push(parsed.tool);
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedTools.sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    expect(["success", "failure", "needs_review"]).toContain(outcome);
    await host.stop();
  });

  const declaredTools = ["Read", "Bash", "Write", "Edit", "Glob", "Grep"];
  for (const allowed of declaredTools) {
    test(`CRI-32: allow_tools with "${allowed}" grants only the matching runtime tool`, async () => {
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

      const mod = await import(`${adapterPath}?${Date.now()}`);
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
          const parsed = parsePermissionPayload(payload);
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
    });
  }

  test("host permission.granted with matching requestId resolves to allow in under 1 second", async () => {
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

  test("host permission.denied with matching requestId resolves to deny in under 1 second", async () => {
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

  test("denied permission returns the host reason in the SDK response", async () => {
    let capturedMessage: string | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            const result = await canUseTool("Bash", { command: "rm -rf /" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-deny-msg",
            });
            capturedMessage = result.message;
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
      stepName: "deny-message",
      input: { prompt: "dangerous command" },
      allowedOutcomes: ["success"],
      onRequest: (reqId, permStream) => {
        permStream.write({ cancel: { requestId: reqId, reason: "Too risky for this host" } });
      },
    });

    expect(capturedMessage).toBe("Too risky for this host");
    expect(["success", "failure", "needs_review"]).toContain(outcome);
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

  test("permission decisions with delayed grants resolve correctly", async () => {
    const order: number[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            const r1 = await canUseTool("Read", { path: "/tmp/a" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-a",
            });
            order.push(1);
            expect(r1.behavior).toBe("allow");
            const r2 = await canUseTool("Read", { path: "/tmp/b" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-b",
            });
            order.push(2);
            expect(r2.behavior).toBe("allow");
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
      permissionDelayMs: 20,
    });
    await host.start();

    await host.openSession({ config: { claude_executable: FAKE_CLI } });
    const result = await host.execute({
      stepName: "delayed-grants",
      input: { prompt: "delayed" },
      allowedOutcomes: ["success"],
    });

    expect(order).toEqual([1, 2]);
    expect(["success", "failure", "needs_review"]).toContain(result.outcome);
    await host.stop();
  });
});

describe("permission-bridge quiesce (KB-261 ruling addendum)", () => {
  test("invariant: step result cannot finalize while a permission decision is in flight", async () => {
    // The hazard from merge-CI (real-CLI under load, KB-396 class): the query
    // stream ENDS with a permission decision still unanswered on the bridge,
    // so a step result arrives over an indeterminate wire state. The mock
    // builds exactly that shape: decision #2 is started but deliberately left
    // unanswered, and the result yield is the LAST thing the stream does.
    // Resolution order is controlled by the test — explicit grants on
    // observed events, no timing-sensitive sleeps anywhere.
    const settledDecisions: string[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          if (canUseTool) {
            const r1 = await canUseTool("Read", { path: "/tmp/a" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-a",
            });
            expect(r1.behavior).toBe("allow");
            settledDecisions.push("allow");
            // Decision #2 starts but is never awaited by the query: the
            // stream ends while it is still in flight.
            void canUseTool("Read", { path: "/tmp/b" }, {
              signal: new AbortController().signal,
              toolUseID: "tool-b",
            }).then(
              (r2: any) => settledDecisions.push(r2?.behavior ?? "reject"),
              () => settledDecisions.push("reject")
            );
          }
          yield { type: "tool_progress", tool_name: "Read", message: "decision pending" };
          yield { type: "result", subtype: "success", result: "done", duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig });
    await host.start();
    await host.openSession({ config: { claude_executable: FAKE_CLI } });

    const client = (host as any).client;
    const sessionId = (host as any).sessionId;
    const permStream = client.Permissions();
    // The host tears the connection down in this test's finally; attach
    // handlers so the drop is not reported as an unhandled stream error.
    permStream.on("data", () => {});
    permStream.on("error", () => {});

    const requestIds: string[] = [];
    const seenKinds: string[] = [];
    const drainedPayloads: any[] = [];
    let requestsSeen!: () => void;
    const twoRequests = new Promise<void>((r) => { requestsSeen = r; });
    let seeResult!: () => void;
    const resultSeen = new Promise<void>((r) => { seeResult = r; });
    let seeQuiesce!: () => void;
    const quiesceStarted = new Promise<void>((r) => { seeQuiesce = r; });

    let settleExecute!: (r: any) => void;
    let executeWireError: any = null;
    const executeDone = new Promise<any>((r) => { settleExecute = r; });

    const execStream = client.Execute({
      sessionId,
      stepName: "quiesce-invariant",
      input: { prompt: "quiesce invariant" },
      allowedOutcomes: ["success"],
    });
    execStream.on("data", (evt: any) => {
      if (evt.result) {
        settleExecute(evt.result);
        seeResult();
        return;
      }
      const adapterEvt = evt.adapter as any;
      if (!adapterEvt) return;
      seenKinds.push(adapterEvt.eventKind);
      if (adapterEvt.eventKind === "permission.quiesce_started") {
        seeQuiesce();
        return;
      }
      if (adapterEvt.eventKind === "permission.quiesce_drained") {
        drainedPayloads.push(parsePermissionPayload(adapterEvt.payload));
        return;
      }
      if (adapterEvt.eventKind === "permission.request") {
        const payload = parsePermissionPayload(adapterEvt.payload);
        const reqId = payload?.requestId ?? payload?.request_id;
        if (!reqId) return;
        requestIds.push(reqId);
        // Decision #1 is granted the moment its request is seen; decision #2
        // stays unanswered until the invariant gate below hands it over.
        if (requestIds.length === 1) permStream.write({ request: { requestId: reqId } });
        if (requestIds.length === 2) requestsSeen();
      }
    });
    execStream.on("error", (err: any) => {
      executeWireError = err;
      settleExecute({ error: err });
    });

    try {
      await twoRequests;

      // The strict invariant: with decision #2 still unanswered, the step
      // result must NOT arrive. On the unguarded path the result event wins
      // this race (that is the defect); the guarded path holds the step open
      // and surfaces permission.quiesce_started instead.
      const guarded = await Promise.race([
        quiesceStarted.then(() => true),
        resultSeen.then(() => false),
      ]);
      expect(guarded).toBe(true);

      // The test now resolves the outstanding decision. The drain must pick
      // it up and only then let the step finalize.
      permStream.write({ request: { requestId: requestIds[1] } });
      const wireResult = await executeDone;

      expect(executeWireError).toBeNull();
      expect(settledDecisions).toEqual(["allow", "allow"]);
      expect(wireResult.outcome).toBe("failure");
      expect(seenKinds).toContain("permission.quiesce_started");
      const drained = drainedPayloads.at(-1);
      expect(drained?.drained).toBe(true);
      expect(drained?.timedOut).toBe(false);
    } finally {
      permStream.end?.();
      await host.stop();
    }
  });

  describe("quiesce unit probes", () => {
    let mod: any;

    beforeAll(async () => {
      mod = await import(`${adapterPath}?quiesce-unit`);
    });

    function makeQuiesceHelpers(): any {
      const events: any[] = [];
      return {
        events,
        log: {
          adapterEvent: async (kind: string, payload: any) => {
            events.push({ kind, payload });
          },
          stdout: async (_: string) => {},
          stderr: async (_: string) => {},
        },
      };
    }

    test("tracker registers decisions and clears them once settled (resolve and reject)", async () => {
      const tracker = mod.createPermissionDecisionTracker();
      expect(tracker.pending()).toEqual([]);

      let resolveRead!: (v: unknown) => void;
      const readDecision = new Promise((resolve) => { resolveRead = resolve; });
      let rejectBash!: (e: Error) => void;
      const bashDecision = new Promise((_, reject) => { rejectBash = reject; });

      tracker.track("Read", readDecision);
      tracker.track("Bash", bashDecision);
      expect(tracker.pending().map((e: any) => e.toolName)).toEqual(["Read", "Bash"]);

      resolveRead({ decision: "allow" });
      rejectBash(new Error("permission wait timed out"));
      // Settlement is removal: resolved AND rejected decisions leave the
      // pending set (rejection is terminal, not in-flight).
      for (let i = 0; i < 4; i++) await Promise.resolve();
      expect(tracker.pending()).toEqual([]);
    });

    test("quiesce returns no unresolved tools when decisions settle during the drain", async () => {
      const tracker = mod.createPermissionDecisionTracker();
      let resolveRead!: (v: unknown) => void;
      tracker.track("Read", new Promise((resolve) => { resolveRead = resolve; }));

      const helpers = makeQuiesceHelpers();
      const draining = mod.quiescePermissionDecisions(tracker, helpers, 1000);
      resolveRead({ decision: "allow" });
      const unresolved = await draining;

      expect(unresolved).toEqual([]);
      const kinds = helpers.events.map((e: any) => e.kind);
      expect(kinds).toContain("permission.quiesce_started");
      expect(kinds).toContain("permission.quiesce_drained");
      const drained = helpers.events.find((e: any) => e.kind === "permission.quiesce_drained");
      expect(drained.payload.drained).toBe(true);
    });

    test("quiesce fails closed past the bound and names the unresolved tool", async () => {
      const tracker = mod.createPermissionDecisionTracker();
      // A decision that never settles: the bounded drain can only expire, so
      // the result is determined by construction, not by scheduler luck.
      tracker.track("Read", new Promise(() => {
        /* never settles: the bounded drain must expire */
      }));
      const helpers = makeQuiesceHelpers();

      const unresolved = await mod.quiescePermissionDecisions(tracker, helpers, 15);

      expect(unresolved).toEqual(["Read"]);
      const started = helpers.events.find((e: any) => e.kind === "permission.quiesce_started");
      const drained = helpers.events.find((e: any) => e.kind === "permission.quiesce_drained");
      expect(started.payload.pendingTools).toEqual(["Read"]);
      expect(drained.payload.drained).toBe(false);
      expect(drained.payload.timedOut).toBe(true);
    });
  });
});
