import { test } from "node:test";
import assert from "node:assert/strict";
import runtime from "../.build/provider-runtime.cjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const provider = {
  id: "fixture-provider",
  name: "Fixture Responses",
  kind: "responses",
  endpoint: "https://models.example.test/v1",
  model: "fixture-model",
  auth: "bearer",
  revision: 1,
  hasApiKey: true,
  createdAt: "",
  updatedAt: "",
};

test("provider API key is passed directly to Codex and never enters its environment", () => {
  const env = {};
  const config = {
    "shell_environment_policy.filters": { "AWS_*": "exclude" },
  };
  const secret = "arbitrary-provider-secret";

  runtime.applyProviderRuntime(provider, secret, env, config);

  assert.equal(env.NEXIOM_API_KEY, undefined);
  assert.equal(config["shell_environment_policy.exclude"], undefined);
  assert.deepEqual(config["shell_environment_policy.filters"], {
    "AWS_*": "exclude",
  });
  assert.deepEqual(config.model_providers, {
    nexiom: {
      name: provider.name,
      base_url: provider.endpoint,
      experimental_bearer_token: secret,
      wire_api: "responses",
      requires_openai_auth: false,
    },
  });
});

test("provider runtime rejects missing credentials and removes stale keys", () => {
  const env = { NEXIOM_API_KEY: "stale-secret" };
  assert.throws(
    () => runtime.applyProviderRuntime(provider, undefined, env, {}),
    /尚未配置 API Key/,
  );
  assert.equal(env.NEXIOM_API_KEY, undefined);
});

test("runtime requires an explicit private home and rejects legacy providers", async (t) => {
  assert.throws(() => new runtime.CodexRuntime(), /独立的绝对路径/);
  assert.throws(() => new runtime.CodexRuntime({ runtimeHome: ".codex" }), /独立的绝对路径/);
  const runtimeHome = await mkdtemp(path.join(tmpdir(), "nexiom-runtime-unit-"));
  t.after(() => rm(runtimeHome, { recursive: true, force: true }));
  const runner = new runtime.CodexRuntime({ runtimeHome });
  const legacy = { ...provider, kind: "local_codex" };
  assert.throws(() => runtime.applyProviderRuntime(legacy, undefined, {}, {}), /自己配置的 API/);
  await assert.rejects(runner.listModels(legacy), /自己配置的 API/);
  const status = await runner.probe(legacy);
  assert.equal(status.connected, false);
  assert.match(status.label, /自己配置的 API/);
});

test("runtime removes inherited agent credentials and uses a private home", async (t) => {
  const runtimeHome = await mkdtemp(path.join(tmpdir(), "nexiom-env-unit-"));
  const inherited = {
    CODEX_HOME: "host-codex-home",
    CODEX_THREAD_ID: "host-thread",
    OPENAI_API_KEY: "host-openai-key",
    OPENAI_BASE_URL: "https://host.example.test",
    ANTHROPIC_API_KEY: "host-anthropic-key",
    CLAUDE_CONFIG_DIR: "host-claude-home",
    NEXIOM_API_KEY: "stale-key",
    NEXIOM_TEST_API_KEY: "test-key",
  };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(runtimeHome, { recursive: true, force: true });
  });
  Object.assign(process.env, inherited);
  const env = runtime.runtimeEnvironment("tools", runtimeHome);
  for (const key of Object.keys(inherited).filter(key => key !== "CODEX_HOME"))
    assert.equal(env[key], undefined, key);
  assert.equal(env.CODEX_HOME, runtimeHome);
  assert.equal(env.HOME, path.join(runtimeHome, "home"));
  assert.equal(env.USERPROFILE, path.join(runtimeHome, "home"));
  assert.ok(Object.keys(env).some(key => key.toLowerCase() === "path"));
});
