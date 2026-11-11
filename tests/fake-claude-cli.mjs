#!/usr/bin/env node
// Fake Claude Code CLI for the KB-391/396 real-CLI conformance harness.
//
// Speaks just enough of the agent-SDK stream-json control protocol to let
// tests/real-cli-surface.test.ts drive the REAL @anthropic-ai/claude-agent-sdk
// against the REAL adapter spawn path (pathToClaudeCodeExecutable -> child
// process -> control_request/response frames), with per-step submit_outcome
// tool surfaces arriving through the SDK MCP bridge exactly as they would
// from the real CLI:
//
//   1. On start, appends one JSON line to <cwd>/fake-cli-spawns.jsonl with the
//      spawn argv, the --resume value if any, and the session id it reports.
//   2. Emits the system/init message the SDK and adapter consume to learn the
//      session id (this is what makes same-id resume observable).
//   3. Per user message: emits an assistant tool_use block, lists the
//      criteria-workflow MCP tools via a control_request (this is the
//      per-step surface the adapter's model would see; logged to
//      fake-cli-tools.jsonl), then calls submit_outcome with scripted
//      arguments taken from line N of <cwd>/fake-cli-script.jsonl where N is
//      this spawn's index. The tools/call response is logged verbatim to
//      fake-cli-calls.jsonl.
//   4. On a successful submit: emits a user tool_result plus a result message
//      and exits, ending the adapter's message stream. On a rejected submit:
//      emits a result so the adapter's reprompt loop drives the next spawn.
//   5. Exits on stdin end / SIGTERM / SIGINT, mirroring a CLI whose owning
//      SDK-side query was aborted.
//
// Script line N for spawn N may be `null` (JSON "null"): the CLI then skips
// the submit and just ends its turn with a result message.
import * as fs from "node:fs";
import * as path from "node:path";

const cwd = process.cwd();

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function countLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

// The spawn index is derived from the spawn log BEFORE this spawn appends its
// own record: the first process of the suite is index 0, and log lines line up
// with process starts without any cross-process coordination.
const spawnIndex = countLines(path.join(cwd, "fake-cli-spawns.jsonl"));

const resume = argValue("--resume") ?? null;
const sessionId = argValue("--session-id") ?? resume ?? `sess-fake-${spawnIndex}`;

fs.appendFileSync(
  path.join(cwd, "fake-cli-spawns.jsonl"),
  JSON.stringify({
    spawn: spawnIndex,
    argv: process.argv.slice(2),
    resume,
    sessionId,
  }) + "\n"
);

let buffer = "";
let stdinClosed = false;
let initialized = false;
const bufferedUserMessages = [];

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function emitSystemInit() {
  writeMessage({
    type: "system",
    subtype: "init",
    cwd,
    session_id: sessionId,
    tools: [],
    mcp_servers: [{ name: "criteria-workflow", status: "connected" }],
    model: "fake",
    permissionMode: "default",
    slash_commands: [],
    version: "0.0.0-fake",
  });
}

// Sends a control_request to the SDK and resolves with the inner response of
// the control_response the SDK wrote back (e.g. {mcp_response: {jsonrpc, id,
// result}} for mcp_message subtypes). Rejects on exit/abort.
let nextRequestId = 1;
/** @type {Map<number, {resolve: (v: any) => void; reject: (e: Error) => void}>} */
const pendingControl = new Map();

function controlRequest(request) {
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    pendingControl.set(requestId, { resolve, reject });
    writeMessage({ request_id: requestId, type: "control_request", request });
    if (stdinClosed) reject(new Error("stdin closed"));
  });
}

function resolveControlResponse(line) {
  const msg = JSON.parse(line);
  if (msg.type !== "control_response") return false;
  const pending = pendingControl.get(msg.response?.request_id);
  if (!pending) return true; // not ours; ignore
  pendingControl.delete(msg.response?.request_id);
  if (msg.response?.subtype === "error") {
    pending.reject(new Error(`control error: ${JSON.stringify(msg.response)}`));
  } else {
    // Inner payload of the success envelope.
    pending.resolve(msg.response?.response ?? null);
  }
  return true;
}

// Normalizes the two plausible mcp_message shapes into the JSON-RPC result.
function unwrapMcp(inner) {
  const envelope = inner?.mcp_response ?? inner ?? {};
  return envelope.result ?? envelope;
}

function readNthLine(file, n) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  return n >= 0 && n < lines.length ? JSON.parse(lines[n]) : null;
}

async function runTurn(userMessage) {
  const text =
    userMessage?.message?.content?.find?.((b) => b?.type === "text")?.text ?? "";

  writeMessage({
    type: "assistant",
    session_id: sessionId,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: `fake CLI processing: ${text.slice(0, 80)}` },
        {
          type: "tool_use",
          id: `toolu-${spawnIndex}`,
          name: "mcp__criteria-workflow__submit_outcome",
          input: {},
        },
      ],
    },
    parent_tool_use_id: null,
  });

  // Model-visible per-step surface: ask the SDK MCP bridge to list tools.
  // The SDK connects the criteria-workflow transport asynchronously, so an
  // early attempt can legitimately fail; retry briefly instead of surfacing
  // an empty tool list.
  let tools = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const list = await controlRequest({
        subtype: "mcp_message",
        server_name: "criteria-workflow",
        message: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      const listed = unwrapMcp(list)?.tools ?? [];
      if (listed.length > 0 || attempt === 39) {
        tools = listed;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  fs.appendFileSync(
    path.join(cwd, "fake-cli-tools.jsonl"),
    JSON.stringify({ spawn: spawnIndex, sessionId, tools }) + "\n"
  );

  // Scripted submit arguments, if this spawn has a script line.
  let submitArgs = null;
  try {
    submitArgs = readNthLine(path.join(cwd, "fake-cli-script.jsonl"), spawnIndex);
  } catch {
    submitArgs = null;
  }
  if (submitArgs != null) {
    let callResult = null;
    let callError = null;
    try {
      callResult = unwrapMcp(
        await controlRequest({
          subtype: "mcp_message",
          server_name: "criteria-workflow",
          message: {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "submit_outcome", arguments: submitArgs },
          },
        })
      );
    } catch (e) {
      callError = e instanceof Error ? e.message : String(e);
    }
    fs.appendFileSync(
      path.join(cwd, "fake-cli-calls.jsonl"),
      JSON.stringify({
        spawn: spawnIndex,
        sessionId,
        args: submitArgs,
        error: callError,
        isError: callResult?.isError === true,
        content: callResult?.content ?? null,
      }) + "\n"
    );
  }

  const turnResult =
    submitArgs != null
      ? "fake CLI submitted an outcome"
      : `fake CLI has no script line ${spawnIndex}; ending turn`;

  writeMessage({
    type: "user",
    session_id: sessionId,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu-${spawnIndex}`,
          content: [{ type: "text", text: turnResult }],
        },
      ],
    },
    parent_tool_use_id: null,
  });

  writeMessage({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    session_id: sessionId,
    result: turnResult,
  });

  // End this process after the turn: the adapter's stream terminates with the
  // process exit, mirroring a one-turn CLI run. A rejected submit makes the
  // adapter reprompt, which spawns the next process (script line N+1).
  flushAndExit();
}

function flushAndExit(exitCode = 0) {
  // process.exit can truncate pipe-buffered stdout writes under Bun; give the
  // event loop a tick to flush the turn messages first.
  setTimeout(() => process.exit(exitCode), 50);
}

function processLine(line) {
  if (line.trim() === "") return;
  if (resolveControlResponse(line)) return;
  const msg = JSON.parse(line);
  if (msg.type === "control_request") {
    // initialize and other setup subtypes: answer success so the SDK finishes
    // its handshake (the SDK reads models/commands arrays off the response).
    writeMessage({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: msg.request_id,
        response: { commands: [], models: [], mcp_servers: [], slash_commands: [] },
      },
    });
    if (!initialized && msg.request?.subtype === "initialize") {
      initialized = true;
      emitSystemInit();
      for (const pending of bufferedUserMessages.splice(0)) {
        void runTurn(JSON.parse(pending));
      }
    }
    return;
  }
  if (msg.type === "user") {
    if (initialized) void runTurn(msg);
    else bufferedUserMessages.push(line);
    return;
  }
  // Any other message type is ignored.
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    processLine(line);
  }
});
process.stdin.on("end", () => {
  stdinClosed = true;
  flushAndExit(0);
});
process.on("SIGTERM", () => flushAndExit(0));
process.on("SIGINT", () => flushAndExit(0));
