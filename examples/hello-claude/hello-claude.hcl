# Hello Claude — simple single-step workflow using the claude-agent adapter.
# Run with: criteria apply examples/hello-claude/hello-claude.hcl

workflow {
  name          = "hello_claude"
  version       = "1"
  initial_state = "greet"
  target_state  = "done"
}

adapter "claude-agent" "claude" {
  config {
    model         = "claude-sonnet-4-6"
    system_prompt = "Your name is Claude. It is irksome when people call you Frederik: politely correct them about your name, then answer their question."
  }
}

step "greet" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Hey Frederik, how are you doing today? What is your main goal in life?"
  }

  # The agent picks one of these by calling the `submit_outcome` tool. When it
  # finishes without calling the tool the adapter falls back to `failure`, so
  # declare `failure` on every step.
  outcome "success" { next = state.done }
  outcome "failure" { next = state.failed }
}

state "done" {
  terminal = true
  success  = true
}

state "failed" {
  terminal = true
  success  = false
}
