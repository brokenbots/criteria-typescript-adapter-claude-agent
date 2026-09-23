import { describe, test, expect, mock } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";
import {
  adapterPath,
  FAKE_CLI,
  MockMcpServer,
} from "./helpers.js";

/**
 * CRI-301: parallel_safe gate contract and concurrency-safety tests.
 *
 * The engine refuses `parallel = [...]` steps unless the adapter's Info()
 * capabilities declare "parallel_safe" (compile-time gate in
 * workflow/compile_steps_iteration.go, runtime gate in
 * internal/engine/parallel_iteration.go). These tests pin the adapter side of
 * that contract:
 *
 * 1. Info() carries "parallel_safe" — the exact list the engine's
 *    Sessions.HasCapability reads before fan-out.
 * 2. Concurrent Execute calls across two sessions in one adapter process keep
 *    their per-session state (resume chains) isolated — no cross-session bleed.
 * 3. Concurrent in-flight permission requests are correlated per requestId —
 *    each bridge receives its own decision, not its sibling's.
 * 4. Concurrent executes keep per-iteration env isolation: each session's
 *    `claude_config_dir` input reaches its own subprocess env, so sibling
 *    subprocesses never share a Claude Code global-state directory.
 *
 * CRI-306 extends this suite to the engine's actual parallel topology for
 * adapter-target steps: TWO concurrent Executes multiplexed onto ONE wire
 * session. The shared `claudeSessionId` store value can only carry one resume
 * chain, so the adapter must run overlapping executes as fresh conversations
 * without publishing their session ids onto the chain — otherwise every
 * iteration resumes and interleaves into the same transcript.
 *
 * The engine additionally gives every parallel iteration its own fresh
 * SessionManager, which spawns a fresh adapter process per resolve
 * (internal/adapterhost/loader.go), so these tests are deliberately stricter
 * than the engine's fan-out topology: they prove safety even when two sessions
 * share one adapter process.
 */

interface ExecuteSpec {
  sessionId: string;
  stepName: string;
  input?: Record<string, unknown>;
  allowedOutcomes?: string[];
}

interface ExecuteResult {
  outcome: string;
  outputs: Record<string, string>;
}

/**
 * Drive one Execute RPC against an explicit session (TestHost.execute only
 * tracks a single current session, so concurrent runs across two sessions go
 * through the raw client). Resolves on the wire result event.
 */
function executeOnSession(
  client: any,
  spec: ExecuteSpec
): Promise<ExecuteResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = client.Execute({
      sessionId: spec.sessionId,
      stepName: spec.stepName,
      input: spec.input ?? {},
      allowedOutcomes: spec.allowedOutcomes ?? [],
    });
    stream.on("data", (evt: any) => {
      if (settled || !evt.result) return;
      settled = true;
      let outputs: Record<string, string> = {};
      if (evt.result.outputs && Object.keys(evt.result.outputs).length > 0) {
        outputs = evt.result.outputs;
      } else if (evt.result.outputsJson) {
        const raw = evt.result.outputsJson;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        try {
          outputs = JSON.parse(buf.toString("utf8"));
        } catch {
          outputs = {};
        }
      }
      resolve({ outcome: evt.result.outcome ?? "", outputs });
    });
    stream.on("error", (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    stream.on("end", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Execute stream ended without result"));
      }
    });
  });
}

/** Collect permission.request events from one Execute stream. */
function collectPermissionRequests(
  client: any,
  spec: ExecuteSpec,
  onRequest: (requestId: string, tool: string) => void
): Promise<ExecuteResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = client.Execute({
      sessionId: spec.sessionId,
      stepName: spec.stepName,
      input: spec.input ?? {},
      allowedOutcomes: spec.allowedOutcomes ?? [],
    });
    stream.on("data", (evt: any) => {
      if (evt.result && !settled) {
        settled = true;
        resolve({ outcome: evt.result.outcome ?? "", outputs: {} });
        return;
      }
      const adapterEvt = evt.adapter as Record<string, unknown> | undefined;
      if (adapterEvt?.eventKind === "permission.request") {
        const payload = (adapterEvt.payload ?? {}) as Record<string, any>;
        const reqId =
          payload?.fields?.requestId?.stringValue ??
          payload?.fields?.request_id?.stringValue;
        const tool = payload?.fields?.tool?.stringValue;
        if (reqId) onRequest(reqId, tool ?? "");
      }
    });
    stream.on("error", (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    stream.on("end", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Execute stream ended without result"));
      }
    });
  });
}

describe("parallel_safe gate contract (CRI-301)", () => {
  test("Info() capabilities declare parallel_safe for the engine gate", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig });
    await host.start();

    // The engine's compile-time and runtime gates read InfoResponse
    // capabilities (HasCapability). Assert on the wire response, not the
    // config object, so the test fails if the serve layer ever drops it.
    const info = await new Promise<any>((resolve, reject) => {
      (host as any).client.Info({}, (err: any, resp: any) => {
        if (err) reject(err);
        else resolve(resp);
      });
    });

    const capabilities: string[] = info.capabilities ?? [];
    expect(capabilities).toContain("parallel_safe");
    // Multi-turn remains declared: reprompt loop still applies per iteration.
    expect(capabilities).toContain("multi_turn");
    await host.stop();
  });

  test("adapterConfig.capabilities is the source of the Info() declaration", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    expect(mod.adapterConfig.capabilities).toContain("parallel_safe");
  });
});

describe("concurrent execute isolation (CRI-301)", () => {
  test("concurrent sessions keep their resume chains isolated", async () => {
    // Each session's claude session id is derived from its prompt marker, so
    // a cross-session resume bleed would surface as resuming the other
    // session's id.
    const resumeLog = new Map<string, string[]>();
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const marker = /session-([AB])/.exec(String(opts.prompt))?.[1] ?? "?";
          // Force the two executes to interleave inside the adapter.
          await new Promise((r) => setTimeout(r, 30));
          const resume = opts.options?.resume as string | undefined;
          if (!resumeLog.has(marker)) resumeLog.set(marker, []);
          resumeLog.get(marker)!.push(resume ?? "<none>");
          yield {
            type: "result",
            subtype: "success",
            result: `done-${marker}`,
            duration_ms: 10,
            num_turns: 1,
            total_cost_usd: 0,
            ...(resume
              ? {}
              : { session_id: `claude-${marker}` }),
          };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig });
    await host.start();
    const client = (host as any).client;

    await host.openSession({ sessionId: "session-A", config: { claude_executable: FAKE_CLI } });
    await host.openSession({ sessionId: "session-B", config: { claude_executable: FAKE_CLI } });

    // Round 1: both sessions execute concurrently; neither has a resume yet.
    await Promise.all([
      executeOnSession(client, {
        sessionId: "session-A",
        stepName: "a1",
        input: { prompt: "run session-A task" },
        allowedOutcomes: [],
      }),
      executeOnSession(client, {
        sessionId: "session-B",
        stepName: "b1",
        input: { prompt: "run session-B task" },
        allowedOutcomes: [],
      }),
    ]);
    expect(resumeLog.get("A")).toEqual(["<none>"]);
    expect(resumeLog.get("B")).toEqual(["<none>"]);

    // Round 2: each session must resume only its own claude session id.
    await Promise.all([
      executeOnSession(client, {
        sessionId: "session-A",
        stepName: "a2",
        input: { prompt: "run session-A again" },
        allowedOutcomes: [],
      }),
      executeOnSession(client, {
        sessionId: "session-B",
        stepName: "b2",
        input: { prompt: "run session-B again" },
        allowedOutcomes: [],
      }),
    ]);
    expect(resumeLog.get("A")).toEqual(["<none>", "claude-A"]);
    expect(resumeLog.get("B")).toEqual(["<none>", "claude-B"]);

    await host.closeSession();
    await host.stop();
  });

  test("concurrent in-flight permission requests are correlated per requestId", async () => {
    let decisions: { tool: string; decision: string }[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const { canUseTool } = opts.options || {};
          const marker = /session-([AB])/.exec(String(opts.prompt))?.[1] ?? "?";
          if (canUseTool) {
            // Session A requests Bash, session B requests Read; both are
            // in flight simultaneously across the two executes.
            const tool = marker === "A" ? "Bash" : "Read";
            const decision = await canUseTool(tool, { marker }, {
              signal: new AbortController().signal,
              toolUseID: `tool-${tool}`,
            });
            decisions.push({ tool, decision: decision.behavior });
          }
          yield { type: "result", subtype: "success", result: `done-${marker}`, duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig });
    await host.start();
    const client = (host as any).client;

    await host.openSession({ sessionId: "session-A", config: { claude_executable: FAKE_CLI } });
    await host.openSession({ sessionId: "session-B", config: { claude_executable: FAKE_CLI } });

    // One Permissions stream serves both sessions: correlation is by
    // requestId, which is exactly what concurrent fan-out relies on.
    const permStream = client.Permissions();
    permStream.on("data", () => {});
    permStream.on("error", () => {});

    const seen = new Map<string, string>(); // requestId -> tool
    const grant = (reqId: string) => permStream.write({ request: { requestId: reqId } });
    const deny = (reqId: string) => permStream.write({ cancel: { requestId: reqId, reason: "denied by test" } });
    let answered = 0;

    await Promise.all([
      collectPermissionRequests(client, {
        sessionId: "session-A",
        stepName: "a",
        input: { prompt: "run session-A bash" },
        allowedOutcomes: ["success"],
      }, (reqId, tool) => {
        seen.set(reqId, tool);
        // Answer only once both requests are in flight, so neither decision
        // is made before the sibling request exists.
        answered++;
        if (seen.size === 2) {
          for (const [id, toolName] of seen) {
            if (toolName === "Read") grant(id);
            else deny(id);
          }
        }
      }),
      collectPermissionRequests(client, {
        sessionId: "session-B",
        stepName: "b",
        input: { prompt: "run session-B read" },
        allowedOutcomes: ["success"],
      }, (reqId, tool) => {
        seen.set(reqId, tool);
        answered++;
        if (seen.size === 2) {
          for (const [id, toolName] of seen) {
            if (toolName === "Read") grant(id);
            else deny(id);
          }
        }
      }),
    ]);

    // The Read request was allowed and the Bash request denied: each bridge
    // received its own decision even though both were in flight at once.
    decisions.sort((a, b) => a.tool.localeCompare(b.tool));
    expect(decisions).toEqual([
      { tool: "Bash", decision: "deny" },
      { tool: "Read", decision: "allow" },
    ]);
    expect(seen.size).toBe(2);
    expect(answered).toBe(2);
    try {
      permStream.cancel?.();
      permStream.end?.();
    } catch {
      // ignore close errors
    }
    await host.closeSession();
    await host.stop();
  });

  test("concurrent executes with per-step overrides do not share option state", async () => {
    const captured: { marker: string; model?: string; envKey: string | undefined }[] = [];

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const marker = /session-([AB])/.exec(String(opts.prompt))?.[1] ?? "?";
          await new Promise((r) => setTimeout(r, 20));
          captured.push({
            marker,
            model: opts.options?.model,
            envKey: opts.options?.env?.CLAUDE_CONFIG_DIR,
          });
          yield { type: "result", subtype: "success", result: `done-${marker}`, duration_ms: 10, num_turns: 1, total_cost_usd: 0 };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig });
    await host.start();
    const client = (host as any).client;

    // Distinct per-session config: each session carries its own model and
    // claude_config_dir, mimicking per-iteration environments in a parallel
    // fan-out.
    await host.openSession({
      sessionId: "session-A",
      config: { claude_executable: FAKE_CLI, model: "model-A", },
    });
    await host.openSession({
      sessionId: "session-B",
      config: { claude_executable: FAKE_CLI, model: "model-B" },
    });

    // The host env carries a third, distinct value: if the per-step input were
    // not honored, both siblings would fall back to this shared value — the
    // shared-global-state case the per-iteration knob exists to avoid.
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/host-env-config-dir";
    try {
      await Promise.all([
        executeOnSession(client, {
          sessionId: "session-A",
          stepName: "a",
          input: { prompt: "run session-A", claude_config_dir: "/isolated-config-dir-A" },
          allowedOutcomes: [],
        }),
        executeOnSession(client, {
          sessionId: "session-B",
          stepName: "b",
          input: { prompt: "run session-B", claude_config_dir: "/isolated-config-dir-B" },
          allowedOutcomes: [],
        }),
      ]);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }

    const byMarker = new Map(captured.map((c) => [c.marker, c]));
    expect(byMarker.get("A")?.model).toBe("model-A");
    expect(byMarker.get("B")?.model).toBe("model-B");
    // Per-iteration isolation of Claude Code global state (CRI-301): each
    // concurrent sibling's claude_config_dir input reaches its own subprocess
    // env, so sibling subprocesses never share a global-state directory even
    // though they inherit the same host env.
    expect(byMarker.get("A")?.envKey).toBe("/isolated-config-dir-A");
    expect(byMarker.get("B")?.envKey).toBe("/isolated-config-dir-B");
    await host.closeSession();
    await host.stop();
  });
});

// ============================================================================
// Concurrent executes on ONE session (CRI-306)
// ============================================================================

/**
 * Marker extracted from a test prompt so the mocked SDK can answer per
 * execute with its own conversation identity. Reprompt prompts carry no
 * marker word, so they are classified by the conversation they resume.
 */
function markerOf(prompt: string, resume?: string): string {
  const marker = /\b(seed|owner|sibling|after)\b/.exec(prompt)?.[1];
  if (marker) return marker;
  return resume ? resume.replace(/^claude-/, "") : "unknown";
}

/** Poll until `fn()` is true or the deadline expires. */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("concurrent executes on one session (CRI-306)", () => {
  test("sibling execute runs a fresh conversation and never publishes its session id", async () => {
    interface QueryRecord {
      marker: string;
      resume: string | undefined;
    }
    const queries: QueryRecord[] = [];
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const marker = markerOf(String(opts.prompt), opts.options?.resume);
          const resume = opts.options?.resume as string | undefined;
          queries.push({ marker, resume });

          // Finalize this execute through the MCP tool, like the real agent
          // would, so each concurrent iteration completes on its own stream
          // with its own outcome (the SDK's per-call routing is a
          // prerequisite the CRI-305 fix provides).
          const { mcpServers, allowedTools } = opts.options || {};
          for (const toolRef of allowedTools ?? []) {
            const toolName = String(toolRef).split("__").pop();
            if (toolName !== "submit_outcome") continue;
            const server = mcpServers?.[Object.keys(mcpServers)[0]];
            const tool = server?.tools?.find((t: any) => t.name === "submit_outcome");
            if (tool?.handler) {
              await tool.handler({ outcome: "success", reason: `done-${marker}` });
            }
          }

          // Hold the owner long enough for the sibling execute to arrive and
          // start while the owner is provably in flight.
          if (marker === "owner") await new Promise((r) => setTimeout(r, 60));
          yield {
            type: "result",
            subtype: "success",
            result: `done-${marker}`,
            duration_ms: 10,
            num_turns: 1,
            total_cost_usd: 0,
            session_id: `claude-${marker}`,
          };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig });
    await host.start();
    const client = (host as any).client;

    await host.openSession({ sessionId: "session-one", config: { claude_executable: FAKE_CLI } });

    // Round 1 (sequential): establishes the shared resume chain.
    await executeOnSession(client, {
      sessionId: "session-one",
      stepName: "seed",
      input: { prompt: "seed step" },
      allowedOutcomes: ["success"],
    });
    expect(queries).toEqual([{ marker: "seed", resume: undefined }]);

    // Round 2: TWO concurrent executes on the SAME session. Start the owner
    // first and only launch the sibling once the owner's query is running, so
    // the owner/sibling roles are deterministic.
    const ownerDone = executeOnSession(client, {
      sessionId: "session-one",
      stepName: "owner",
      input: { prompt: "owner task" },
      allowedOutcomes: ["success"],
    });
    await waitFor(() => queries.length >= 2);

    const siblingDone = executeOnSession(client, {
      sessionId: "session-one",
      stepName: "sibling",
      input: { prompt: "sibling task" },
      allowedOutcomes: ["success"],
    });
    const [ownerResult, siblingResult] = await Promise.all([ownerDone, siblingDone]);

    // The owner resumes the stored chain; the sibling starts fresh even
    // though the store holds claude-seed at that moment.
    expect(queries[1]).toEqual({ marker: "owner", resume: "claude-seed" });
    expect(queries[2]).toEqual({ marker: "sibling", resume: undefined });

    // Each iteration completes with its own outcome on its own stream: no
    // cross-routed finalize, no transcript interleaving.
    expect(ownerResult.outcome).toBe("success");
    expect(siblingResult.outcome).toBe("success");
    expect(ownerResult.outputs.reason).toBe("done-owner");
    expect(siblingResult.outputs.reason).toBe("done-sibling");

    // Round 3 (sequential): the next execute resumes the owner's chain
    // (claude-owner, republished by the owner), NOT the sibling's fresh
    // conversation and NOT the stale seed.
    await executeOnSession(client, {
      sessionId: "session-one",
      stepName: "after",
      input: { prompt: "after step" },
      allowedOutcomes: ["success"],
    });
    expect(queries[3]).toEqual({ marker: "after", resume: "claude-owner" });

    await host.closeSession();
    await host.stop();
  });

  test("reprompt attempts follow the same per-execute conversation for owner and sibling", async () => {
    const queries: { marker: string; resume: string | undefined }[] = [];
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (opts: any) => ({
        async *[Symbol.asyncIterator]() {
          const marker = markerOf(String(opts.prompt), opts.options?.resume);
          const resume = opts.options?.resume as string | undefined;
          queries.push({ marker, resume });
          if (marker === "owner") await new Promise((r) => setTimeout(r, 40));
          // Never finalizes: the adapter exhausts MAX_FINALIZE_ATTEMPTS (1
          // initial + 2 reprompts), each resuming the SAME per-execute
          // conversation.
          yield {
            type: "result",
            subtype: "success",
            result: `done-${marker}`,
            duration_ms: 10,
            num_turns: 1,
            total_cost_usd: 0,
            session_id: `claude-${marker}`,
          };
        },
        close() {},
        async interrupt() {},
      }),
      createSdkMcpServer: (opts: any) => new MockMcpServer(opts),
    }));

    const mod = await import(`${adapterPath}?${Date.now()}`);
    const host = new TestHost({ config: mod.adapterConfig });
    await host.start();
    const client = (host as any).client;

    await host.openSession({ sessionId: "session-one", config: { claude_executable: FAKE_CLI } });

    await executeOnSession(client, {
      sessionId: "session-one",
      stepName: "seed",
      input: { prompt: "seed step" },
      allowedOutcomes: [],
    });

    const ownerDone = executeOnSession(client, {
      sessionId: "session-one",
      stepName: "owner",
      input: { prompt: "owner task" },
      allowedOutcomes: ["success"],
    });
    // The owner runs 1 initial + 2 reprompt queries; wait until its initial
    // query is in flight before starting the sibling.
    await waitFor(() => queries.length >= 2);

    const siblingDone = executeOnSession(client, {
      sessionId: "session-one",
      stepName: "sibling",
      input: { prompt: "sibling task" },
      allowedOutcomes: ["success"],
    });
    await Promise.all([ownerDone, siblingDone]);

    const byMarker = new Map<string, (string | undefined)[]>();
    for (const q of queries) {
      if (!byMarker.has(q.marker)) byMarker.set(q.marker, []);
      byMarker.get(q.marker)!.push(q.resume);
    }

    // Owner: resumes the stored chain, then its own conversation for both
    // reprompt attempts.
    expect(byMarker.get("owner")).toEqual(["claude-seed", "claude-owner", "claude-owner"]);
    // Sibling: fresh conversation, then reprompts follow ITS OWN conversation
    // (claude-sibling), never the owner's chain.
    expect(byMarker.get("sibling")).toEqual([undefined, "claude-sibling", "claude-sibling"]);

    await host.closeSession();
    await host.stop();
  });
});
