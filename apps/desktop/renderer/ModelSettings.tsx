import { useEffect, useState } from "react";
import {
  Check,
  Info,
  KeyRound,
  LoaderCircle,
  Plus,
  Power,
  RefreshCw,
  Save,
  Server,
  Trash2,
  X,
} from "lucide-react";
import type {
  AgentSettings,
  ModelProvider,
  ProviderCheck,
  ProviderDraft,
  Snapshot,
} from "../../../packages/contracts";
import { request } from "./bridge";

type ProviderAction = "save" | "activate" | "models" | "test" | "delete";

const toDraft = (provider: ModelProvider): ProviderDraft => ({
  id: provider.id,
  name: provider.name,
  kind: provider.kind,
  endpoint: provider.endpoint,
  modelName: provider.modelName,
  model: provider.model,
  auth: provider.auth,
});

const newProvider = (): ProviderDraft => ({
  name: "",
  kind: "responses",
  endpoint: "https://api.openai.com/v1",
  modelName: "",
  model: "",
  auth: "bearer",
});

const sameProvider = (left: ProviderDraft, right: ProviderDraft) =>
  JSON.stringify(left) === JSON.stringify(right);

export function ModelSettings({
  snapshot,
  settings,
  busy,
  running,
  onChange,
  onRefresh,
  onActivated,
  onDirtyChange,
  onBusyChange,
  onCheck,
}: {
  snapshot: Snapshot;
  settings: AgentSettings;
  busy: boolean;
  running: boolean;
  onChange: (settings: AgentSettings) => void;
  onRefresh: () => Promise<void>;
  onActivated: (providerId: string) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onCheck: () => void;
}) {
  const initialProvider =
    snapshot.providers.find(
      (item) => item.id === snapshot.settings.activeProviderId,
    ) ?? snapshot.providers[0];
  const initialDraft = initialProvider
    ? toDraft(initialProvider)
    : newProvider();
  const [selectedId, setSelectedId] = useState(initialProvider?.id ?? "");
  const [provider, setProvider] = useState<ProviderDraft>(initialDraft);
  const [baseline, setBaseline] = useState<ProviderDraft>(initialDraft);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [connectionCheck, setConnectionCheck] =
    useState<ProviderCheck | null>(null);
  const [action, setAction] = useState<ProviderAction | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const storedProvider = provider.id
    ? snapshot.providers.find((item) => item.id === provider.id)
    : undefined;
  const isNew = !provider.id;
  const isActive = provider.id === snapshot.settings.activeProviderId;
  const activeProvider = snapshot.providers.find(
    (item) => item.id === snapshot.settings.activeProviderId,
  );
  const activeModel =
    activeProvider?.modelName ||
    snapshot.runtime.activeModel ||
    activeProvider?.model ||
    "尚未配置模型";
  const needsSetup = !activeProvider?.model ||
    (activeProvider.auth === "bearer" && !activeProvider.hasApiKey);
  const providerDirty =
    isNew ||
    !sameProvider(provider, baseline) ||
    apiKey.length > 0 ||
    clearApiKey;
  const locked = busy || action !== null || running;

  useEffect(() => {
    onDirtyChange(providerDirty);
  }, [onDirtyChange, providerDirty]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    onBusyChange(action !== null);
  }, [action, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  useEffect(() => {
    if (providerDirty) return;
    const selected =
      snapshot.providers.find((item) => item.id === selectedId) ??
      snapshot.providers.find(
        (item) => item.id === snapshot.settings.activeProviderId,
      ) ??
      snapshot.providers[0];
    if (!selected) return;
    const next = toDraft(selected);
    const changedSelection = selected.id !== selectedId;
    setSelectedId(selected.id);
    setProvider(next);
    setBaseline(next);
    if (changedSelection) {
      setModels([]);
      setConnectionCheck(null);
    }
  }, [snapshot.providers, snapshot.settings.activeProviderId]);

  function resetTransientState() {
    setApiKey("");
    setClearApiKey(false);
    setModels([]);
    setConnectionCheck(null);
    setConfirmDelete(false);
    setError("");
    setNotice("");
  }

  function loadProvider(next: ModelProvider) {
    const draft = toDraft(next);
    setSelectedId(next.id);
    setProvider(draft);
    setBaseline(draft);
    resetTransientState();
  }

  function selectProvider(providerId: string) {
    if (providerId === selectedId || locked) return;
    if (providerDirty) {
      setError("请先保存或撤销当前供应商的更改。");
      return;
    }
    const next = snapshot.providers.find((item) => item.id === providerId);
    if (next) loadProvider(next);
  }

  function addProvider() {
    if (locked) return;
    if (providerDirty) {
      setError("请先保存或撤销当前供应商的更改。");
      return;
    }
    const draft = newProvider();
    setSelectedId("");
    setProvider(draft);
    setBaseline(draft);
    resetTransientState();
  }

  function discardProviderChanges() {
    const saved = provider.id
      ? snapshot.providers.find((item) => item.id === provider.id)
      : undefined;
    const fallback =
      saved ??
      snapshot.providers.find(
        (item) => item.id === snapshot.settings.activeProviderId,
      ) ??
      snapshot.providers[0];
    if (fallback) loadProvider(fallback);
  }

  function updateProvider(next: ProviderDraft) {
    setProvider(next);
    setError("");
    setNotice("");
    setConfirmDelete(false);
  }

  function validatedProvider(): ProviderDraft {
    const next: ProviderDraft = {
      ...provider,
      name: provider.name.trim(),
      endpoint: provider.endpoint.trim(),
      modelName: provider.modelName.trim(),
      model: provider.model.trim(),
    };
    if (!next.name) throw new Error("请填写供应商名称。");
    if (next.model && !next.modelName) throw new Error("请填写模型名称。");
    if (next.kind === "responses") {
      let endpoint: URL;
      try {
        endpoint = new URL(next.endpoint);
      } catch {
        throw new Error("请填写有效的 Responses API 地址。");
      }
      if (
        !["https:", "http:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      ) {
        throw new Error(
          "API 地址必须是不含凭证、查询参数或片段的 HTTP(S) 根地址。",
        );
      }
      if (/\/(?:models|responses)\/?$/i.test(endpoint.pathname))
        throw new Error(
          "API 地址应填写根地址（通常以 /v1 结尾），不要包含 /models 或 /responses。",
        );
    }
    return next;
  }

  async function persistProvider() {
    const next = validatedProvider();
    const result = await request({
      type: "provider.upsert",
      provider: next,
      ...(apiKey ? { apiKey } : {}),
      clearApiKey,
    });
    if (!result.provider) throw new Error("供应商保存失败，请重试。");
    const saved = result.provider;
    const savedDraft = toDraft(saved);
    setSelectedId(saved.id);
    setProvider(savedDraft);
    setBaseline(savedDraft);
    setApiKey("");
    setClearApiKey(false);
    setConfirmDelete(false);
    await onRefresh();
    return saved;
  }

  async function runAction(
    nextAction: ProviderAction,
    operation: () => Promise<void>,
  ) {
    if (locked) return;
    setAction(nextAction);
    setError("");
    setNotice("");
    setConnectionCheck(null);
    try {
      await operation();
    } catch (failure) {
      setError((failure as Error).message);
      try {
        await onRefresh();
      } catch {
        // Keep the original provider error visible if the follow-up refresh fails.
      }
    } finally {
      setAction(null);
    }
  }

  function saveProvider() {
    void runAction("save", async () => {
      await persistProvider();
      setNotice("供应商配置已保存。");
    });
  }

  function fetchModels() {
    void runAction("models", async () => {
      const target = providerDirty ? await persistProvider() : storedProvider;
      if (!target) throw new Error("请先保存供应商，再获取模型列表。");
      const result = await request({
        type: "provider.models",
        providerId: target.id,
      });
      const nextModels = [...new Set(result.models ?? [])];
      setModels(nextModels);
      setNotice(
        nextModels.length
          ? `已获取 ${nextModels.length} 个模型。`
          : "服务没有返回可选模型，请继续手动填写模型名称。",
      );
    });
  }

  function testProvider() {
    void runAction("test", async () => {
      const target = providerDirty ? await persistProvider() : storedProvider;
      if (!target) throw new Error("请先保存供应商，再测试连接。");
      const result = await request({
        type: "provider.test",
        providerId: target.id,
      });
      if (!result.connectionCheck) throw new Error("服务没有返回检测结果。");
      setConnectionCheck(result.connectionCheck);
      setNotice(result.connectionCheck.ok ? "连接测试通过。" : "连接测试未通过。");
      await onRefresh();
    });
  }

  function activateProvider() {
    void runAction("activate", async () => {
      const target = providerDirty ? await persistProvider() : storedProvider;
      if (!target) throw new Error("请先保存供应商，再将其设为当前连接。");
      await request({ type: "provider.activate", providerId: target.id });
      await onActivated(target.id);
      setNotice(`${target.name} 已设为当前供应商。`);
    });
  }

  function deleteProvider() {
    if (!storedProvider || isActive)
      return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setError("");
      setConnectionCheck(null);
      setNotice("再次点击“确认删除”即可移除此供应商。");
      return;
    }
    void runAction("delete", async () => {
      await request({
        type: "provider.delete",
        providerId: storedProvider.id,
      });
      const fallback =
        snapshot.providers.find(
          (item) => item.id === snapshot.settings.activeProviderId,
        ) ?? snapshot.providers.find((item) => item.id !== storedProvider.id);
      if (fallback) loadProvider(fallback);
      await onRefresh();
      setNotice("供应商已删除。");
    });
  }

  const actionLabel: Record<ProviderAction, string> = {
    save: "正在保存",
    activate: "正在启用",
    models: "正在获取模型",
    test: "正在测试",
    delete: "正在删除",
  };

  return (
    <div className="model-settings">
      <section className="settings-section">
        <h2>当前连接</h2>
        <p className="settings-section-description">
          在这里为 NEXIOM 配置 API 地址、密钥和模型。连接配置、项目记忆和会话记录由 NEXIOM 独立管理。
        </p>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <strong>{snapshot.runtime.activeProviderName || "模型服务"}</strong>
              <p>
                <span
                  className={`status-dot ${snapshot.runtime.connected ? "ready" : ""}`}
                />
                {snapshot.runtime.label}
              </p>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={locked}
              onClick={onCheck}
            >
              <RefreshCw size={14} className={busy ? "spin" : undefined} />
              重新检测
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <strong>当前模型</strong>
              <p>{needsSetup ? "填写下方 API 地址、API Key 和模型名称后保存，即可开始对话。" : "新任务将使用此模型；现有会话会按供应商配置恢复。"}</p>
            </div>
            <span className="settings-value provider-active-model">
              {activeModel}
            </span>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <strong>兼容协议</strong>
              <p>
                请使用支持 OpenAI Responses API 的模型服务。其他 API 协议尚未接入。
              </p>
            </div>
            <span className="settings-value">Responses</span>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="provider-section-heading">
          <div>
            <h2>模型供应商</h2>
            <p>每个供应商分别保存地址、模型和 API Key，仅用于 NEXIOM。</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={locked}
            onClick={addProvider}
          >
            <Plus size={14} />
            添加供应商
          </button>
        </div>

        <div className="settings-card provider-manager">
          <aside className="provider-list-pane" aria-label="模型供应商列表">
            <div className="provider-list-caption">
              <span>{snapshot.providers.length} 个配置</span>
            </div>
            <div className="provider-list">
              {snapshot.providers.map((item) => {
                const active = item.id === snapshot.settings.activeProviderId;
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`provider-list-item ${selectedId === item.id ? "selected" : ""}`}
                    aria-pressed={selectedId === item.id}
                    onClick={() => selectProvider(item.id)}
                    disabled={action !== null}
                  >
                    <Server size={16} />
                    <span>
                      <span className="provider-list-title">
                        <strong>{item.name}</strong>
                        {active && <em>当前</em>}
                      </span>
                      <small>
                        {item.modelName || item.model || "待配置模型"}
                      </small>
                    </span>
                  </button>
                );
              })}
              {isNew && (
                <button
                  type="button"
                  className="provider-list-item selected"
                  aria-pressed="true"
                >
                  <Server size={16} />
                  <span>
                    <span className="provider-list-title">
                      <strong>{provider.name || "新供应商"}</strong>
                    </span>
                    <small>Responses API</small>
                  </span>
                </button>
              )}
            </div>
          </aside>

          <form
            className="provider-editor"
            onSubmit={(event) => {
              event.preventDefault();
              saveProvider();
            }}
          >
            <header className="provider-editor-header">
              <div>
                <strong>{isNew ? "添加供应商" : "编辑供应商"}</strong>
              </div>
              <span className="provider-protocol">
                Responses
              </span>
            </header>

            <label className="provider-field">
              <span>
                <strong>供应商名称</strong>
              </span>
              <input
                aria-label="供应商名称"
                value={provider.name}
                maxLength={80}
                onChange={(event) =>
                  updateProvider({ ...provider, name: event.target.value })
                }
                placeholder="例如：OpenAI"
              />
            </label>

            {provider.kind === "responses" && (
              <>
                <label className="provider-field">
                  <span>
                    <strong>API 地址</strong>
                  </span>
                  <input
                    aria-label="API 地址"
                    type="url"
                    value={provider.endpoint}
                    onChange={(event) =>
                      updateProvider({
                        ...provider,
                        endpoint: event.target.value,
                      })
                    }
                    placeholder="https://api.openai.com/v1"
                  />
                </label>

                <label className="provider-field">
                  <span>
                    <strong>认证方式</strong>
                  </span>
                  <select
                    aria-label="认证方式"
                    value={provider.auth}
                    onChange={(event) => {
                      const auth = event.target.value as ProviderDraft["auth"];
                      if (auth === "none") {
                        setApiKey("");
                        setClearApiKey(Boolean(storedProvider?.hasApiKey));
                      } else {
                        setClearApiKey(false);
                      }
                      updateProvider({ ...provider, auth });
                    }}
                  >
                    <option value="bearer">Bearer API Key</option>
                    <option value="none">无需认证</option>
                  </select>
                </label>

                {provider.auth === "bearer" && (
                  <div className="provider-field provider-key-field">
                    <span>
                      <strong>API Key</strong>
                    </span>
                    <div className="provider-key-control">
                      <label>
                        <KeyRound size={14} />
                        <input
                          aria-label="API Key"
                          type="password"
                          autoComplete="new-password"
                          value={apiKey}
                          disabled={clearApiKey}
                          onChange={(event) => {
                            setApiKey(event.target.value);
                            setClearApiKey(false);
                            setError("");
                            setNotice("");
                          }}
                          placeholder={
                            storedProvider?.hasApiKey
                              ? "已配置，留空则保留"
                              : "输入 API Key"
                          }
                        />
                      </label>
                      {storedProvider?.hasApiKey && (
                        <label className="provider-clear-key">
                          <input
                            type="checkbox"
                            checked={clearApiKey}
                            onChange={(event) => {
                              setClearApiKey(event.target.checked);
                              if (event.target.checked) setApiKey("");
                              setError("");
                              setNotice("");
                            }}
                          />
                          删除已保存的密钥
                        </label>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            <label className="provider-field">
              <span>
                <strong>模型名称</strong>
              </span>
              <input
                aria-label="模型名称"
                value={provider.modelName}
                maxLength={80}
                onChange={(event) =>
                  updateProvider({ ...provider, modelName: event.target.value })
                }
                placeholder="自定义显示名称"
              />
            </label>

            <div className="provider-field provider-model-field">
              <span>
                <strong>模型 ID</strong>
              </span>
              <div className="provider-model-control">
                <div>
                  <input
                    aria-label="模型 ID"
                    value={provider.model}
                    maxLength={120}
                    onChange={(event) =>
                      updateProvider({ ...provider, model: event.target.value })
                    }
                    placeholder="填写请求使用的模型 ID"
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={fetchModels}
                    title={providerDirty ? "先保存当前配置，再获取模型" : undefined}
                  >
                    {action === "models" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {providerDirty ? "保存并获取" : "获取模型"}
                  </button>
                </div>
                {models.length > 0 && (
                  <select
                    aria-label="已获取的模型"
                    value={models.includes(provider.model) ? provider.model : ""}
                    onChange={(event) => {
                      if (event.target.value)
                        updateProvider({
                          ...provider,
                          modelName: provider.modelName || event.target.value,
                          model: event.target.value,
                        });
                    }}
                  >
                    <option value="">选择已获取的模型</option>
                    {models.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {running && (
              <div className="provider-feedback" role="status">
                <Info size={15} />
                当前任务结束后才能修改或切换模型供应商。
              </div>
            )}
            {error && (
              <div className="provider-feedback error" role="alert">
                <Info size={15} />
                <span>{error}</span>
              </div>
            )}
            {!error && connectionCheck && (
              <div
                className={`provider-feedback ${connectionCheck.ok ? "success" : "error"}`}
                role="status"
              >
                {connectionCheck.ok ? <Check size={15} /> : <Info size={15} />}
                <span>
                  {connectionCheck.label}
                  {connectionCheck.latencyMs >= 0 &&
                    ` · ${connectionCheck.latencyMs} ms`}
                </span>
              </div>
            )}
            {!error && notice && !connectionCheck && (
              <div className="provider-feedback success" role="status">
                <Check size={15} />
                <span>{notice}</span>
              </div>
            )}

            <footer className="provider-actions">
              <div>
                {!isNew && (
                  <button
                    type="button"
                    className={`secondary-button ${confirmDelete ? "danger-button" : ""}`}
                    disabled={locked || isActive}
                    onClick={deleteProvider}
                    title={isActive ? "请先启用其他供应商" : "删除供应商"}
                  >
                    {action === "delete" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                    {confirmDelete ? "确认删除" : "删除"}
                  </button>
                )}
              </div>
              <div>
                {providerDirty && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={discardProviderChanges}
                  >
                    <X size={14} />
                    {isNew ? "取消" : "撤销"}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={testProvider}
                  title="检查 /models 与凭据，不执行完整 Agent 调用"
                >
                  {action === "test" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Server size={14} />
                  )}
                  {providerDirty ? "保存并测试" : "测试连接"}
                </button>
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={locked || !providerDirty}
                >
                  {action === "save" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Save size={14} />
                  )}
                  保存
                </button>
                {!isActive && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={locked}
                    onClick={activateProvider}
                  >
                    {action === "activate" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Power size={14} />
                    )}
                    {providerDirty ? "保存并启用" : "设为当前"}
                  </button>
                )}
              </div>
              {action && (
                <span className="sr-only" role="status">
                  {actionLabel[action]}
                </span>
              )}
            </footer>
          </form>
        </div>
      </section>

      <section className="settings-section">
        <h2>运行参数</h2>
        <div className="settings-card">
          <label className="settings-row">
            <span className="settings-row-copy">
              <strong>推理强度</strong>
              <span>更高的强度可能需要更多时间和用量。</span>
            </span>
            <select
              aria-label="推理强度"
              value={settings.effort}
              onChange={(event) =>
                onChange({
                  ...settings,
                  effort: event.target.value as AgentSettings["effort"],
                })
              }
            >
              <option value="default">默认</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="xhigh">最高</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}
