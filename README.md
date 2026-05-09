# Claude Code Adapter for Criteria

This adapter controls the **actual Claude Code CLI agent** (not the Anthropic API SDK) via `@anthropic-ai/claude-agent-sdk`. The agent can read files, run shell commands, edit code, use MCP servers, and perform all the operations available in the interactive Claude Code CLI.

## Differences from the `claude` example

The existing `examples/claude` adapter uses `@anthropic-ai/sdk` to call the Anthropic Messages API directly. That approach:
- Requires you to implement every tool yourself
- Cannot run shell commands or edit files natively
- Is essentially a chatbot wrapper

This `claude-code` adapter uses the **Agent SDK**, which:
- Spawns the real Claude Code CLI subprocess
- Gives the agent full access to built-in tools (`Read`, `Edit`, `Bash`, `Glob`, `Grep`, etc.)
- Bridges permission requests to Criteria's permission system
- Lets the agent operate on the actual filesystem

## Installation

### Prerequisites

- [Bun](https://bun.sh/) >= 1.2.0
- Claude Code CLI installed and authenticated (`claude` command available)

### Build

```bash
cd examples/claude-code
bun install
bun run build
```

### Install into Criteria

```bash
cp criteria-adapter-claude-code ~/.criteria/plugins/
chmod +x ~/.criteria/plugins/criteria-adapter-claude-code
```

## Configuration

### Environment Variables

- `ANTHROPIC_API_KEY` - Required for first-party API access.

### Adapter Config

```hcl
step "refactor" {
  adapter = "claude-code"
  config {
    model = "claude-sonnet-4-6"
    cwd   = "/home/user/myproject"
  }
  input {
    prompt = "Refactor the auth module to use OAuth2"
  }
  outcome "success" { transition_to = "test" }
  outcome "failure" { transition_to = "review" }
}
```

## How it works

1. `execute()` spawns a Claude Code query via `query()` from the agent SDK.
2. A custom MCP server is injected with a `submit_outcome` tool.
3. The agent works autonomously, using its built-in tools to read/edit/run commands.
4. Permission requests from the agent are forwarded to Criteria via `sender.permissionRequest()`.
5. When the agent calls `submit_outcome`, the query is interrupted and the workflow proceeds with the chosen outcome.

## Session persistence

Sessions are persisted to `~/.claude/projects/` by default. Subsequent `execute()` calls within the same Criteria session will resume the previous Claude Code session so the agent retains context across workflow steps.
# criteria-typescript-adapter-claude-agent
