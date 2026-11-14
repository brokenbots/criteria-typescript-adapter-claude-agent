# KB-402 — permission stream delivery loss — working notes

## Facts
- CI failure (run 43610080981, head b9c6ea60 = KB-401 hono-only branch): delayed-grants —
  "permission router did not see 2 request(s) routed within 15000ms (1 routed so far: perm-...)".
- Local: bun 1.3.13 installed (session files/bun). SDK sibling cloned at
  /data/intake/KB-402/criteria-typescript-adapter-sdk (main 0d20c0c = CI's ref).
- Adapter worktree on branch KB-402 (779a067 = origin/main).
- Full-suite 8x/16x local contention (2-cpu cgroup): delayed-grants did NOT fail locally;
  failures reproduce in CRI-306 sibling-resume test (5/8) and CRI-31 stress (1/8), and
  "denied permission returns the host reason" under permission-only 8x (2/8).
- waitRouted(2) failing with 1 routed ⇒ canUseTool #1 must have failed to resolve as an
  ALLOW (mock never reaches canUseTool #2), because r1 must resolve before #2 is issued.
  ⇒ most consistent mechanism (run-8 evidence): SDK server-v2 Permissions-stream drain
  ("Permissions stream closed" denial) after client-side transport cancel mid-step.

## Plan
1. Instrument SDK copy (server-v2.js) to trace Execute permission.request writes,
   Permissions stream end/error/cancelled, drain events, teardown callbacks.
2. Stress full suite 8x with PERM_ROUTER_TRACE + SDK trace on; catch a failing instance.
3. Implement adapter-side true fix (option 1) — single dispatching consumer, no no-op
   sinks; plus (if needed AND SDK repo is out of reach) adapter/harness-level defense:
   deterministic test harness drives delivery; strict assertions unchanged.
4. Regression tests: delayed-grants deterministic delivery (order=[1,2]), 50-parallel
   stress unchanged (all 50 granted), plus typed no-silent-drop behavior tests.
5. Full suite + focused tests green; bun build (CI parity: tsc not available — bun tsc?).

## Notes
- Fix must live in the adapter repo (CI checks out SDK @ main — an SDK-side fix would not
  reach this PR's CI; SDK-side splitting requires push access + PR there, escalatable).
