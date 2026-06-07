# Dependency-freshness & supply-chain policy

This adapter follows the same two locked mandates as the
[Criteria monorepo](https://github.com/brokenbots/criteria/blob/main/docs/dependency-policy.md).
Each adapter repo owns its own copy; this file is the local authority. It applies
to every ecosystem we vendor: this package's npm/bun dependencies and the GitHub
Actions used in CI.

## 1. Stay current — latest major.minor

Be on the **latest major and minor** of every dependency. Patch versions roll up
freely *within* the cooldown rule below.

The only reason to pin **below** latest is a concrete one:

- a newer version has a **known security vulnerability** that affects us, or
- a newer version carries a **bug we are actually hit by**.

Any such pin is a documented, dated exception — see
[Holding a dependency below latest](#holding-a-dependency-below-latest).

## 2. Defend against supply-chain attacks — 7-day cooldown

Do **not** adopt any release **newer than 7 days** unless it fixes a known
security issue or a specific bug we're hit by. A freshly-published (and possibly
compromised) release gets a cooldown window before we ingest it.

**Security updates bypass the cooldown** — availability of a fix outranks the
supply-chain wait.

## How freshness & vulnerabilities are tracked — no update bot

This repo deliberately runs **no automated dependency-update bot** (no Dependabot
/ Renovate). The dependency surface is small (the SDK is a local `file:` sibling;
the only external runtime dep is the model SDK), so freshness is managed by
review against the tooling below rather than a stream of bot PRs:

| Command | Tool | Answers |
| --- | --- | --- |
| `bun run vuln-scan` | [`osv-scanner`](https://github.com/google/osv-scanner) | Which deps carry a known advisory (reads `bun.lock`). **CI gate (WS49).** |
| `bun run deps:outdated` | `bun outdated` | Which deps are behind their latest version. |

- **`osv-scan`** runs in CI on every PR/push (pinned `google/osv-scanner-action`)
  and is a **required, blocking** check — no shipping known vulnerabilities.
- **`deps-report`** runs `bun outdated` non-blocking and posts the result to the
  job summary, so drift is visible without flaking the build.

Applying upgrades (honor the 7-day cooldown unless it's a security/bug fix):

```bash
bun update <pkg>            # minor/patch within range
bun update <pkg> --latest   # move to the latest, incl. major
```

After any upgrade: `bun install`, `bun run build`, `bun test`, `bun run vuln-scan`.

## Holding a dependency below latest

To pin a dependency below its latest version, record it as a dated exception so
the decision is auditable and re-reviewed — mirroring the `osv-scanner.toml`
"documented + dated" convention. Add an entry below citing the advisory or bug id
and a review date; pin the constraint in `package.json`.

| Dependency | Held at | Reason (advisory / bug) | Review by |
| --- | --- | --- | --- |
| _none_ | | | |

On the review date the exception must be cleared or re-justified.
