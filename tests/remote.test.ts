import { describe, test, expect, mock, afterEach } from "bun:test";
import type { ServeConfig } from "@criteria/adapter-sdk";

interface ServeRemoteCall {
  config: ServeConfig;
  opts: {
    host: string;
    accept_token?: string;
    identity: {
      name?: string;
      version?: string;
      digest: string;
    };
  };
}

let serveCalls: Array<{ type: "serve" }> = [];
let serveRemoteCalls: ServeRemoteCall[] = [];

const mockedServe = mock(() => {
  serveCalls.push({ type: "serve" });
});
const mockedServeRemote = mock((config: ServeConfig, opts: ServeRemoteCall["opts"]) => {
  serveRemoteCalls.push({ config, opts });
});

mock.module("@criteria/adapter-sdk", () => ({
  serve: mockedServe,
  serveRemote: mockedServeRemote,
}));

// Use a relative path with a per-test query string so Bun evaluates a fresh
// copy of index.ts. file:// URLs with query strings are reused from Bun's
// module cache across files, which would capture the env vars from an earlier
// test's import.
const adapterPath = "../index.ts";

describe("claude-agent adapter remote mode", () => {
  afterEach(() => {
    serveCalls = [];
    serveRemoteCalls = [];
    delete process.env.CRITERIA_REMOTE_HOST;
    delete process.env.CRITERIA_REMOTE_TOKEN;
    delete process.env.CRITERIA_REMOTE_DIGEST;
    delete process.env.PLUGIN_VERSION;
  });

  test("detects CRITERIA_REMOTE_HOST and calls serveRemote with correct identity", async () => {
    process.env.CRITERIA_REMOTE_HOST = "criteria-host.example.com:7778";
    process.env.CRITERIA_REMOTE_TOKEN = "remote-token-123";
    process.env.CRITERIA_REMOTE_DIGEST = "sha256:abc123";
    process.env.PLUGIN_VERSION = "1.2.3";

    const mod = await import(`${adapterPath}?${Date.now()}`);
    await mod.main();

    expect(serveCalls).toHaveLength(0);
    expect(serveRemoteCalls).toHaveLength(1);

    const call = serveRemoteCalls[0];
    expect(call.config.name).toBe("claude-agent");
    expect(call.config.version).toBe("1.2.3");
    expect(call.opts.host).toBe("criteria-host.example.com:7778");
    expect(call.opts.accept_token).toBe("remote-token-123");
    expect(call.opts.identity).toEqual({
      name: "claude-agent",
      version: "1.2.3",
      digest: "sha256:abc123",
    });
  });

  test("omits accept_token when CRITERIA_REMOTE_TOKEN is not set", async () => {
    process.env.CRITERIA_REMOTE_HOST = "criteria-host.example.com:7778";
    process.env.CRITERIA_REMOTE_DIGEST = "sha256:def456";

    const mod = await import(`${adapterPath}?${Date.now()}`);
    await mod.main();

    expect(serveRemoteCalls).toHaveLength(1);
    expect("accept_token" in serveRemoteCalls[0].opts).toBe(false);
  });

  test("falls back to local serve() when CRITERIA_REMOTE_HOST is not set", async () => {
    const mod = await import(`${adapterPath}?${Date.now()}`);
    await mod.main();

    expect(serveRemoteCalls).toHaveLength(0);
    expect(serveCalls).toHaveLength(1);
  });

  test("throws a clear error when remote mode is requested without CRITERIA_REMOTE_DIGEST", async () => {
    process.env.CRITERIA_REMOTE_HOST = "criteria-host.example.com:7778";

    const mod = await import(`${adapterPath}?${Date.now()}`);
    await expect(mod.main()).rejects.toThrow(
      "CRITERIA_REMOTE_DIGEST is required when running in remote mode"
    );

    expect(serveRemoteCalls).toHaveLength(0);
    expect(serveCalls).toHaveLength(0);
  });
});
