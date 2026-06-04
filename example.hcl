# Example Criteria workflow using the claude-agent adapter (Protocol v2)
# This controls the actual Claude Code CLI agent (not the Anthropic API SDK)

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
  outcome "clean"        { next = "deploy" }
  outcome "issues_found" { next = "review" }
  outcome "failure"      { next = "failed" }
}

step "review" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Review the previous analysis and create a detailed remediation plan"
  }
  outcome "approved" { next = "fix" }
  outcome "rejected" { next = "failed" }
}

step "fix" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Apply the approved remediation plan to the codebase"
  }
  outcome "success" { next = "deploy" }
  outcome "failure" { next = "failed" }
}

step "deploy" {
  target = adapter.claude-agent.claude
  input {
    prompt = "Run the deployment tests and verify everything passes"
  }
  outcome "success" { next = "done" }
  outcome "failure" { next = "failed" }
}
