# Example Criteria workflow using the claude-code adapter
# This controls the actual Claude Code CLI agent (not the Anthropic API SDK)

step "analyze" {
  adapter = "claude-code"
  config {
    model = "claude-sonnet-4-6"
  }
  input {
    prompt = "Analyze this codebase for security issues and report your findings"
  }
  outcome "clean"    { transition_to = "deploy" }
  outcome "issues_found" { transition_to = "review" }
  outcome "failure"  { transition_to = "failed" }
}

step "review" {
  adapter = "claude-code"
  input {
    prompt = "Review the previous analysis and create a detailed remediation plan"
  }
  outcome "approved" { transition_to = "fix" }
  outcome "rejected" { transition_to = "failed" }
}

step "fix" {
  adapter = "claude-code"
  input {
    prompt = "Apply the approved remediation plan to the codebase"
  }
  outcome "success" { transition_to = "deploy" }
  outcome "failure" { transition_to = "failed" }
}

step "deploy" {
  adapter = "claude-code"
  input {
    prompt = "Run the deployment tests and verify everything passes"
  }
  outcome "success" { transition_to = "done" }
  outcome "failure" { transition_to = "failed" }
}
