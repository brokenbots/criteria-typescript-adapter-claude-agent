# Example Criteria workflow using the claude-agent adapter (Protocol v2)
# This controls the actual Claude Code CLI agent (not the Anthropic API SDK)

workflow {
  name          = "claude_agent_example"
  version       = "1"
  initial_state = "analyze"
  target_state  = "done"
}

adapter "claude-agent" "claude" {
  config {
    model = "claude-sonnet-4-6"
  }
}

step "analyze" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Analyze this codebase for security issues and report your findings"
  }
  outcome "clean"        { next = step.deploy }
  outcome "issues_found" { next = step.review }
  outcome "failure"      { next = state.failed }
}

step "review" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Review the previous analysis and create a detailed remediation plan"
  }
  outcome "approved" { next = step.fix }
  outcome "rejected" { next = state.failed }
  outcome "failure"  { next = state.failed }
}

step "fix" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Apply the approved remediation plan to the codebase"
  }
  outcome "success" { next = step.deploy }
  outcome "failure" { next = state.failed }
}

step "deploy" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Run the deployment tests and verify everything passes"
  }
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
