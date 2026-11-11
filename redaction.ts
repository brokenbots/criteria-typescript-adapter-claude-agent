/**
 * Shared redaction + canonicalization helpers (no workflow imports — both
 * contract.ts and outcome.ts need these and must not import each other).
 *
 * Redaction scope (parity with the copilot adapter): only verbatim
 * occurrences of secrets the adapter actually holds are removed. This is not
 * general-purpose secret detection, PII scrubbing, or entropy heuristics,
 * because those produce false positives that corrupt legitimate agent prose.
 */

/**
 * Placeholder used when a secret value the adapter holds appears in
 * agent-authored text (reason prose, payload renderings). The replacement is
 * visible so readers can see that something was removed, rather than silently
 * dropping it.
 */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Best-effort redaction of secret values the adapter actually holds.
 *
 * This only removes verbatim occurrences of secrets the adapter has received
 * (currently ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN). An agent's text may
 * still contain other repository or user content; consumers must decide where
 * to route it.
 */
export function sanitizeReason(reason: string, secrets: (string | undefined)[]): string {
  const toRedact = secrets
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    // Longer secrets first so a shorter value cannot slice a longer one.
    .sort((a, b) => b.length - a.length);

  let sanitized = reason;
  for (const value of toRedact) {
    // Escape regex metacharacters so the secret is matched literally.
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "g");
    sanitized = sanitized.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return sanitized;
}

/**
 * Canonical JSON: object keys sorted (byte layouts collapse), arrays in
 * order. Used both for surface digests (surface.ts) and payload digests
 * (contract.ts): semantically equal values hash equally regardless of key
 * order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${parts.join(",")}}`;
}
