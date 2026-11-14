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

## Root cause — PROVEN (stress3/sdk-12.log + stress2/out-2.log)
- SDK server-v2 `Permissions` handler drains the PROCESS-WIDE `sessions` map on
  ANY of its call's terminal events ('end' | 'error' | 'cancelled'); drain denies
  every pending permission of EVERY session in the bun process.
- SDK `TestHost.stop()` = bare `client.close()` (NO per-stream cancels) and kicks
  `stopServerV2(...)` off WITHOUT awaiting it. Under load the transport
  reap fires a stale server's Permissions 'cancelled' ~98-500ms AFTER its stop,
  landing inside a LATER test's live turn.
- run-12 smoking gun: `stop.server srvb3hbg0d` @...78256 → `cancelled
  srvb3hbg0d#p9` @...78354 → global drain with 50 LIVE pendings of the current
  50-parallel session (b0259kjzuzjmwgkrh5y) → exec cancelled @...78356 →
  permissionCount=1/50. delayed-grants (stress2 exact CI message): same stale
  drain denies request #1 mid-turn ⇒ mock generator dies ⇒ #2 never emitted ⇒
  waitRouted(2) 15s expires. 50-parallel write seq 16-50 writeOk:false = gRPC
  flow-control backpressure (harmless alone), deliveries land ~200ms later,
  i.e. AFTER the drain had already cleared the pendings.
- Router trace confirms: router read the burst only ~200ms after it was
  emitted; grant writes landed after pendings were cleared ⇒ no-ops.
- SDK facts: createHelpers per-Execute (scoped OK); permissionHelper.request
  has no await before write; drainStreams loop is module-level `sessions` map;
  SDK testing TestHost has cancelPermissionsStream()/cancelLogStream() but
  never calls them at stop().

## Fix design (adapter repo, option 1: harness owns stream lifecycle)
- `shutdownTestHost(host)` in tests/helpers.ts — ordered teardown counterpart
  of SDK TestHost.stop() (mirrors client→server→child, adds await):
  1. release() the host's PermissionRequestRouter (client-side cancel of the
     perms stream while the channel is open) + cancel SDK-owned log/perm
     streams (cancelLogStream/cancelPermissionsStream are public);
  2. client.close();
  3. AWAIT stopServerV2(server) — tryShutdown resolves only after every
     in-flight call completed ⇒ next test can never start inside a stale
     server's closing window ⇒ cross-server drain eliminated deterministically.
- All 79 `await host.stop()` sites in 7 files → `await shutdownTestHost(host)`.
- Deterministic regression test pins: teardown with an OUTSTANDING pending
  delivers that pending's typed drain denial to the adapter turn BEFORE
  shutdown resolves (denials == ["Permissions stream closed"]); then a fresh
  host's pending resolves allow (no stale event can touch it).

## Notes
- Fix must live in the adapter repo (CI checks out SDK @ main — an SDK-side fix would not
  reach this PR's CI; SDK-side splitting requires push access + PR there, escalatable).
- grpc-js 1.14.4: Server.tryShutdown may be called twice (second waits on the
  same close callbacks or fires immediately if map already empty — still safe), but
  shutdownTestHost mirrors stop() manually (single shutdown per server).
- Evidence artifacts: /tmp/kb402/stress{1,2,3}/ (out-N.log, sdk-N.log, router-N.log).
- SDK copy at /data/intake/KB-402/criteria-typescript-adapter-sdk is INSTRUMENTED for
  diagnosis; MUST be restored pristine @main + rebuilt before final validation.
