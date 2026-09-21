import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import runtime from "../.build/provider-runtime.cjs";

const sse = (...events) =>
  events
    .map(
      (event) =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");

test("native engine isolates prompts, credentials and resumed sessions from the host", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(tmpdir(), "nexiom-provider-app-server-"),
  );
  const cwd = path.join(tempRoot, "workspace");
  const codexHome = path.join(tempRoot, "codex-home");
  const runtimeHome = path.join(tempRoot, "nexiom-runtime");
  const hostHome = path.join(tempRoot, "personal-home");
  const parentConfig = path.join(tempRoot, ".codex");
  const workspaceConfig = path.join(cwd, ".codex");
  const parentSkill = path.join(tempRoot, ".agents", "skills", "personal-skill");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(parentConfig, { recursive: true }),
    mkdir(workspaceConfig, { recursive: true }),
    mkdir(hostHome, { recursive: true }),
    mkdir(parentSkill, { recursive: true }),
  ]);
  const hostilePrompt = "HOST_PERSONAL_PROMPT_小co_DO_NOT_IMPORT";
  const hostileConfig = `developer_instructions = "HOST_CONFIG_DO_NOT_IMPORT"
[features]
plugins = true
hooks = true
[shell_environment_policy.set]
NEXIOM_INHERITED_SETTING = "HOST_CONFIG_DO_NOT_IMPORT"
[mcp_servers.hostile_project_mcp]
command = "nexiom-host-mcp-must-not-run"
required = true
startup_timeout_sec = 1
[plugins."hostile@test"]
enabled = true
`;
  await Promise.all([
    writeFile(path.join(codexHome, "AGENTS.md"), hostilePrompt),
    writeFile(path.join(codexHome, "config.toml"), hostileConfig),
    writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "host-auth-json-key" })),
    writeFile(path.join(tempRoot, "AGENTS.md"), hostilePrompt),
    writeFile(path.join(cwd, "AGENTS.md"), hostilePrompt),
    writeFile(path.join(parentConfig, "config.toml"), hostileConfig),
    writeFile(path.join(workspaceConfig, "config.toml"), hostileConfig),
    writeFile(path.join(parentSkill, "SKILL.md"), "---\nname: personal-skill\ndescription: HOST_SKILL_DO_NOT_IMPORT\n---\n" + hostilePrompt),
  ]);
  const injectedEnv = {
    CODEX_HOME: codexHome,
    HOME: hostHome,
    USERPROFILE: hostHome,
    OPENAI_API_KEY: "host-openai-env-key",
    CODEX_API_KEY: "host-codex-env-key",
    ANTHROPIC_API_KEY: "host-anthropic-env-key",
    CLAUDE_CONFIG_DIR: hostHome,
  };
  const previousEnv = Object.fromEntries(Object.keys(injectedEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, injectedEnv);

  const requests = [];
  let exerciseTool = false;
  let toolSent = false;
  let readingCalls = -1;
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (readingCalls >= 0 && readingCalls < 2) {
      const status = readingCalls++ === 0 ? "running" : "completed";
      response.end(sse(
        { type: "response.created", response: { id: `reading-${status}` } },
        { type: "response.output_item.done", item: { type: "function_call", id: `stage-${status}`, call_id: `stage-${status}`, namespace: "nexiom_reading", name: "set_reading_stage", arguments: JSON.stringify({ stepId: "read-1", phase: "reading", status }) } },
        { type: "response.completed", response: { id: `reading-${status}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ));
      return;
    }
    if (exerciseTool && !toolSent) {
      toolSent = true;
      const body = JSON.parse(requests.at(-1).body);
      const commandTool = body.tools.find(tool => ["exec_command", "shell_command", "shell"].includes(tool.name));
      if (!commandTool) {
        response.end(sse({ type: "response.failed", response: { error: { message: "No command tool: " + body.tools.map(tool => tool.name).join(", ") } } }));
        return;
      }
      const command = process.platform === "win32"
        ? "if ($env:NEXIOM_INHERITED_SETTING) { throw 'Host configuration leaked' }; Set-Content -LiteralPath native-tool.txt -Value NEXIOM_TOOL_ISOLATED; Write-Output NEXIOM_TOOL_ISOLATED"
        : "test -z \"$NEXIOM_INHERITED_SETTING\" || exit 12; printf NEXIOM_TOOL_ISOLATED > native-tool.txt; cat native-tool.txt";
      const args = commandTool.name === "exec_command"
        ? { cmd: command, workdir: cwd, login: false }
        : commandTool.name === "shell_command"
          ? { command, workdir: cwd }
          : { command: process.platform === "win32" ? ["powershell.exe", "-NoProfile", "-Command", command] : ["sh", "-c", command], workdir: cwd };
      response.end(sse(
        { type: "response.created", response: { id: "resp-native-tool" } },
        { type: "response.output_item.done", item: { type: "function_call", id: "tool1", call_id: "tool1", name: commandTool.name, arguments: JSON.stringify(args) } },
        { type: "response.completed", response: { id: "resp-native-tool", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ));
      return;
    }
    response.end(
      sse(
        { type: "response.created", response: { id: "resp-provider-test" } },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "msg-provider-test",
            content: [{ type: "output_text", text: "provider ready" }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp-provider-test",
            usage: {
              input_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 1,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 2,
            },
          },
        },
      ),
    );
  });
  const abort = new AbortController();
  let timer;
  t.after(async () => {
    clearTimeout(timer);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(resolve);
    });
    await rm(tempRoot, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const secret = "provider-secret-without-env";
  timer = setTimeout(() => abort.abort(), 45_000);
  assert.equal(process.env.CODEX_HOME, codexHome);

  const provider = {
    id: "provider-app-server-fixture",
    name: "Provider app-server fixture",
    kind: "responses",
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture-responses-model",
    auth: "bearer",
    revision: 1,
    hasApiKey: true,
    createdAt: "",
    updatedAt: "",
  };
  const events = [];
  const runner = new runtime.CodexRuntime({ runtimeHome });
  const input = {
    prompt: "你好",
    cwd,
    mode: "plan",
    settings: {
      activeProviderId: provider.id,
      effort: "default",
      network: false,
    },
    provider,
    apiKey: secret,
    signal: abort.signal,
  };
  for await (const event of runner.run(input))
    events.push(event);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, `Bearer ${secret}`);
  assert.ok(events.some((event) => event.type === "turn.completed"));
  assert.ok(!events.some(event => event.item?.type === "reasoning"));
  const threadId = events.find(event => event.type === "thread.started")?.thread_id;
  assert.ok(threadId);

  const resumedEvents = [];
  for await (const event of runner.run({ ...input, threadId, prompt: "继续" }))
    resumedEvents.push(event);
  assert.ok(resumedEvents.some(event => event.type === "turn.completed"));
  assert.equal(resumedEvents.find(event => event.type === "thread.started")?.thread_id, threadId);
  const firstPayload = JSON.parse(requests[0].body);
  const resumedPayload = JSON.parse(requests[1].body);
  assert.equal(firstPayload.instructions, resumedPayload.instructions);
  assert.equal((firstPayload.instructions.match(/你是 NEXIOM/g) ?? []).length, 1);
  assert.deepEqual(firstPayload.tools, resumedPayload.tools);

  const anonymousEvents = [];
  for await (const event of runner.run({
    ...input,
    provider: { ...provider, id: "anonymous", auth: "none", hasApiKey: false },
    apiKey: undefined,
  })) anonymousEvents.push(event);
  assert.ok(anonymousEvents.some(event => event.type === "turn.completed"));
  assert.equal(requests.length, 3);
  assert.equal(requests[1].headers.authorization, `Bearer ${secret}`);
  assert.equal(requests[2].headers.authorization, undefined);

  exerciseTool = true;
  const toolEvents = [];
  for await (const event of runner.run({ ...input, mode: "execute", prompt: "Write the requested native-tool.txt fixture." }))
    toolEvents.push(event);
  assert.ok(toolEvents.some(event => event.type === "turn.completed"));
  assert.ok(toolEvents.some(event => event.item?.type === "command_execution" && event.item.exit_code === 0), JSON.stringify({ events: toolEvents, output: JSON.parse(requests[4]?.body ?? "{}").input?.filter(item => item.type === "function_call_output") }));
  assert.match(await readFile(path.join(cwd, "native-tool.txt"), "utf8"), /NEXIOM_TOOL_ISOLATED/);
  assert.equal(requests.length, 5);
  assert.match(requests[4].body, /NEXIOM_TOOL_ISOLATED/);
  for (const request of requests) {
    assert.ok(!request.body.includes(secret));
    assert.doesNotMatch(request.body, /HOST_PERSONAL_PROMPT|HOST_CONFIG|HOST_SKILL|host-openai-env-key|host-auth-json-key|host-codex-env-key/);
    assert.ok(!request.body.includes("<skills_instructions>"), "Native engine must not inject external skill prompts");
    const payload = JSON.parse(request.body);
    assert.match(payload.instructions, /你是 NEXIOM/);
    assert.doesNotMatch(payload.instructions, /You are Codex/);
    assert.ok(!payload.reasoning?.summary || payload.reasoning.summary === "none");
  }
  assert.deepEqual((await readdir(codexHome)).sort(), ["AGENTS.md", "auth.json", "config.toml"]);
  assert.equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), hostileConfig);
  assert.ok((await readdir(runtimeHome)).some(name => name.startsWith("state_")));
  const sessionFiles = await readdir(path.join(runtimeHome, "sessions"), { recursive: true });
  assert.ok(sessionFiles.some(name => name.endsWith(".jsonl") && name.includes(threadId)));

  // Reading can research without granting project write access or importing host tools.
  readingCalls = 0;
  const readingEvents = [];
  for await (const event of runner.run({ ...input, stageId: "reading", settings: { ...input.settings, network: true } }))
    readingEvents.push(event);
  assert.ok(readingEvents.some(event => event.type === "turn.completed"));
  const stageCalls = readingEvents.filter(event => event.type === "item.completed" && event.item.type === "native_tool_call");
  assert.equal(stageCalls.length, 2, JSON.stringify(readingEvents));
  assert.ok(stageCalls.every(event => event.item.status === "completed" && event.item.result.accepted === true));
  assert.deepEqual(stageCalls.map(event => event.item.arguments.status), ["running", "completed"]);
  const readingPayload = JSON.parse(requests.at(-1).body);
  assert.ok(readingPayload.tools.some(tool => tool.type === "web_search" || tool.type === "web_search_preview"), JSON.stringify(readingPayload.tools));
  assert.match(JSON.stringify(readingPayload.tools), /set_reading_stage/);
  assert.match(JSON.stringify(readingPayload.input), /数据泄漏|信息泄漏/);
  const offlineEvents = [];
  for await (const event of runner.run({ ...input, stageId: "reading" })) offlineEvents.push(event);
  assert.ok(offlineEvents.some(event => event.type === "turn.completed"));
  assert.ok(!JSON.parse(requests.at(-1).body).tools.some(tool => /^web_search/.test(tool.type)));
});
