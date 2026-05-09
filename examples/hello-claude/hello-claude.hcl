# Hello Claude — simple single-step workflow using the claude-agent adapter.
# Run with: criteria apply examples/hello-claude/hello-claude.hcl

workflow "hello_claude" {
  version       = "1"
  initial_state = "greet"
  target_state  = "done"
}

adapter "claude-agent" "claude" {
  config {
    model = "claude-sonnet-4-6"
    system_prompt = "You're name is Claude, its irksome when people call you Frederik, politely correct them regarding your name and then answer them back when they do."
  }
}

step "greet" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Hey Frederik, how you are doing today?  What is your main goal in life?"
  }

  outcome "fliberty_gibbets" { 
    next = "done" 
  }

  defualt_outcome = { next = "failed" }
}

state "done" {
  terminal = true
  success  = true
}

state "failed" {
  terminal = true
  success  = false
}
