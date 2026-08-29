# Agent Configuration Guide: Ollama Mode

When you need to point this adapter at a local Ollama instance instead of Anthropic's API, use the following adapter settings. These are the equivalents of the environment variables a direct Claude Code CLI user would set.

## Mapping

| Environment variable | Adapter setting | Value |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `base_url` config field | `http://localhost:11434` |
| `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_AUTH_TOKEN` secret | `ollama` |
| `ANTHROPIC_API_KEY` | Omit the secret | *(leave unset)* |
| Model name | `model` config field or `input.model` | `kimi-k2.7-code:cloud` |

## How to apply

### 1. Adapter config block

Set the base URL and default model in the `adapter` block:

```hcl
adapter "claude-agent" "local" {
  config {
    base_url = "http://localhost:11434"
    model    = "kimi-k2.7-code:cloud"
  }
}
```

### 2. Secrets

Provide the auth token through your Criteria host's secret mechanism (e.g. environment variable, vault, or CLI flag) so the adapter receives it via `helpers.secrets.get("ANTHROPIC_AUTH_TOKEN")`. Do **not** provide `ANTHROPIC_API_KEY`.

If running the adapter binary directly, you can also set the secret values as environment variables in the adapter's own process; the adapter forwards them to the Claude Code subprocess:

```bash
export ANTHROPIC_AUTH_TOKEN=ollama
# ANTHROPIC_API_KEY intentionally omitted
```

### 3. Per-step model override (optional)

Override the model for an individual step:

```hcl
step "generate" {
  target = adapter.claude-agent.local
  input {
    prompt = "Write a factorial function in Rust"
    model  = "kimi-k2.7-code:cloud"
  }
}
```

## Caveat

This adapter only **forwards** these values to the Claude Code CLI subprocess via the agent SDK. The underlying `claude` binary must itself support the specified `base_url`, `auth_token`, and model name for this to work.
