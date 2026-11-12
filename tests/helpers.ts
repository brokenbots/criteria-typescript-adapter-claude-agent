import { TestHost } from "@criteria/adapter-sdk/testing";
import { fromProtoStruct } from "../node_modules/@criteria/adapter-sdk/dist/plugin/server-v2.js";
import { mock } from "bun:test";

import { ADAPTER_TOOL_TOOL_NAME } from "../outcome.js";

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
        // MCP tools are invoked deliberately by the agent via the MCP server,
        // not through the canUseTool permission bridge.
        if (toolName === "submit_outcome" || toolName === ADAPTER_TOOL_TOOL_NAME) continue;
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
 * The KB-261 layer-2 permission-request routing contract, implemented for the
 * deterministic harness. One host owns ONE live Permissions consumer; every
 * permission.request observed on the Execute wire is correlated to that
 * consumer BY requestId and routed exactly once. Decisions are released by
 * explicit test control or in arrival order — never by a timer, whose queue
 * under runner load is what raced the step turn (the delayed-grants flake).
 *
 * A request that cannot be correlated (no requestId), is routed twice, or
 * whose decision would be delivered on a dead/stale consumer is recorded as a
 * typed routing defect and fails closed — it is never silently re-granted.
 */
export class PermissionRequestRouter {
  private readonly permStream: any;
  private routes: Array<{ requestId: string; sequence: number; payload: Record<string, any> }> = [];
  private readonly routedIds = new Set<string>();
  private grants: Array<{ requestId: string; sequence: number; kind: "allow" | "deny" }> = [];
  private readonly defectLog: string[] = [];
  private deadReason: string | null = null;
  private pendingWaits: Array<{ needed: number; resolve: () => void }> = [];

  private constructor(permStream: any) {
    this.permStream = permStream;
    // The router is the single handled consumer of its Permissions stream:
    // acknowledges are observed here (real consumption, no no-op sinks), and
    // stream death is captured so a later delivery is a typed defect.
    this.permStream.on("data", (evt: any) => {
      if (evt?.acknowledge?.requestId) {
        // Server acknowledged the decision we delivered (allow/deny).
      }
    });
    this.permStream.on("error", (err: any) => {
      this.deadReason = String(err ?? "Permissions consumer died");
    });
  }

  /**
   * Return the host's single persistent Permissions consumer, opening it once
   * on first use. A second concurrent consumer would be a multiplexing
   * defect, so acquisition is idempotent per host.
   */
  static acquire(host: TestHost): PermissionRequestRouter {
    const anyHost = host as any;
    if (anyHost._permissionRouter) return anyHost._permissionRouter as PermissionRequestRouter;
    if (!anyHost.client || !anyHost.sessionId) throw new Error("Host not started or session not open");
    const router = new PermissionRequestRouter((anyHost.client as any).Permissions());
    anyHost._permissionRouter = router;
    anyHost._permStream = router.permStream;
    return router;
  }

  get stream() {
    return this.permStream;
  }

  /**
   * Correlate one permission.request observed on the wire. Exactly-once by
   * requestId: a duplicate routing is recorded as a defect and is NOT
   * delivered again.
   */
  route(requestId: string | undefined, payload: Record<string, any>): void {
    if (!requestId) {
      this.defectLog.push("permission.request observed without a requestId (uncorrelatable)");
      return;
    }
    if (this.routedIds.has(requestId)) {
      this.defectLog.push(`permission.request ${requestId} routed more than once`);
      return;
    }
    this.routedIds.add(requestId);
    const sequence = this.routes.length + 1;
    this.routes.push({ requestId, sequence, payload });
    this.pendingWaits = this.pendingWaits.filter((w) => {
      if (this.routes.length >= w.needed) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  /** Resolve when count requests have been routed (event-driven; no polling). */
  waitRouted(count: number): Promise<void> {
    if (this.routes.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.pendingWaits.push({ needed: count, resolve }));
  }

  /**
   * Release a decision for the nth (1-based) routed request: an allow by
   * default, or a deny with `deny_reason`. Delivery to a stale consumer or a
   * second decision for an already-resolved request fails closed as a typed
   * defect instead of silently writing into the stream.
   */
  grant(n: number, opts?: { deny_reason?: string }): void {
    const entry = this.routes[n - 1];
    if (!entry) {
      this.defectLog.push(`grant(${n}) targets an uncorrelated request`);
      return;
    }
    if (this.deadReason !== null) {
      this.defectLog.push(`grant(${n}) for ${entry.requestId} would deliver to a stale consumer (${this.deadReason})`);
      return;
    }
    if (this.grants.some((g) => g.requestId === entry.requestId)) {
      this.defectLog.push(`grant(${n}) issues a second decision for already-resolved ${entry.requestId}`);
      return;
    }
    if (opts?.deny_reason !== undefined) {
      this.permStream.write({ cancel: { requestId: entry.requestId, reason: opts.deny_reason } });
      this.grants.push({ requestId: entry.requestId, sequence: entry.sequence, kind: "deny" });
    } else {
      this.permStream.write({ request: { requestId: entry.requestId } });
      this.grants.push({ requestId: entry.requestId, sequence: entry.sequence, kind: "allow" });
    }
  }

  /** Release every routed-but-unresolved decision in arrival order (event-driven auto-grant). */
  grantAllArrived(): void {
    for (let n = 1; n <= this.routes.length; n++) {
      const entry = this.routes[n - 1];
      if (!this.grants.some((g) => g.requestId === entry.requestId)) this.grant(n);
    }
  }

  routedCount(): number {
    return this.routes.length;
  }

  grantedCount(): number {
    return this.grants.length;
  }

  /** Decision-release order, expressed as routed-arrival sequence numbers. */
  grantedSequences(): number[] {
    return this.grants.map((g) => g.sequence);
  }

  routedSequences(): number[] {
    return this.routes.map((r) => r.sequence);
  }

  defects(): readonly string[] {
    return this.defectLog;
  }

  /** Typed reason if the single consumer died mid-step (routing cannot continue). */
  consumerDeath(): string | null {
    return this.deadReason;
  }
}

/**
 * Execute a step through a TestHost with permission decisions released by
 * routing control instead of timers. Every permission.request is correlated to
 * the host's single Permissions consumer by requestId before any decision is
 * written, which makes strict ordering scenarios (delayed grants, parallel
 * bursts) a construction of the routing contract rather than a timer race.
 *
 * `grantOnRoute` releases each decision the moment its request is routed, in
 * arrival order (event-driven auto-grant). Without it, the caller releases
 * decisions explicitly via `router.grant(n)` — e.g. after `router.waitRouted`.
 */
export async function executeWithPermissionRouter(
  host: TestHost,
  opts: {
    stepName: string;
    input?: Record<string, unknown>;
    allowedOutcomes?: string[];
    router?: PermissionRequestRouter;
    /** Release each routed decision immediately, in arrival order (event-driven auto-grant). */
    grantOnRoute?: boolean;
  }
): Promise<{ outcome: string; outputs: Record<string, string>; router: PermissionRequestRouter }> {
  const client = (host as any).client;
  const sessionId = (host as any).sessionId;
  if (!client || !sessionId) throw new Error("Host not started or session not open");

  const router = opts.router ?? PermissionRequestRouter.acquire(host);

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
      if (adapterEvt?.eventKind !== "permission.request") return;
      const payload = parsePermissionPayload(adapterEvt.payload as any);
      const reqId =
        (payload?.requestId as string | undefined) ?? (payload?.request_id as string | undefined);
      router.route(reqId, payload);
      if (opts.grantOnRoute) router.grantAllArrived();
    });
    execStream.on("error", (err: any) => {
      if (!resolved) reject(err);
    });
    execStream.on("end", () => {
      if (!resolved) reject(new Error("Execute stream ended without result"));
    });
  });

  return { outcome: result.outcome ?? "", outputs: decodeOutputs(result), router };
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
  if (autoGrant && delayMs > 0) {
    // Timer-queued grants race the step turn under runner load (the KB-261
    // delayed-grants flake). Controlled release must go through the router.
    throw new Error(
      "permissionDelayMs with executeWithOutputs is unsupported: timer-queued permission grants race the step turn; use PermissionRequestRouter for controlled, event-driven release"
    );
  }

  // All permission decisions route through the single requestId-correlated
  // consumer (KB-261 layer-2 routing contract).
  const router = PermissionRequestRouter.acquire(host);

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
            (payload?.requestId as string | undefined) ??
            (payload?.request_id as string | undefined);
          router.route(reqId, payload);
          if (autoGrant) router.grantAllArrived();
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
 * caller receives the requestId from each permission.request event and the
 * Permissions stream so it can manually grant or deny.
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

  const router = PermissionRequestRouter.acquire(host);
  // Decision writes stay caller-controlled (no timers); observed requests are
  // correlated by requestId through the single consumer.
  const permStream = router.stream;

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
        // CRI-179 SDK contract: the wire payload carries camelCase requestId.
        // Keep a snake_case fallback for hosts/SDKs that still emit it.
        const reqId =
          payload?.fields?.requestId?.stringValue ??
          payload?.fields?.request_id?.stringValue;
        router.route(reqId, parsePermissionPayload(payload));
        if (reqId) opts.onRequest(reqId, permStream, payload);
      }
    });

    execStream.on("error", (err: any) => {
      if (!resolved) reject(err);
    });
    execStream.on("end", () => {
      if (!resolved) reject(new Error("Execute stream ended without result"));
    });
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
