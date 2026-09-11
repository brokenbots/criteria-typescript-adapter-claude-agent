import { describe, test, expect, mock } from "bun:test";
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
        capturedPayload = parsePermissionPayload(payload);
        permStream.write({ request: { requestId: reqId } });
      },
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.tool).toBe("Bash");
    expect(capturedPayload?.full_command_text).toBe(commandText);
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
        capturedPayload = parsePermissionPayload(payload);
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
        capturedPayload = parsePermissionPayload(payload);
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
