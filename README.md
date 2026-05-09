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

### Build

```bash
bun install
bun run build
```

### Install into Criteria

```bash
bun run binary:install
# or manually:
cp bin/criteria-adapter-claude-agent ~/.criteria/plugins/
```

## Configuration

### Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | API key for Anthropic first-party access |
| `ANTHROPIC_AUTH_TOKEN` | Alternative auth token (e.g. for Bedrock / Vertex via proxy) |
| `ANTHROPIC_BASE_URL` | Override the API base URL |

These can also be supplied as adapter config fields (see below), which takes precedence over environment variables.

### Adapter Config Fields

Declared on the `adapter` block. Shared across all steps that use this adapter instance.

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | no | Model to use, e.g. `claude-sonnet-4-6`. Falls back to the Claude Code CLI default. |
| `cwd` | string | no | Working directory for the agent. Defaults to the process working directory. |
| `system_prompt` | string | no | Additional system prompt appended to every execute call. Outcome instructions are always prepended automatically. |
| `thinking` | bool | no | Enable adaptive thinking mode (`true`/`false`). |
| `api_key` | string | no | Sets `ANTHROPIC_API_KEY` for this adapter instance. |
| `auth_token` | string | no | Sets `ANTHROPIC_AUTH_TOKEN` for this adapter instance. |
| `base_url` | string | no | Sets `ANTHROPIC_BASE_URL` for this adapter instance. |

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

If the agent finishes without calling `submit_outcome`:

- If `needs_review` is in the step's declared outcomes, `needs_review` is emitted.
- Otherwise, `failure` is emitted.

## Adapter Events

The adapter emits structured events you can observe via Criteria's event stream.

| Event | Payload | Description |
|---|---|---|
| `agent.message` | `{ content: string }` | Text block produced by the assistant. |
| `tool.progress` | `{ tool: string, message: string }` | Progress update from a tool invocation. |
| `query.complete` | `{ durationMs, turns, costUsd }` | Query completed successfully. |
| `query.error` | `{ subtype: string, errors: string[] }` | Query ended with an error. |
| `outcome.failure` | `{ reason: string }` | Emitted when the agent finishes without submitting an outcome. |

## Workflow Example

```hcl
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

  outcome "success"      { next = "test" }
  outcome "needs_review" { next = "review" }
  outcome "failure"      { next = "failed" }
}
```

## How it works

1. `execute()` spawns a Claude Code query via the agent SDK `query()` call.
2. A custom MCP server is injected with a `submit_outcome` tool. The allowed outcome names are passed to the agent in its system context.
3. The agent works autonomously using its built-in tools to read, edit, and run commands.
4. Permission requests from the agent are forwarded to Criteria via `sender.permissionRequest()` and resolved when the operator responds.
5. When the agent calls `submit_outcome`, the query is interrupted and the workflow transitions to the next state.

## Session persistence

A Claude Code session ID is captured after the first execute call and reused for subsequent calls within the same Criteria session. This gives the agent memory across workflow steps without leaking context from unrelated prior sessions.
