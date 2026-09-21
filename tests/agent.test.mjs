import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import service from "../.build/service.cjs";

function runner(behavior) {
  return {
    calls: [],
    probes: [],
    modelRequests: [],
    async probe(provider, apiKey) {
      this.probes.push({ provider, apiKey });
      return {
        connected: true,
        available: true,
        authenticated: provider.auth === "none" || Boolean(apiKey),
        label: `Test fixture: ${provider.name}`,
        version: "fixture",
        hasApiKey: Boolean(apiKey),
        activeProviderId: provider.id,
        activeProviderName: provider.name,
        activeModel: provider.model || "fixture-model",
        activeModelProvider: "nexiom",
      };
    },
    async listModels(provider, apiKey) {
      this.modelRequests.push({ provider, apiKey });
      return provider.model ? [provider.model] : ["fixture-model"];
    },
    async *run(input) {
      this.calls.push(input);
      yield* behavior(input);
    },
  };
}
async function setup(t, runtime) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-agent-"));
  const core = new service.CoreService(dir, () => {}, { runner: runtime });
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  await core.request({
    type: "provider.upsert",
    provider: {
      id: "nexiom-default",
      name: "NEXIOM API",
      kind: "responses",
      endpoint: "http://127.0.0.1:1234/v1",
      model: "fixture-model",
      auth: "none",
    },
  });
  await core.request({ type: "runtime.check" });
  const { thread } = await core.request({
    type: "project.create",
    name: "Agent integration fixture",
  });
  return { core, thread, dir };
}
async function settled(core, runId) {
  for (let i = 0; i < 100; i++) {
    const snapshot = core.snapshot().snapshot;
    if (snapshot.runs.find((run) => run.id === runId).status !== "running")
      return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Fixture run did not terminate");
}
const requestFor = (thread, mode = "plan") => ({
  type: "agent.submit",
  threadId: thread.id,
  text: "Test task",
  mode,
  executionConfirmed: false,
  clientRequestId: randomUUID(),
});
async function* success() {
  yield { type: "thread.started", thread_id: "engine-thread-1" };
  yield {
    type: "item.started",
    item: {
      id: "cmd1",
      type: "command_execution",
      command: "python solve.py",
      aggregated_output: "",
      status: "in_progress",
    },
  };
  yield {
    type: "item.completed",
    item: {
      id: "cmd1",
      type: "command_execution",
      command: "python solve.py",
      aggregated_output: "42",
      status: "completed",
      exit_code: 0,
    },
  };
  yield {
    type: "item.completed",
    item: { id: "answer1", type: "agent_message", text: "Verified: 42" },
  };
  yield {
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 8 },
  };
}

test("agent runs and tool history are mirrored into the selected project folder", async (t) => {
  const runtime = runner(success);
  const { core, thread, dir } = await setup(t, runtime);
  const { runId } = await core.request(requestFor(thread));
  await settled(core, runId);
  const project = core.snapshot().snapshot.projects.find((item) => item.id === thread.projectId);
  const recordPath = path.join(project.root, ".nexiom", "project.json");
  let record;
  for (let i = 0; i < 100; i++) {
    record = JSON.parse(await readFile(recordPath, "utf8"));
    if (record.records.runs.find((item) => item.id === runId)?.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(record.records.runs.find((item) => item.id === runId).status, "succeeded");
  const recordedAgentRun = record.records.agentRuns.find((item) => item.runId === runId);
  assert.equal(recordedAgentRun.mode, "plan");
  assert.match(recordedAgentRun.usage, /input_tokens/);
  assert.equal(recordedAgentRun.providerId, null);
  assert.equal(recordedAgentRun.providerFingerprint, null);
  assert.equal(recordedAgentRun.runtimeConfig, null);
  assert.ok(record.records.agentItems.some((item) => item.runId === runId && item.status === "completed"));
  const recordedContextRow = record.records.agentContexts.find((item) => item.threadId === thread.id);
  assert.ok(recordedContextRow);
  assert.equal(JSON.parse(recordedContextRow.payload).engineThreadId, "");
  assert.equal("agentThreads" in record.records, false);

  await core.close();
  const restoredCore = new service.CoreService(path.join(dir, "restored-app-data"), () => {}, {
    runner: runner(success),
  });
  try {
    const restored = await restoredCore.openProject(project.root);
    assert.equal(restored.project.id, project.id);
    assert.equal(restored.snapshot.runs.find((item) => item.id === runId).providerId, null);
    assert.ok(restored.snapshot.items.some((item) => item.runId === runId));
    const restoredContext = restored.snapshot.contexts.find((item) => item.threadId === thread.id);
    assert.ok(restoredContext);
    assert.equal(restoredContext.engineThreadId, "");
  } finally {
    await restoredCore.close();
  }
});

test("portable Agent contexts drop native thread ids but retain token and compaction history", async (t) => {
  const runtime = runner(async function* () {
    yield { type: "thread.started", thread_id: "private-native-thread" };
    yield {
      type: "context.updated",
      modelContextWindow: 200000,
      totalTokens: 8000,
      lastInputTokens: 2000,
      lastOutputTokens: 300,
      cachedInputTokens: 1000,
      cacheWriteInputTokens: 250,
    };
    yield { type: "context.compacted", itemId: "native-compaction" };
    yield { type: "turn.completed", usage: null };
  });
  const { core, thread, dir } = await setup(t, runtime);
  await settled(core, (await core.request(requestFor(thread))).runId);
  const project = core.snapshot().snapshot.projects.find((item) => item.id === thread.projectId);
  const liveContext = core.snapshot().snapshot.contexts.find((item) => item.threadId === thread.id);
  assert.equal(liveContext.engineThreadId, "private-native-thread");
  assert.equal(liveContext.totalTokens, 8000);
  assert.equal(liveContext.compactions, 1);

  const record = JSON.parse(
    await readFile(path.join(project.root, ".nexiom", "project.json"), "utf8"),
  );
  const portableContext = JSON.parse(
    record.records.agentContexts.find((item) => item.threadId === thread.id).payload,
  );
  assert.equal(portableContext.engineThreadId, "");
  assert.equal(portableContext.totalTokens, 8000);
  assert.equal(portableContext.lastInputTokens, 2000);
  assert.equal(portableContext.cachedInputTokens, 1000);
  assert.equal(portableContext.cacheWriteInputTokens, 250);
  assert.equal(portableContext.compactions, 1);

  await core.close();
  const restoredCore = new service.CoreService(path.join(dir, "portable-context-app-data"), () => {}, {
    runner: runtime,
  });
  try {
    const restored = await restoredCore.openProject(project.root);
    const restoredContext = restored.snapshot.contexts.find((item) => item.threadId === thread.id);
    assert.equal(restoredContext.engineThreadId, "");
    assert.equal(restoredContext.totalTokens, 8000);
    assert.equal(restoredContext.lastInputTokens, 2000);
    assert.equal(restoredContext.lastOutputTokens, 300);
    assert.equal(restoredContext.cachedInputTokens, 1000);
    assert.equal(restoredContext.cacheWriteInputTokens, 250);
    assert.equal(restoredContext.compactions, 1);
  } finally {
    await restoredCore.close();
  }
});

test("fresh NEXIOM requires its own model and key even when global credentials exist", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-independent-default-"));
  const runtime = runner(success);
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "unrelated-global-key";
  const core = new service.CoreService(dir, () => {}, { runner: runtime });
  t.after(async () => {
    await core.close();
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    await rm(dir, { recursive: true, force: true });
  });
  let snapshot = (await core.request({ type: "runtime.check" })).snapshot;
  assert.equal(snapshot.settings.activeProviderId, "nexiom-default");
  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.providers[0].kind, "responses");
  assert.equal(snapshot.providers[0].model, "");
  assert.equal(snapshot.providers[0].hasApiKey, false);
  assert.equal(snapshot.runtime.connected, false);
  assert.match(snapshot.runtime.label, /模型 ID/);
  assert.equal(runtime.probes.length, 0);
  const { thread } = await core.request({ type: "project.create", name: "Private workspace" });
  assert.ok(path.resolve(core.snapshot().snapshot.projects[0].root).startsWith(path.resolve(dir) + path.sep));
  await assert.rejects(core.request(requestFor(thread)), /NEXIOM.*模型/);
  const provider = snapshot.providers[0];
  await core.request({ type: "provider.upsert", provider: { ...provider, model: "my-model" } });
  snapshot = (await core.request({ type: "runtime.check" })).snapshot;
  assert.equal(snapshot.runtime.connected, false);
  assert.match(snapshot.runtime.label, /API Key/);
  assert.equal(runtime.probes.length, 0);
  const tested = await core.request({ type: "provider.test", providerId: provider.id });
  assert.equal(tested.connectionCheck.ok, false);
  await assert.rejects(core.request({ type: "provider.models", providerId: provider.id }), /API Key/);
  assert.equal(runtime.modelRequests.length, 0);
  await core.request({ type: "provider.upsert", provider: { ...provider, model: "my-model" }, apiKey: "own-key" });
  const connected = await core.request({ type: "provider.test", providerId: provider.id });
  assert.equal(connected.connectionCheck.ok, true);
  snapshot = core.snapshot().snapshot;
  assert.equal(snapshot.runtime.connected, true);
  assert.equal(runtime.probes.at(-1).apiKey, "own-key");
  assert.equal(runtime.probes.at(-1).provider.model, "my-model");
  await settled(core, (await core.request(requestFor(thread))).runId);
  assert.equal(runtime.calls[0].apiKey, "own-key");
});

test("legacy local Codex configuration cannot be recreated or activated through IPC", async (t) => {
  const { core } = await setup(t, runner(success));
  await assert.rejects(core.request({
    type: "provider.upsert",
    provider: { id: "local-codex", name: "Local Codex", kind: "local_codex", auth: "none" },
  }), /不再支持本机 Codex/);
  await assert.rejects(core.request({ type: "provider.activate", providerId: "local-codex" }), /不再支持本机 Codex/);
  await assert.rejects(core.request({
    type: "runtime.configure", settings: { activeProviderId: "local-codex" },
  }), /不再支持本机 Codex/);
  assert.equal(core.snapshot().snapshot.settings.activeProviderId, "nexiom-default");
});

test("execution requires explicit confirmation, and request replay does not run twice", async (t) => {
  const runtime = runner(success);
  const { core, thread } = await setup(t, runtime);
  const command = requestFor(thread, "execute");
  await assert.rejects(core.request(command), /需要确认/);
  assert.equal(core.snapshot().snapshot.runs.length, 0);
  command.executionConfirmed = true;
  const { runId } = await core.request(command);
  const state = await settled(core, runId);
  assert.equal(state.runs[0].status, "succeeded");
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].item.aggregated_output, "42");
  assert.equal(state.items[0].status, "completed");
  assert.equal((await core.request(command)).runId, runId);
  assert.equal(runtime.calls.length, 1);
  await assert.rejects(
    core.request({ ...command, text: "Changed task" }),
    /不一致/,
  );
});
test("subsequent turns resume the engine thread with the current mode", async (t) => {
  const runtime = runner(success);
  const { core, thread } = await setup(t, runtime);
  const first = await core.request(requestFor(thread));
  await settled(core, first.runId);
  const second = await core.request({
    ...requestFor(thread, "execute"),
    executionConfirmed: true,
  });
  await settled(core, second.runId);
  assert.equal(runtime.calls[0].threadId, undefined);
  assert.equal(runtime.calls[1].threadId, "engine-thread-1");
  assert.equal(runtime.calls[1].mode, "execute");
});
test("a failed or incomplete stream never becomes a successful run", async (t) => {
  const runtime = runner(async function* () {
    yield {
      type: "turn.failed",
      error: { message: "provider failed sk-FAKESECRET123" },
    };
  });
  const { core, thread } = await setup(t, runtime);
  const { runId } = await core.request(requestFor(thread));
  const state = await settled(core, runId);
  assert.equal(state.runs[0].status, "failed");
  assert.ok(!JSON.stringify(state).includes("sk-FAKESECRET123"));
});

test("redacting secrets inside JSON tool output preserves a readable snapshot", async (t) => {
  const runtime = runner(async function* () {
    yield {
      type: "item.completed",
      item: {
        id: "json-output",
        type: "command_execution",
        command: "inspect fixture",
        status: "completed",
        exit_code: 0,
        aggregated_output: JSON.stringify({
          Authorization: "Bearer dummy-token",
          path: 'C:\\fixture\\quoted "name"',
          key: "sk-SECRET-FIXTURE",
        }),
      },
    };
    yield { type: "turn.completed", usage: null };
  });
  const { core, thread, dir } = await setup(t, runtime);
  const state = await settled(
    core,
    (await core.request(requestFor(thread))).runId,
  );
  assert.equal(state.runs[0].status, "succeeded");
  const output = JSON.parse(state.items[0].item.aggregated_output);
  assert.equal(output.Authorization, "Bearer [已隐藏]");
  assert.equal(output.path, 'C:\\fixture\\quoted "name"');
  assert.ok(!JSON.stringify(state).includes("dummy-token"));
  assert.ok(!JSON.stringify(state).includes("sk-SECRET-FIXTURE"));
  await core.close();
  const reopened = new service.CoreService(dir, () => {}, { runner: runtime });
  assert.deepEqual(
    reopened.snapshot().snapshot.items[0].item,
    state.items[0].item,
  );
  await reopened.close();
});
test("cancel aborts the runtime and persists an interrupted tool item", async (t) => {
  const runtime = runner(async function* (input) {
    yield {
      type: "item.started",
      item: {
        id: "cmd",
        type: "command_execution",
        command: "long command",
        aggregated_output: "",
        status: "in_progress",
      },
    };
    await new Promise((resolve, reject) => {
      input.signal.addEventListener(
        "abort",
        () => reject(new Error("Aborted")),
        { once: true },
      );
    });
  });
  const { core, thread } = await setup(t, runtime);
  const { runId } = await core.request(requestFor(thread));
  while (!core.snapshot().snapshot.items.length)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await core.request({ type: "run.cancel", runId });
  const state = await settled(core, runId);
  assert.equal(state.runs[0].status, "cancelled");
  assert.equal(state.items[0].status, "interrupted");
  assert.equal(runtime.calls[0].signal.aborted, true);
});
test("legacy task deadlines are ignored and a two-hour turn can finish normally", async (t) => {
  const entered = Promise.withResolvers();
  const complete = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const runtime = runner(async function* (input) {
    yield {
      type: "item.started",
      item: {
        id: "long-experiment",
        type: "command_execution",
        command: "python long_experiment.py",
        aggregated_output: "",
        status: "in_progress",
      },
    };
    let onAbort;
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () => reject(new Error("Experiment aborted"));
      input.signal.addEventListener("abort", onAbort, { once: true });
    });
    entered.resolve();
    try {
      await Promise.race([complete.promise, aborted]);
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
    yield {
      type: "item.completed",
      item: {
        id: "long-experiment",
        type: "command_execution",
        command: "python long_experiment.py",
        aggregated_output: "Experiment complete",
        status: "completed",
        exit_code: 0,
      },
    };
    yield { type: "turn.completed", usage: null };
  });
  const { core: original, thread, dir } = await setup(t, runtime);
  await original.close();
  const retainedSettings = {
    activeProviderId: "nexiom-default",
    effort: "high",
    network: true,
  };
  const legacyDb = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    legacyDb
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('agent', ?)",
      )
      .run(JSON.stringify({ ...retainedSettings, timeoutMinutes: 15 }));
  } finally {
    legacyDb.close();
  }

  let core;
  let runId;
  core = new service.CoreService(
    dir,
    () => {
      const run = core
        ?.snapshot()
        .snapshot.runs.find((item) => item.id === runId);
      if (run && run.status !== "running") finished.resolve();
    },
    { runner: runtime },
  );
  try {
    assert.deepEqual(core.snapshot().snapshot.settings, retainedSettings);
    await core.request({ type: "runtime.check" });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    ({ runId } = await core.request({
      ...requestFor(thread, "execute"),
      executionConfirmed: true,
    }));
    await entered.promise;
    assert.deepEqual(runtime.calls[0].settings, retainedSettings);
    assert.equal(runtime.calls[0].provider.id, "nexiom-default");

    // Cross both the former default deadline and its former configurable ceiling.
    for (const advanceMinutes of [16, 104]) {
      t.mock.timers.tick(advanceMinutes * 60_000);
      await Promise.resolve();
      assert.equal(runtime.calls[0].signal.aborted, false);
      const run = core
        .snapshot()
        .snapshot.runs.find((item) => item.id === runId);
      assert.equal(run.status, "running");
    }

    complete.resolve();
    await finished.promise;
    const state = core.snapshot().snapshot;
    const run = state.runs.find((item) => item.id === runId);
    assert.equal(run.status, "succeeded");
    assert.equal(
      Date.parse(run.finishedAt) - Date.parse(run.createdAt),
      120 * 60_000,
    );
    assert.equal(state.items[0].status, "completed");
    assert.equal(state.items[0].item.aggregated_output, "Experiment complete");
    assert.equal(runtime.calls[0].signal.aborted, false);
  } finally {
    t.mock.timers.reset();
    await core.close();
  }
});

test("provider CRUD preserves credentials across edits and protects the active provider", async (t) => {
  const runtime = runner(success);
  const { core } = await setup(t, runtime);
  const assignedId = randomUUID();
  const created = await core.request({
    type: "provider.upsert",
    provider: {
      id: assignedId,
      name: "Fixture Responses",
      kind: "responses",
      endpoint: "http://127.0.0.1:1234/v1/",
      model: "fixture-model-a",
      auth: "bearer",
    },
    apiKey: "test-api-secret",
  });
  assert.equal(created.provider.id, assignedId);
  assert.equal(created.provider.revision, 1);
  assert.equal(created.provider.endpoint, "http://127.0.0.1:1234/v1");
  assert.equal(created.provider.hasApiKey, true);

  const updated = await core.request({
    type: "provider.upsert",
    provider: {
      id: created.provider.id,
      name: "Renamed Responses",
      kind: "responses",
      endpoint: "http://127.0.0.1:5678/v1",
      model: "fixture-model-b",
      auth: "bearer",
    },
  });
  assert.equal(updated.provider.id, created.provider.id);
  assert.equal(updated.provider.revision, 2);
  assert.equal(updated.provider.name, "Renamed Responses");
  assert.equal(updated.provider.hasApiKey, true);
  assert.ok(!JSON.stringify(core.snapshot()).includes("test-api-secret"));
  await assert.rejects(
    core.request({ type: "provider.delete", providerId: "nexiom-default" }),
    /先启用其他供应商/,
  );
  await core.request({
    type: "provider.delete",
    providerId: created.provider.id,
  });
  assert.deepEqual(
    core.snapshot().snapshot.providers.map((provider) => provider.id),
    ["nexiom-default"],
  );
});

test("provider endpoints reject embedded credentials, query secrets and fragments", async (t) => {
  const { core } = await setup(t, runner(success));
  for (const endpoint of [
    "https://user:password@models.example.test/v1",
    "https://models.example.test/v1?api_key=query-secret",
    "https://models.example.test/v1#private-fragment",
  ]) {
    await assert.rejects(
      core.request({
        type: "provider.upsert",
        provider: {
          name: "Unsafe endpoint",
          kind: "responses",
          endpoint,
          model: "fixture-model",
          auth: "none",
        },
      }),
      /不含凭证、查询参数或片段/,
    );
  }
  const snapshot = JSON.stringify(core.snapshot());
  assert.ok(!snapshot.includes("password"));
  assert.ok(!snapshot.includes("query-secret"));
  assert.ok(!snapshot.includes("private-fragment"));
});

test("provider credentials are isolated from other providers and persistence", async (t) => {
  const runtime = runner(success);
  const { core, dir } = await setup(t, runtime);
  const createProvider = (name, endpoint, model, apiKey) =>
    core.request({
      type: "provider.upsert",
      provider: { name, kind: "responses", endpoint, model, auth: "bearer" },
      apiKey,
    });
  const a = await createProvider(
    "Provider A",
    "https://a.example.test/v1",
    "model-a",
    "secret-for-a",
  );
  const b = await createProvider(
    "Provider B",
    "https://b.example.test/v1",
    "model-b",
    "secret-for-b",
  );

  assert.deepEqual(
    (await core.request({ type: "provider.models", providerId: a.provider.id }))
      .models,
    ["model-a"],
  );
  assert.deepEqual(
    (await core.request({ type: "provider.models", providerId: b.provider.id }))
      .models,
    ["model-b"],
  );
  const checkA = await core.request({
    type: "provider.test",
    providerId: a.provider.id,
  });
  const checkB = await core.request({
    type: "provider.test",
    providerId: b.provider.id,
  });
  assert.equal(checkA.connectionCheck.ok, true);
  assert.equal(checkA.connectionCheck.providerId, a.provider.id);
  assert.deepEqual(checkA.connectionCheck.models, ["model-a"]);
  assert.equal(checkB.connectionCheck.ok, true);
  assert.equal(checkB.connectionCheck.providerId, b.provider.id);
  assert.deepEqual(checkB.connectionCheck.models, ["model-b"]);

  const requested = runtime.modelRequests.filter(
    ({ provider }) => provider.kind === "responses",
  );
  assert.deepEqual(
    requested.map(({ provider, apiKey }) => [provider.id, apiKey]),
    [
      [a.provider.id, "secret-for-a"],
      [b.provider.id, "secret-for-b"],
      [a.provider.id, "secret-for-a"],
      [b.provider.id, "secret-for-b"],
    ],
  );
  assert.ok(
    runtime.probes.some(
      ({ provider, apiKey }) =>
        provider.id === a.provider.id && apiKey === "secret-for-a",
    ),
  );
  assert.ok(
    runtime.probes.some(
      ({ provider, apiKey }) =>
        provider.id === b.provider.id && apiKey === "secret-for-b",
    ),
  );

  await core.request({
    type: "provider.upsert",
    provider: {
      id: a.provider.id,
      name: a.provider.name,
      kind: a.provider.kind,
      endpoint: a.provider.endpoint,
      model: a.provider.model,
      auth: a.provider.auth,
    },
    clearApiKey: true,
  });
  const requestsBefore = runtime.modelRequests.length;
  await assert.rejects(
    core.request({ type: "provider.models", providerId: a.provider.id }),
    /API Key/,
  );
  assert.equal(runtime.modelRequests.length, requestsBefore);

  const persisted = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    const stored = JSON.stringify({
      settings: persisted.prepare("SELECT * FROM settings").all(),
      providers: persisted.prepare("SELECT * FROM model_providers").all(),
      runs: persisted.prepare("SELECT * FROM agent_runs").all(),
    });
    assert.ok(!stored.includes("secret-for-a"));
    assert.ok(!stored.includes("secret-for-b"));
  } finally {
    persisted.close();
  }
  const publicState = JSON.stringify(core.snapshot());
  assert.ok(!publicState.includes("secret-for-a"));
  assert.ok(!publicState.includes("secret-for-b"));
});

test("switching A to B and back resumes each provider's own engine thread", async (t) => {
  const runtime = runner(async function* (input) {
    if (!input.threadId)
      yield {
        type: "thread.started",
        thread_id: `engine:${input.provider.id}`,
      };
    yield { type: "turn.completed", usage: null };
  });
  const { core, thread, dir } = await setup(t, runtime);
  const createProvider = (name, model, apiKey) =>
    core.request({
      type: "provider.upsert",
      provider: {
        name,
        kind: "responses",
        endpoint: `https://${name.toLowerCase()}.example.test/v1`,
        model,
        auth: "bearer",
      },
      apiKey,
    });
  const a = await createProvider("A", "model-a", "key-a");
  const b = await createProvider("B", "model-b", "key-b");

  await core.request({ type: "provider.activate", providerId: a.provider.id });
  await settled(core, (await core.request(requestFor(thread))).runId);
  await core.request({ type: "provider.activate", providerId: b.provider.id });
  await settled(core, (await core.request(requestFor(thread))).runId);
  await core.request({ type: "provider.activate", providerId: a.provider.id });
  await settled(core, (await core.request(requestFor(thread))).runId);

  assert.deepEqual(
    runtime.calls.map(({ provider, apiKey, threadId }) => ({
      providerId: provider.id,
      apiKey,
      threadId,
    })),
    [
      { providerId: a.provider.id, apiKey: "key-a", threadId: undefined },
      { providerId: b.provider.id, apiKey: "key-b", threadId: undefined },
      {
        providerId: a.provider.id,
        apiKey: "key-a",
        threadId: `engine:${a.provider.id}`,
      },
    ],
  );
  assert.equal(core.snapshot().snapshot.settings.activeProviderId, a.provider.id);
  assert.equal(core.snapshot().snapshot.runtime.activeProviderId, a.provider.id);
  const runs = core.snapshot().snapshot.runs.filter((run) => run.kind === "agent");
  assert.deepEqual(
    runs.map(({ providerId }) => providerId),
    [a.provider.id, b.provider.id, a.provider.id],
  );
  for (const [index, run] of runs.entries()) {
    assert.match(run.providerFingerprint, /^[a-f0-9]{64}$/);
    const config = JSON.parse(run.runtimeConfig);
    const expected = index === 1 ? b.provider : a.provider;
    assert.equal(config.provider.id, expected.id);
    assert.equal(config.provider.model, expected.model);
    assert.equal(config.provider.revision, expected.revision);
    assert.equal(
      config.cacheThreadState,
      index === 2 ? "continuation" : "new_thread",
    );
    assert.ok(!run.runtimeConfig.includes(index === 1 ? "key-b" : "key-a"));
  }

  const persisted = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    const bindings = persisted
      .prepare(
        "SELECT engineThreadId FROM agent_threads WHERE threadId=? ORDER BY engineThreadId",
      )
      .all(thread.id);
    assert.deepEqual(
      bindings.map(({ engineThreadId }) => engineThreadId),
      [`engine:${a.provider.id}`, `engine:${b.provider.id}`].sort(),
    );
  } finally {
    persisted.close();
  }
});

test("the configured model ID controls requests while its display name stays independent", async (t) => {
  const runtime = runner(success);
  const probe = runtime.probe.bind(runtime);
  runtime.probe = async (...args) => ({
    ...await probe(...args),
    activeModel: "unrelated-global-model",
    activeModelProvider: "unrelated-global-provider",
  });
  const { core, thread } = await setup(t, runtime);
  const provider = core.snapshot().snapshot.providers[0];
  await core.request({
    type: "provider.upsert",
    provider: { ...provider, modelName: "Fixture Display Name" },
  });
  await core.request({ type: "runtime.check" });
  await settled(core, (await core.request(requestFor(thread))).runId);
  assert.equal(runtime.calls[0].provider.model, "fixture-model");
  assert.equal(runtime.calls[0].provider.modelName, "Fixture Display Name");
  assert.equal(runtime.calls[0].resolvedModelProvider, "nexiom");
  const config = JSON.parse(core.snapshot().snapshot.runs[0].runtimeConfig);
  assert.equal(config.resolvedModel, "fixture-model");
  assert.equal(config.resolvedModelProvider, "nexiom");
  assert.equal(core.snapshot().snapshot.runtime.activeModel, "fixture-model");
  assert.equal(core.snapshot().snapshot.providers[0].modelName, "Fixture Display Name");
  const savedProvider = core.snapshot().snapshot.providers[0];
  await core.request({
    type: "provider.upsert",
    provider: { ...savedProvider, modelName: "Renamed Display Name" },
  });
  assert.equal(core.snapshot().snapshot.runtime.connected, true);
  await settled(core, (await core.request(requestFor(thread))).runId);
  assert.equal(runtime.calls[1].provider.model, "fixture-model");
  assert.equal(runtime.calls[1].provider.modelName, "Renamed Display Name");
  assert.equal(runtime.calls[1].threadId, "engine-thread-1");
});

test("editing an independent provider isolates its previous engine session", async (t) => {
  const runtime = runner(success);
  const { core, thread } = await setup(t, runtime);
  await settled(core, (await core.request(requestFor(thread))).runId);
  const provider = core.snapshot().snapshot.providers[0];
  await core.request({
    type: "provider.upsert",
    provider: { ...provider, endpoint: "http://127.0.0.1:5678/v1" },
  });
  await core.request({ type: "runtime.check" });
  await settled(core, (await core.request(requestFor(thread))).runId);
  assert.deepEqual(runtime.calls.map(({ threadId }) => threadId), [undefined, undefined]);
  const runs = core.snapshot().snapshot.runs;
  assert.notEqual(runs[0].providerFingerprint, runs[1].providerFingerprint);
});

test("a v5 workspace removes shared profiles and bindings once while preserving independent providers and history", async (t) => {
  const runtime = runner(success);
  const { core: original, thread, dir } = await setup(t, runtime);
  await settled(original, (await original.request(requestFor(thread))).runId);
  const { provider } = await original.request({
    type: "provider.upsert",
    provider: { name: "Own API", kind: "responses", endpoint: "https://own.example.test/v1", model: "own-model", auth: "bearer" },
    apiKey: "preserved-own-key",
  });
  const history = original.snapshot().snapshot.messages;
  const recordedRuns = original.snapshot().snapshot.runs;
  await original.close();
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    db.prepare("INSERT INTO model_providers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("local-codex", "本机 Codex 配置", "local_codex", "", "global-model", "global-model", "none", 1, "2026-01-01", "2026-01-01");
    db.prepare("UPDATE settings SET value=? WHERE key='agent'")
      .run(JSON.stringify({ activeProviderId: "local-codex", effort: "high", network: true }));
    db.prepare("INSERT INTO agent_threads VALUES (?, ?, ?)")
      .run(thread.id, "shared-codex-desktop-thread", "old-local-binding");
    db.exec("PRAGMA user_version=5");
  } finally { db.close(); }

  let reopened = new service.CoreService(dir, () => {}, { runner: runtime });
  try {
    const snapshot = reopened.snapshot().snapshot;
    assert.equal(snapshot.settings.activeProviderId, "nexiom-default");
    assert.equal(snapshot.settings.effort, "high");
    assert.equal(snapshot.settings.network, true);
    assert.ok(!snapshot.providers.some(({ kind, id }) => kind === "local_codex" || id === "local-codex"));
    assert.deepEqual(snapshot.messages, history);
    assert.deepEqual(snapshot.runs, recordedRuns);
    assert.deepEqual(snapshot.contexts, []);
    assert.equal(snapshot.providers.find(({ id }) => id === provider.id).model, "own-model");
    const inspected = new DatabaseSync(path.join(dir, "workspace.sqlite"));
    assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM agent_threads").get().count, 0);
    inspected.close();
    reopened.setRuntimeSecrets({ [provider.id]: "preserved-own-key", "local-codex": "must-not-import" });
    await reopened.request({ type: "provider.activate", providerId: provider.id });
    await settled(reopened, (await reopened.request(requestFor(thread))).runId);
    assert.equal(runtime.calls.at(-1).threadId, undefined);
    assert.equal(runtime.calls.at(-1).apiKey, "preserved-own-key");
    await reopened.close();
    reopened = new service.CoreService(dir, () => {}, { runner: runtime });
    reopened.setRuntimeSecrets({ [provider.id]: "preserved-own-key" });
    await reopened.request({ type: "runtime.check" });
    await settled(reopened, (await reopened.request(requestFor(thread))).runId);
    assert.equal(runtime.calls.at(-1).threadId, "engine-thread-1");
    assert.equal(reopened.snapshot().snapshot.settings.activeProviderId, provider.id);
  } finally {
    await reopened.close();
  }
});

test("a v3 workspace preserves custom settings and invalidates shared engine bindings", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-v3-migration-"));
  let original = new service.CoreService(dir);
  let migrated;
  t.after(async () => {
    await migrated?.close();
    await original?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { thread } = await original.request({
    type: "project.create",
    name: "V3 migration fixture",
  });
  await original.close();
  original = undefined;

  const endpoint = "https://legacy.example.test/v1";
  const model = "legacy-model";
  const legacyFingerprint = createHash("sha256")
    .update(JSON.stringify(["custom", endpoint, model]))
    .digest("hex");
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec(`
      DROP TABLE model_providers;
      DROP TABLE agent_runs;
      CREATE TABLE agent_runs (
        runId TEXT PRIMARY KEY REFERENCES runs(id),
        mode TEXT NOT NULL,
        usage TEXT
      );
      DROP TABLE agent_threads;
      CREATE TABLE agent_threads (
        threadId TEXT PRIMARY KEY REFERENCES threads(id),
        engineThreadId TEXT NOT NULL,
        fingerprint TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO agent_threads VALUES (?, ?, ?)").run(
      thread.id,
      "legacy-engine-thread",
      legacyFingerprint,
    );
    db.prepare(
      "INSERT INTO settings VALUES ('agent', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(
      JSON.stringify({
        connection: "custom",
        endpoint,
        model,
        effort: "xhigh",
        network: true,
      }),
    );
    db.exec("PRAGMA user_version=3");
  } finally {
    db.close();
  }

  const runtime = runner(async function* () {
    yield { type: "turn.completed", usage: null };
  });
  migrated = new service.CoreService(dir, () => {}, { runner: runtime });
  const state = migrated.snapshot().snapshot;
  assert.deepEqual(state.settings, {
    activeProviderId: "legacy-custom",
    effort: "xhigh",
    network: true,
  });
  assert.deepEqual(
    state.providers
      .map(({ id, kind, endpoint: url, model: modelId }) => ({
        id,
        kind,
        endpoint: url,
        model: modelId,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      {
        id: "legacy-custom",
        kind: "responses",
        endpoint,
        model,
      },
      {
        id: "nexiom-default",
        kind: "responses",
        endpoint: "https://api.openai.com/v1",
        model: "",
      },
    ],
  );

  const migratedDb = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    assert.equal(
      migratedDb.prepare("PRAGMA user_version").get().user_version,
      9,
    );
    const primaryKey = migratedDb
      .prepare("PRAGMA table_info(agent_threads)")
      .all()
      .filter(({ pk }) => pk)
      .sort((a, b) => a.pk - b.pk)
      .map(({ name }) => name);
    assert.deepEqual(primaryKey, ["threadId", "fingerprint"]);
    assert.deepEqual(
      [...migratedDb.prepare("PRAGMA table_info(agent_runs)").all()]
        .map(({ name }) => name)
        .filter((name) =>
          ["providerId", "providerFingerprint", "runtimeConfig"].includes(
            name,
          ),
        )
        .sort(),
      ["providerFingerprint", "providerId", "runtimeConfig"],
    );
  } finally {
    migratedDb.close();
  }

  migrated.setRuntimeSecrets({ "legacy-custom": "migrated-secret" });
  await migrated.request({ type: "runtime.check" });
  await settled(
    migrated,
    (await migrated.request(requestFor(thread))).runId,
  );
  assert.equal(runtime.calls[0].provider.id, "legacy-custom");
  assert.equal(runtime.calls[0].apiKey, "migrated-secret");
  assert.equal(runtime.calls[0].threadId, undefined);
});

test("project memory is editable, conflict checked and injected on each resumed turn", async (t) => {
  const runtime = runner(success);
  const { core, thread } = await setup(t, runtime);
  const { memory } = await core.request({
    type: "memory.read",
    projectId: thread.projectId,
  });
  assert.equal(memory.text, "");
  const saved = await core.request({
    type: "memory.write",
    projectId: thread.projectId,
    text: "Assumption: positive demand",
    expectedRevision: memory.revision,
  });
  const root = core.snapshot().snapshot.projects[0].root;
  assert.equal(
    await readFile(path.join(root, ".nexiom", "MEMORY.md"), "utf8"),
    "Assumption: positive demand",
  );
  await assert.rejects(
    core.request({
      type: "memory.write",
      projectId: thread.projectId,
      text: "stale",
      expectedRevision: memory.revision,
    }),
    /重新读取/,
  );
  await settled(core, (await core.request(requestFor(thread))).runId);
  assert.equal(runtime.calls[0].projectMemory, "Assumption: positive demand");
  await writeFile(path.join(root, ".nexiom", "MEMORY.md"), "External edit");
  await assert.rejects(
    core.request({
      type: "memory.write",
      projectId: thread.projectId,
      text: "stale",
      expectedRevision: saved.memory.revision,
    }),
    /重新读取/,
  );
  await settled(core, (await core.request(requestFor(thread))).runId);
  assert.equal(runtime.calls[1].projectMemory, "External edit");
  assert.equal(runtime.calls[1].threadId, "engine-thread-1");
});

test("native token usage and compaction survive core restart", async (t) => {
  const runtime = runner(async function* () {
    yield { type: "thread.started", thread_id: "persistent-engine-thread" };
    yield {
      type: "context.updated",
      modelContextWindow: 200000,
      totalTokens: 8000,
      lastInputTokens: 2000,
      lastOutputTokens: 300,
      cachedInputTokens: 1000,
    };
    yield { type: "context.compacted", itemId: "native-compaction" };
    yield { type: "turn.completed", usage: null };
  });
  const { core, thread, dir } = await setup(t, runtime);
  await settled(core, (await core.request(requestFor(thread))).runId);
  const expected = core.snapshot().snapshot.contexts[0];
  assert.equal(expected.totalTokens, 8000);
  assert.equal(expected.compactions, 1);
  await core.close();
  const reopened = new service.CoreService(dir, () => {}, { runner: runtime });
  assert.deepEqual(reopened.snapshot().snapshot.contexts[0], expected);
  await reopened.close();
});
