import { TestHost } from "@criteria/adapter-sdk/testing";
import { fromProtoStruct } from "../node_modules/@criteria/adapter-sdk/dist/plugin/server-v2.js";
import { mock } from "bun:test";

export const adapterPath = new URL("../index.ts", import.meta.url).href;

// The adapter resolves the Claude Code CLI up front and refuses to run without
// it. These tests mock the agent SDK so nothing is actually spawned, but the
// resolution still runs — point it at an executable that always exists.
export const FAKE_CLI = process.execPath;

/**
 * Stand-in for the MCP server created by the Claude Code SDK. The adapter
 * registers a single `submit_outcome` tool, so tests can reach in and call the
 * handler directly.
 */
export class MockMcpServer {
  name: string;
  tools: any[];
  constructor(opts: any) {
    this.name = opts.name;
    this.tools = opts.tools || [];
  }
}

/**
 * Default mocked agent query. Yields tool_progress for each non-submit_outcome
 * allowed tool (exercising the permission bridge) and ends with a successful
 * result. This does not call submit_outcome, so the adapter takes the fallback
 * path unless the test substitutes a different query factory.
 */
export class MockQuery implements AsyncIterable<any> {
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

/**
 * Simulates an agent run that calls `submit_outcome` with the given outcome and
 * reason. The real SDK would invoke the MCP tool internally; this mock looks up
 * the tool in the supplied MCP server and calls its handler directly, which is
 * exactly what the adapter observes.
 */
export class MockQueryWithOutcome implements AsyncIterable<any> {
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
 * Like MockQueryWithOutcome but also reports a session_id so the adapter's
 * resume/reprompt loop runs to completion.
 */
export class MockQueryWithOutcomeAndSession extends MockQueryWithOutcome {
  async *[Symbol.asyncIterator]() {
    const self = this as any;
    const { mcpServers, allowedTools } = self.opts.options || {};
    if (mcpServers && allowedTools) {
      for (const toolRef of allowedTools) {
        const parts = toolRef.split("__");
        const toolName = parts[parts.length - 1];
        if (toolName !== "submit_outcome") continue;

        const serverName = Object.keys(mcpServers)[0];
        const server = mcpServers[serverName];
        const tool = server?.tools?.find((t: any) => t.name === "submit_outcome");
        if (tool?.handler) {
          await tool.handler({ outcome: self.outcome, reason: self.reason });
        }
      }
    }
    yield {
      type: "result",
      subtype: "success",
      result: "done",
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 0,
      session_id: "mock-session",
    };
  }
}

/**
 * Simulates an agent query that never yields and respects the abort signal,
 * so a short step timeout can be exercised.
 */
export class MockQueryHangs implements AsyncIterable<any> {
  private opts: any;
  constructor(opts: any) {
    this.opts = opts;
  }

  async *[Symbol.asyncIterator]() {
    const abortController = this.opts.options?.abortController as AbortController | undefined;
    await new Promise<void>((_, reject) => {
      if (abortController?.signal.aborted) {
        reject(new Error("Aborted"));
        return;
      }
      abortController?.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  }

  close() {}
  async interrupt() {}
}

/**
 * Simulates an agent run that returns a result but never calls submit_outcome.
 * Reports a session_id so the adapter will exhaust its reprompt attempts.
 */
export class MockQueryNoOutcome implements AsyncIterable<any> {
  async *[Symbol.asyncIterator]() {
    yield {
      type: "result",
      subtype: "success",
      result: "done",
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 0,
      session_id: "mock-session",
    };
  }

  close() {}
  async interrupt() {}
}

/**
 * Mock the @anthropic-ai/claude-agent-sdk module. Call this at the top of each
 * test file so the adapter loads the stub instead of trying to spawn a real CLI.
 */
export function mockClaudeSdk(queryFactory?: (opts: any) => AsyncIterable<any>) {
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: (opts: any) => (queryFactory ? queryFactory(opts) : new MockQuery(opts)),
    createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
  }));
}

/**
 * Execute a step through a TestHost and return the full outputs map exposed by
 * the wire result event. TestHost only exposes `reason` on its friendly return
 * value, so we talk to the underlying gRPC client to capture the exact key set.
 */
export interface ExecuteEvents {
  stdout: string[];
  stderr: string[];
  adapterEvents: Array<{ kind: string; payload: any }>;
}

export async function executeWithOutputs(
  host: TestHost,
  opts: {
    stepName: string;
    input?: Record<string, unknown>;
    allowedOutcomes?: string[];
  }
): Promise<{ outcome: string; outputs: Record<string, string>; events: ExecuteEvents }> {
  const client = (host as any).client;
  const sessionId = (host as any).sessionId;
  const autoGrant = (host as any)._autoGrantPermissions ?? false;
  const delayMs = (host as any)._permissionDelayMs ?? 0;
  if (!client || !sessionId) throw new Error("Host not started or session not open");

  const permStream = (host as any)._permStream ?? (client as any).Permissions();
  (host as any)._permStream = permStream;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const adapterEvents: Array<{ kind: string; payload: any }> = [];

  // Open the Log stream so stdout/stderr emitted by the adapter are captured.
  const logStream = (client as any).Log({ sessionId });
  logStream.on("data", (logEvt: any) => {
    const line = logEvt.line ? Buffer.from(logEvt.line).toString("utf8") : "";
    if (logEvt.streamName === "stdout") stdout.push(line);
    else if (logEvt.streamName === "stderr") stderr.push(line);
  });
  logStream.on("error", () => {});

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
      if (adapterEvt) {
        const kind = adapterEvt.eventKind as string;
        const payload = parsePermissionPayload(adapterEvt.payload as any);
        if (kind === "permission.request") {
          const reqId =
            (payload?.request_id as string | undefined) ??
            (payload?.requestId as string | undefined);
          if (reqId && autoGrant) {
            if (delayMs > 0) {
              setTimeout(() => permStream.write({ request: { requestId: reqId } }), delayMs);
            } else {
              permStream.write({ request: { requestId: reqId } });
            }
          }
        } else {
          adapterEvents.push({ kind, payload });
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

  // Give buffered log lines a moment to drain through the Log stream.
  await new Promise((r) => setTimeout(r, 50));
  try {
    logStream.cancel?.();
    logStream.end?.();
  } catch {
    // ignore close errors
  }

  return { outcome: result.outcome ?? "", outputs: decodeOutputs(result), events: { stdout, stderr, adapterEvents } };
}

/**
 * Execute a step through a TestHost without auto-granting permissions. The
 * caller receives the snake_case request_id from each permission.request event
 * and the Permissions stream so it can manually grant or deny.
 */
export async function executeWithManualPermission(
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

  return { outcome: result.outcome ?? "", outputs: decodeOutputs(result) };
}

function decodeOutputs(result: any): Record<string, string> {
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
  return outputs as Record<string, string>;
}

/**
 * Parse a permission.request payload from its Protobuf Struct form into a plain
 * JavaScript object. Tests can use this to inspect the exact fields forwarded
 * by the permission bridge.
 */
export function parsePermissionPayload(payload: Record<string, any>): Record<string, any> {
  return payload ? fromProtoStruct(payload) : {};
}
