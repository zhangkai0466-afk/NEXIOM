import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import runtime from "../.build/provider-runtime.cjs";
import eventsRuntime from "../.build/runtime.cjs";

test("native tool events retain gallery metadata without image payloads", () => {
  const adapter = new eventsRuntime.AppServerEvents("visual-turn", true);
  const events = adapter.map("item/completed", { turnId: "visual-turn", item: {
    id: "gallery-call", type: "dynamicToolCall", namespace: "nexiom_visual", tool: "get_visual_reference",
    arguments: { reference_id: "reference-1" }, status: "completed", success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify({ id: "reference-1", imagePath: "references/example.png" }) },
      { type: "inputImage", imageUrl: "data:image/jpeg;base64,IMAGE_PIXELS_MUST_NOT_PERSIST_IN_UI" }],
  } });
  assert.equal(events[0].item.type, "native_tool_call");
  assert.equal(events[0].item.result.id, "reference-1");
  assert.ok(!JSON.stringify(events).includes("IMAGE_PIXELS"));
});

function installedPython() {
  for (const name of [process.env.NEXIOM_VISUAL_PYTHON, "python", "python3"].filter(Boolean)) {
    try {
      return execFileSync(name, ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
    } catch { /* Try the next standalone Python. */ }
  }
  return null;
}

const python = installedPython();
const provider = {
  id: "visual-test", name: "Visual fixture", kind: "responses", auth: "bearer",
  endpoint: "http://127.0.0.1:12345/v1", model: "visual-fixture-model",
  revision: 1, hasApiKey: true, createdAt: "", updatedAt: "",
};

const fixtureSource = `import json, os, sys
packet = json.load(sys.stdin)
if packet['operation'] == 'check':
    result = {'available': True, 'version': 'fixture-v1'}
elif packet['name'] == 'wait_for_cancel':
    import time, subprocess
    from pathlib import Path
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
    Path(packet['arguments']['marker']).write_text(str(os.getpid()) + ',' + str(child.pid))
    time.sleep(120)
    result = {}
else:
    result = {'marker': 'NEXIOM_NATIVE_VISUAL_CALLED', 'mode': packet['mode'], 'network': packet['network'], 'has_key': bool(packet['provider'].get('apiKey')), 'host_key': bool(os.environ.get('OPENAI_API_KEY')), 'env_key': bool(os.environ.get('NEXIOM_VISUAL_PROVIDER_JSON')), 'project': packet['projectRoot']}
print(json.dumps({'ok': True, 'result': result}))
`;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "nexiom-visual-runtime-"));
  const bundle = path.join(root, "bundle");
  const cwd = path.join(root, "project");
  const runtimeHome = path.join(root, "runtime");
  await Promise.all([mkdir(bundle), mkdir(cwd), mkdir(runtimeHome)]);
  await Promise.all([
    writeFile(path.join(bundle, "native.py"), fixtureSource),
    writeFile(path.join(bundle, "manifest.json"), JSON.stringify({ version: "fixture-v1" })),
    writeFile(path.join(bundle, "native-tools.json"), JSON.stringify({ version: "fixture-v1", tools: ["health_check", "render_preview", "wait_for_cancel"].map(name => ({ name, description: name, readOnly: name === "health_check", inputSchema: { type: "object", properties: {} } })) })),
  ]);
  const injected = { NEXIOM_VISUAL_BUNDLE_ROOT: bundle, NEXIOM_VISUAL_PYTHON: python,
    OPENAI_API_KEY: "host-api-key-must-not-enter-native", PYTHONPATH: "host-python-path", NEXIOM_VISUAL_PROVIDER_JSON: "host-visual-settings" };
  const previous = Object.fromEntries(Object.keys(injected).map(key => [key, process.env[key]]));
  Object.assign(process.env, injected);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, bundle, cwd, runtimeHome };
}

test("visual runtime isolates Python tools to chart stage and provider credentials", { skip: !python }, async t => {
  const { cwd, runtimeHome, bundle } = await fixture(t);
  const secret = "visual-own-secret";
  const input = { cwd, stageId: "model", mode: "execute", provider, apiKey: secret,
    settings: { network: true }, signal: new AbortController().signal, prompt: "draw" };
  const env = runtime.runtimeEnvironment("tools", runtimeHome);
  const modelingTools = await runtime.createVisualDesignTools(input, env, runtimeHome);
  assert.deepEqual(modelingTools.specs[0].tools.map(tool => tool.name), ["ensure_visual_libraries", "list_visual_assets", "get_visual_asset", "create_visual_asset"]);
  assert.equal((await modelingTools.call("nexiom_visual", "health_check", {})).success, false);
  modelingTools.close();
  assert.equal(await runtime.createVisualDesignTools({ ...input, stageId: "reading" }, env, runtimeHome), undefined);
  const status = await runtime.getVisualDesignRuntimeStatus();
  assert.equal(status.available, true);
  assert.equal(status.bundleRoot, bundle);
  assert.equal(status.bundleVersion, "fixture-v1");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.NEXIOM_VISUAL_PROVIDER_JSON, undefined);
  const tools = await runtime.createVisualDesignTools({ ...input, stageId: "chart", mode: "plan" }, env, runtimeHome);
  const result = await tools.call("nexiom_visual", "health_check", {});
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.contentItems[0].text), { marker: "NEXIOM_NATIVE_VISUAL_CALLED", mode: "plan", network: false, has_key: true, host_key: false, env_key: false, project: cwd });
  assert.equal((await tools.call("nexiom_visual", "render_preview", {})).success, false);
  assert.equal((await tools.call("unexpected_namespace", "health_check", {})).success, false);
  assert.ok(!JSON.stringify(env).includes(secret));
  assert.ok(!JSON.stringify(tools.specs).includes(secret));
  const execution = await runtime.createVisualDesignTools({ ...input, stageId: "chart", settings: { network: false } }, env, runtimeHome);
  assert.deepEqual(execution.specs, tools.specs);
  const executed = await execution.call("nexiom_visual", "render_preview", {});
  assert.equal(executed.success, true);
  assert.equal(JSON.parse(executed.contentItems[0].text).network, false);
  tools.close();
  execution.close();
  assert.deepEqual(await readdir(cwd), []);
});

for (const stageId of ["model", "chart", "paper"]) test(`semantic ${stageId} tools work without Python and planning never creates libraries`, async t => {
  const { cwd, runtimeHome, root } = await fixture(t);
  process.env.NEXIOM_VISUAL_BUNDLE_ROOT = path.join(root, "missing-bundle");
  const input = { cwd, stageId, mode: "plan", provider,
    settings: { network: false }, signal: new AbortController().signal, prompt: "设计素材" };
  const tools = await runtime.createVisualDesignTools(input, {}, runtimeHome);
  t.after(() => tools.close());
  const listed = await tools.call("nexiom_visual", "list_visual_assets", {});
  assert.equal(listed.success, true, JSON.stringify(listed));
  const state = JSON.parse(listed.contentItems[0].text);
  assert.deepEqual(state.libraries.map(library => library.kind), ["modeling", "paper"]);
  assert.ok(state.libraries.every(library => !library.exists));
  assert.deepEqual(state.assets, []);
  assert.equal((await tools.call("nexiom_visual", "ensure_visual_libraries", {})).success, false);
  assert.equal((await tools.call("nexiom_visual", "create_visual_asset", {})).success, false);
  assert.deepEqual(await readdir(cwd), []);
  const create = tools.specs[0].tools.find(tool => tool.name === "create_visual_asset");
  assert.deepEqual(create.inputSchema.properties.figure.properties.kind.enum, ["grouped-bar", "line", "scatter", "diagram"]);
  assert.match(create.description, /仅执行模式/);
  if (stageId === "chart") assert.match(tools.specs[0].description, /模板渲染暂不可用/);
  tools.close();
  assert.equal((await tools.call("nexiom_visual", "list_visual_assets", {})).success, false);
});

test("semantic tools create both agent libraries and preserve editable series and sources", async t => {
  const { cwd, runtimeHome, root } = await fixture(t);
  process.env.NEXIOM_VISUAL_BUNDLE_ROOT = path.join(root, "missing-bundle");
  await mkdir(path.join(cwd, "inputs"));
  await writeFile(path.join(cwd, "inputs", "survival.csv"), "case,A,B,C\nD,10,20,30\nE,15,25,35\nF,20,30,40\n");
  const input = { cwd, stageId: "model", mode: "execute", provider,
    settings: { network: false }, signal: new AbortController().signal, prompt: "建模过程可视化" };
  const tools = await runtime.createVisualDesignTools(input, {}, runtimeHome);
  t.after(() => tools.close());
  const request = {
    library: "modeling", title: "ABC 生存能力", purpose: "比较 D/E/F 情况下成员 A/B/C 的真实实验数据。",
    sourcePaths: ["inputs/survival.csv"],
    figure: { version: 1, kind: "grouped-bar", title: "ABC 生存能力", categories: ["D", "E", "F"],
      series: [
        { id: "member-a", label: "A", color: "#EF4444", values: [10, 15, 20] },
        { id: "member-b", label: "B", color: "#EAB308", values: [20, 25, 30] },
        { id: "member-c", label: "C", color: "#2563EB", values: [30, 35, 40] },
      ],
    },
  };
  const created = await tools.call("nexiom_visual", "create_visual_asset", request);
  assert.equal(created.success, true, JSON.stringify(created));
  const asset = JSON.parse(created.contentItems[0].text);
  assert.equal(asset.origin, "agent");
  assert.equal(asset.library, "modeling");
  assert.deepEqual(asset.figure.categories, ["D", "E", "F"]);
  assert.deepEqual(asset.figure.series.map(series => ({ label: series.label, color: series.color })), request.figure.series.map(series => ({ label: series.label, color: series.color })));
  assert.deepEqual(asset.sourcePaths, ["inputs/survival.csv"]);
  assert.equal(asset.svg, undefined, "Generated markup must not fill agent history");
  assert.ok(asset.elements.some(element => element.kind === "legend" && element.movable));
  for (const filePath of [asset.documentPath, asset.sourcePath, asset.imagePath]) {
    const file = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    assert.ok((await readFile(file)).length > 0);
  }
  const loaded = await tools.call("nexiom_visual", "get_visual_asset", { library: "modeling", id: asset.id });
  assert.equal(loaded.success, true, JSON.stringify(loaded));
  assert.deepEqual(JSON.parse(loaded.contentItems[0].text).figure, asset.figure);
  const ensured = await tools.call("nexiom_visual", "ensure_visual_libraries", {});
  assert.equal(ensured.success, true, JSON.stringify(ensured));
  const state = JSON.parse(ensured.contentItems[0].text);
  assert.ok(state.libraries.every(library => library.exists));
  assert.equal(state.assets.length, 1, "Ensuring libraries retains Agent-created material");
  const invalid = structuredClone(request);
  invalid.figure.series[0].values = [10];
  assert.equal((await tools.call("nexiom_visual", "create_visual_asset", invalid)).success, false);
  assert.equal((await tools.call("nexiom_visual", "get_visual_asset", { library: "modeling", id: "../../inputs/survival.csv" })).success, false);
  const finalState = JSON.parse((await tools.call("nexiom_visual", "list_visual_assets", {})).contentItems[0].text);
  assert.equal(finalState.assets.length, 1, "Rejected figure does not create a second material");
});

test("visual runtime rejects a Python override inside a personal Codex runtime", { skip: !python }, async t => {
  const { root } = await fixture(t);
  process.env.NEXIOM_VISUAL_PYTHON = path.join(root, ".codex", "runtime", "python.exe");
  const status = await runtime.getVisualDesignRuntimeStatus();
  assert.equal(status.available, false);
  assert.match(status.label, /不能使用个人 Codex/);
});

test("cancelling native visualization stops its Python worker and child processes", { skip: !python, timeout: 15_000 }, async t => {
  const { cwd, runtimeHome } = await fixture(t);
  const abort = new AbortController();
  const tools = await runtime.createVisualDesignTools({ cwd, stageId: "chart", mode: "execute", provider,
    settings: { network: false }, signal: abort.signal, prompt: "test" }, runtime.runtimeEnvironment("tools", runtimeHome), runtimeHome);
  t.after(() => tools.close());
  const marker = path.join(cwd, "worker-pids.txt");
  const pending = tools.call("nexiom_visual", "wait_for_cancel", { marker });
  let pids;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { pids = (await readFile(marker, "utf8")).split(",").map(Number); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  assert.equal(pids?.length, 2);
  abort.abort();
  assert.equal((await pending).success, false);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH|No such process/);
});

test("native gallery tool supplies actual image pixels with bounded metadata", { skip: !python, timeout: 60_000 }, async t => {
  const { cwd, runtimeHome } = await fixture(t);
  process.env.NEXIOM_VISUAL_BUNDLE_ROOT = path.resolve("packages/visualization-engine");
  const catalog = JSON.parse(await readFile(path.join(process.env.NEXIOM_VISUAL_BUNDLE_ROOT, "catalog.json"), "utf8"));
  const reference = catalog.references[0];
  const tools = await runtime.createVisualDesignTools({ cwd, stageId: "chart", mode: "plan", provider,
    settings: { network: false }, signal: new AbortController().signal, prompt: "read gallery" }, runtime.runtimeEnvironment("tools", runtimeHome), runtimeHome);
  t.after(() => tools.close());
  const result = await tools.call("nexiom_visual", "get_visual_reference", { reference_id: reference.id });
  assert.equal(result.success, true, JSON.stringify(result));
  const pixels = result.contentItems.find(item => item.type === "inputImage");
  assert.match(pixels?.imageUrl ?? "", /^data:image\/jpeg;base64,/);
  assert.ok(pixels.imageUrl.length < 3 * 1024 * 1024);
  assert.ok(!result.contentItems[0].text.includes("base64"));
  assert.deepEqual(await readdir(cwd), []);
});

const sse = (...events) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

for (const stageId of ["model", "paper"]) test(`native ${stageId} agent creates semantic material without a Python runtime`, { timeout: 30_000 }, async t => {
  const { cwd, runtimeHome, root } = await fixture(t);
  process.env.NEXIOM_VISUAL_BUNDLE_ROOT = path.join(root, "missing-bundle");
  await writeFile(path.join(cwd, "method.md"), "# 方法依据\n建立约束后进行优化求解。\n");
  const request = {
    library: stageId === "model" ? "modeling" : "paper", title: "约束与求解", purpose: "解释建立约束到优化求解的推导流程。",
    sourcePaths: ["method.md"], figure: { version: 1, kind: "diagram", title: "约束与求解", nodes: [
      { id: "constraints", label: "建立约束", x: 0.2, y: 0.4, color: "#2563EB" },
      { id: "solve", label: "优化求解", x: 0.6, y: 0.4, color: "#059669" },
    ], edges: [{ id: "next", from: "constraints", to: "solve" }] },
  };
  let calls = 0;
  const requests = [];
  const server = http.createServer(async (req, response) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(payload);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (calls++ === 0) {
      response.end(sse(
        { type: "response.created", response: { id: "resp-create-semantic" } },
        { type: "response.output_item.done", item: { type: "function_call", id: "semantic-call", call_id: "semantic-call", namespace: "nexiom_visual", name: "create_visual_asset", arguments: JSON.stringify(request) } },
        { type: "response.completed", response: { id: "resp-create-semantic", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ));
    } else response.end(sse(
      { type: "response.created", response: { id: "resp-semantic-done" } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "semantic-done", content: [{ type: "output_text", text: "素材已入库。" }] } },
      { type: "response.completed", response: { id: "resp-semantic-done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const runner = new runtime.CodexRuntime({ runtimeHome });
  const events = [];
  for await (const event of runner.run({ cwd, stageId, mode: "execute", prompt: "根据 method.md 制作流程图并入库。",
    provider: { ...provider, endpoint: `http://127.0.0.1:${server.address().port}/v1` }, apiKey: "semantic-test-secret",
    settings: { activeProviderId: provider.id, effort: "default", network: false }, signal: AbortSignal.timeout(25_000),
  })) events.push(event);
  assert.ok(events.some(event => event.type === "turn.completed"), JSON.stringify(events));
  const called = events.find(event => event.type === "item.completed" && event.item.type === "native_tool_call")?.item;
  assert.equal(called?.tool, "create_visual_asset", JSON.stringify(events));
  assert.equal(called.status, "completed", JSON.stringify(called));
  assert.equal(called.result.library, request.library);
  assert.deepEqual(called.result.sourcePaths, ["method.md"]);
  assert.equal(called.result.figure.nodes.length, 2);
  const declared = requests[0].tools.find(tool => tool.name === "nexiom_visual");
  assert.ok(declared.tools.some(tool => tool.name === "create_visual_asset"));
  assert.ok(!declared.tools.some(tool => tool.name === "render_preview"));
  assert.match(JSON.stringify(requests[0]), /建模过程可视化库/);
  assert.match(JSON.stringify(requests[0]), /论文论述可视化库/);
  assert.ok(!JSON.stringify(requests).includes("semantic-test-secret"));
});

for (const scenario of ["fixture", "bundled-plan", "bundled-render"]) test(`native chart agent calls ${scenario} without exposing its key`, { skip: !python, timeout: 90_000 }, async t => {
  const bundled = scenario !== "fixture";
  const rendering = scenario === "bundled-render";
  const { cwd, runtimeHome } = await fixture(t);
  if (bundled) {
    process.env.NEXIOM_VISUAL_BUNDLE_ROOT = path.resolve("packages/visualization-engine");
    const status = await runtime.getVisualDesignRuntimeStatus();
    assert.equal(status.available, true, status.label);
  }
  const requests = [];
  const toolsToCall = rendering ? ["health_check", "render_preview"] : bundled ? ["health_check", "list_available_templates"] : ["health_check"];
  let calls = 0;
  let missingTools = "";
  const server = http.createServer(async (req, response) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push(body);
    const payload = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (calls < toolsToCall.length) {
      const name = toolsToCall[calls++];
      const namespace = payload.tools.find(tool => tool.type === "namespace" && tool.name === "nexiom_visual");
      const tool = namespace?.tools.find(tool => tool.name === name)
        ?? payload.tools.find(tool => tool.name?.includes("visual_design") && tool.name.endsWith(name));
      if (!tool) {
        missingTools = payload.tools.map(tool => tool.name).join(",");
        response.end(sse({ type: "response.failed", response: { error: { message: `Visual tool missing: ${payload.tools.map(tool => tool.name).join(",")}` } } }));
        return;
      }
      response.end(sse(
        { type: "response.created", response: { id: "resp-visual-tool" } },
        { type: "response.output_item.done", item: { type: "function_call", id: `visual-call-${calls}`, call_id: `visual-call-${calls}`, ...(namespace ? { namespace: namespace.name } : {}), name: tool.name,
          arguments: name === "render_preview" ? JSON.stringify({ palette_id: "teal-ember-9", chart_id: "response-curves", output_dir: path.join(cwd, "outputs/visual-design/preview"), output_formats: ["png", "svg", "pdf"] }) : "{}" } },
        { type: "response.completed", response: { id: "resp-visual-tool", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ));
    } else response.end(sse(
      { type: "response.created", response: { id: "resp-visual-done" } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "visual-done", content: [{ type: "output_text", text: "visual ready" }] } },
      { type: "response.completed", response: { id: "resp-visual-done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const secret = "native-secret-only-in-private-pipe";
  const runner = new runtime.CodexRuntime({ runtimeHome });
  const events = [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 75_000);
  t.after(() => clearTimeout(timer));
  for await (const event of runner.run({ cwd, stageId: "chart", mode: rendering ? "execute" : "plan", prompt: "检查内置可视化组件。",
    provider: { ...provider, endpoint: `http://127.0.0.1:${server.address().port}/v1` }, apiKey: secret,
    settings: { activeProviderId: provider.id, effort: "default", network: false }, signal: abort.signal,
  })) events.push(event);
  assert.ok(events.some(event => event.type === "turn.completed"), JSON.stringify(events));
  const tool = events.find(event => event.type === "item.completed" && event.item.type === "native_tool_call")?.item;
  assert.ok(tool, JSON.stringify({ events, missingTools }));
  assert.equal(tool?.namespace, "nexiom_visual");
  assert.equal(tool?.tool, "health_check");
  assert.equal(tool?.status, "completed", JSON.stringify(tool));
  assert.match(JSON.stringify(tool?.result), bundled ? /template_count/ : /NEXIOM_NATIVE_VISUAL_CALLED/);
  assert.equal(requests.length, toolsToCall.length + 1);
  if (bundled && !rendering) {
    const templates = events.find(event => event.type === "item.completed" && event.item.type === "native_tool_call" && event.item.tool === "list_available_templates")?.item;
    assert.equal(templates?.status, "completed", JSON.stringify(templates));
    assert.match(JSON.stringify(templates?.result), /templates/);
    assert.equal(templates?.result?.jinja_template_count, 62);
  }
  if (rendering) {
    const rendered = events.find(event => event.type === "item.completed" && event.item.type === "native_tool_call" && event.item.tool === "render_preview")?.item;
    assert.equal(rendered?.status, "completed", JSON.stringify(rendered));
    const files = await readdir(path.join(cwd, "outputs/visual-design/preview"));
    for (const ext of [".png", ".svg", ".pdf"]) assert.ok(files.some(file => file.endsWith(ext)), files.join(","));
  }
  if (scenario === "fixture") {
    calls = 0;
    toolsToCall[0] = "render_preview";
    const threadId = events.find(event => event.type === "thread.started").thread_id;
    const resumed = [];
    for await (const event of runner.run({ cwd, stageId: "chart", mode: "execute", threadId, prompt: "开始执行刚才的规划。",
      provider: { ...provider, endpoint: `http://127.0.0.1:${server.address().port}/v1` }, apiKey: secret,
      settings: { activeProviderId: provider.id, effort: "default", network: false }, signal: abort.signal,
    })) resumed.push(event);
    assert.equal(resumed.find(event => event.type === "thread.started").thread_id, threadId);
    const executed = resumed.find(event => event.type === "item.completed" && event.item.type === "native_tool_call")?.item;
    assert.equal(executed?.status, "completed", JSON.stringify(resumed));
    assert.equal(executed.result.mode, "execute");
    assert.ok(requests[2].includes("visual ready"), "Planning conversation remains present after switching to Execute");
    events.push(...resumed);
  }
  // Native tool results and inherited conversation must not expose credentials.
  assert.match(requests[1], bundled ? /template_count/ : /NEXIOM_NATIVE_VISUAL_CALLED/);
  for (const request of requests) {
    assert.ok(!request.includes(secret));
    assert.ok(!request.includes("host-api-key-must-not-enter-native"));
    assert.ok(!request.includes("host-visual-settings"));
    assert.ok(!JSON.stringify(JSON.parse(request).tools).includes("mcp__visual"));
  }
  assert.ok(!JSON.stringify(events).includes(secret));
  const storedFiles = await readdir(runtimeHome, { recursive: true, withFileTypes: true });
  for (const file of storedFiles.filter(file => file.isFile())) {
    const stored = await readFile(path.join(file.parentPath, file.name));
    assert.ok(!stored.includes(Buffer.from(secret)), `Credential persisted in ${file.name}`);
  }
  if (!rendering) assert.deepEqual(await readdir(cwd), []);
});

