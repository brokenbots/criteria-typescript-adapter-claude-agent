# Claude Agent Adapter for Criteria

Controls the **Claude Code CLI agent** (not the Anthropic API SDK) via `@anthropic-ai/claude-agent-sdk`. The agent can read files, run shell commands, edit code, use MCP servers, and perform all built-in Claude Code operations.

Unlike a plain API wrapper, this adapter:
- Spawns the real Claude Code CLI subprocess
- Gives the agent full access to built-in tools (`Read`, `Edit`, `Bash`, `Glob`, `Grep`, etc.)
- Bridges permission requests to Criteria's permission system
- Persists session context across workflow steps

## Installation

### Prerequisites

- [Bun](https://bun.sh/) >= 1.2.0
- Claude Code CLI installed and authenticated (`claude` command available)

The compiled adapter binary does not embed the Claude Code CLI: `bun build
--compile` cannot bundle the per-platform native binary that
`@anthropic-ai/claude-agent-sdk` resolves at runtime. The adapter therefore
locates `claude` on `PATH` (override with the `claude_executable` config field),
and any image shipping this adapter must install the CLI alongside it.

### Build

```bash
bun install
bun run build
```

### Install into Criteria

```bash
bun run binary:install
# or manually:
cp bin/criteria-adapter-claude-agent ~/.criteria/adapters/
```

## Configuration

### Secrets

The adapter reads the following secrets via `helpers.secrets.get()`. Configure them in your Criteria environment or orchestrator secret store.

| Secret | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | no | API key for Anthropic first-party access. If unset, the Claude Code CLI falls back to its own stored credentials (e.g. `claude` login / OAuth). |
| `ANTHROPIC_AUTH_TOKEN` | no | Alternative auth token (e.g. for Bedrock / Vertex via proxy) |

### Adapter Config Fields

Declared on the `adapter` block. Shared across all steps that use this adapter instance.

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | no | Model to use, e.g. `claude-sonnet-4-6`. Falls back to the Claude Code CLI default. |
| `cwd` | string | no | Working directory for the agent. Defaults to the process working directory. |
| `system_prompt` | string | no | Additional system prompt for every execute call. The outcome instructions are always appended after it. |
| `thinking` | boolean | no | Enable adaptive thinking mode (`true`/`false`). |
| `claude_executable` | string | no | Path to the Claude Code CLI. Defaults to `claude` on `PATH`. |
| `base_url` | string | no | Override the Anthropic API base URL. Falls back to the `ANTHROPIC_BASE_URL` environment variable. |

### Step Input Fields

Declared in the `input {}` block of each step that targets this adapter.

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | **yes** | The task prompt sent to the Claude Code agent. |
| `model` | string | no | Per-step model override. Takes precedence over the adapter-level `model`. |

## Outputs

When the agent finishes a step it calls the built-in `submit_outcome` MCP tool, which triggers the step result. The result payload has the following fields:

| Field | Type | Description |
|---|---|---|
| `outcome` | string | One of the outcome names declared on the step. |
| `reason` | string | Optional explanation provided by the agent. |
| `output` | string | The agent's final text output (when present). |

### Fallback outcomes

Calling `submit_outcome` is model behaviour, not a guarantee — the agent will
sometimes answer a prompt and stop. When that happens the adapter re-prompts it
to make the tool call, up to 3 times, emitting an `outcome.reprompt` event each
time.

If the agent still has not called `submit_outcome`:

- If `needs_review` is in the step's declared outcomes, `needs_review` is emitted.
- Otherwise, `failure` is emitted.

Declare `failure` (or `needs_review`) on every step so this fallback has a
transition to take.

## Adapter Events

The adapter emits structured events you can observe via Criteria's event stream.

| Event | Payload | Description |
|---|---|---|
| `agent.message` | `{ content: string }` | Text block produced by the assistant. |
| `tool.progress` | `{ tool: string, message: string }` | Progress update from a tool invocation. |
| `query.complete` | `{ durationMs, turns, costUsd }` | Query completed successfully. |
| `query.error` | `{ subtype: string, errors: string[] }` | Query ended with an error. |
| `outcome.reprompt` | `{ attempt, maxAttempts }` | The agent stopped without calling `submit_outcome`; it is being asked again. |
| `outcome.failure` | `{ reason: string, attempts: number }` | Emitted when the agent finishes without submitting an outcome. |

## Workflow Example

```hcl
workflow {
  name          = "refactor_auth"
  version       = "1"
  initial_state = "refactor"
  target_state  = "done"
}

adapter "claude-agent" "claude" {
  config {
    model         = "claude-sonnet-4-6"
    cwd           = "/home/user/myproject"
    system_prompt = "Be concise. Prefer small, focused changes."
  }
}

step "refactor" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Refactor the auth module to use OAuth2."
  }

  outcome "success"      { next = step.test }
  outcome "needs_review" { next = step.review }
  outcome "failure"      { next = state.failed }
}
```

A runnable single-step workflow lives in
[`examples/hello-claude/hello-claude.hcl`](examples/hello-claude/hello-claude.hcl).

## How it works

1. `execute()` spawns a Claude Code query via the agent SDK `query()` call.
2. A custom MCP server is injected with a `submit_outcome` tool. The allowed outcome names are passed to the agent in its system context.
3. The agent works autonomously using its built-in tools to read, edit, and run commands.
4. Permission requests from the agent are forwarded to Criteria via `helpers.permission.request()` and resolved when the operator responds.
5. When the agent calls `submit_outcome`, the outcome is recorded. Once the query finishes the workflow transitions to the next state.
6. If the query ends without a `submit_outcome` call, the adapter resumes the session and asks the agent again (up to 3 times) before taking the fallback outcome.

## Session persistence

A Claude Code session ID is captured after the first execute call and reused for subsequent calls within the same Criteria session. This gives the agent memory across workflow steps without leaking context from unrelated prior sessions.

## Security & dependencies

Supply-chain controls and the dependency-freshness policy are documented in
[SECURITY.md](SECURITY.md) and [docs/dependency-policy.md](docs/dependency-policy.md).
Reproduce the CI security checks locally:

```bash
bun run vuln-scan      # osv-scanner — blocking known-vulnerability gate (reads bun.lock)
bun run deps:outdated  # bun outdated — freshness report
```

## Publish (multi-platform)

Tagging `vX.Y.Z` cross-compiles `linux/amd64`, `linux/arm64`, and `darwin/arm64`
(`bun build --compile --target=…`) and publishes them as a single multi-platform,
signed OCI artifact to `ghcr.io/brokenbots/criteria-adapter-claude-agent:X.Y.Z` via
[`brokenbots/publish-adapter`](https://github.com/brokenbots/publish-adapter).
Pin and lock it in your workflow with `criteria adapter lock`.
