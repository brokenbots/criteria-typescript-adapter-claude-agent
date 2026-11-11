/**
 * Suite-facing contract test for the real-CLI conformance harness.
 *
 * The harness that drives the adapter's real spawn path against the
 * @anthropic-ai/claude-agent-sdk must run in a process untouched by the rest
 * of the suite: Bun's test runner shares one process (and one module
 * registry) across test files, so any sibling file that calls
 * `mock.module("@anthropic-ai/claude-agent-sdk")` would leak into it and
 * silently replace the SDK the harness is supposed to exercise — fake query
 * objects resolve without ever spawning the CLI (observed as instant empty
 * harness fixtures, or a hung execute when a sibling's mock stalls).
 *
 * The harness therefore lives in `real-cli-surface.standalone.ts` — a
 * non-`.test` filename the default suite glob ignores — and this test runs
 * it as a child process so it always sees the real SDK. On failure the
 * child's output tail is forwarded into the assertion message.
 *
 * The CRITERIA_CLAUDE_CLI_CONTRACT=0 triage knob skips the child run here
 * as well (the harness itself re-checks the knob).
 */
import { test, expect } from "bun:test";
import * as path from "node:path";

const SKIP = process.env.CRITERIA_CLAUDE_CLI_CONTRACT === "0";

const repoRoot = path.resolve(import.meta.dir, "..");
const standalone = path.join(repoRoot, "tests", "real-cli-surface.standalone.ts");

test.skipIf(SKIP)(
  "real-CLI surface conformance harness passes in an isolated process (KB-391/396)",
  () => {
    const proc = Bun.spawnSync([process.execPath, "test", standalone], {
      cwd: repoRoot,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 200_000,
    });
    const output = (proc.stdout?.toString() ?? "") + (proc.stderr?.toString() ?? "");
    // Exit code only, deliberately: a missing/wrong path or any failing child
    // exits non-zero, and the child cannot silently self-skip (it gates on
    // the same CRITERIA_CLAUDE_CLI_CONTRACT knob as this parent's skipIf).
    expect(proc.exitCode, `real-CLI conformance harness failed; child output:\n${output.slice(-4000)}`).toBe(0);
  },
  240_000
);
