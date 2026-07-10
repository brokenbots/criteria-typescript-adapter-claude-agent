#!/usr/bin/env bun
/**
 * Compile the adapter binary, baking the version in at build time.
 *
 * PLUGIN_VERSION is injected via `--define` so the version the running adapter
 * reports (Info RPC / OCI manifest) always matches the release it was built
 * from, instead of a constant hand-edited in source that silently drifts.
 *
 * Version precedence: $PLUGIN_VERSION (set by the release workflow from the
 * git tag) > package.json "version" > "0.0.0-dev". The last is what a plain
 * `bun test` sees, since nothing defines it there.
 *
 * Usage: bun scripts/build.ts [--target=<bun-target>] [--outfile=<path>]
 */
import pkg from "../package.json" with { type: "json" };

const args = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const version = process.env.PLUGIN_VERSION || pkg.version || "0.0.0-dev";
const target = arg("target");
const outfile = arg("outfile") ?? "bin/criteria-adapter-claude-agent";

const cmd = [
  "bun",
  "build",
  "--compile",
  ...(target ? [`--target=${target}`] : []),
  "--define",
  `process.env.PLUGIN_VERSION="${version}"`,
  "index.ts",
  "--outfile",
  outfile,
];

console.error(`building ${outfile} as version ${version}${target ? ` (${target})` : ""}`);

const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
const code = await proc.exited;
process.exit(code);
