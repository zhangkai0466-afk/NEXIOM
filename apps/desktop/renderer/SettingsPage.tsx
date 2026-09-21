import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  FolderOpen,
  Info,
  LoaderCircle,
  Search,
  Settings2,
  SlidersHorizontal,
  Sun,
  UserRound,
  X,
} from "lucide-react";
import type {
  AgentSettings,
  Project,
  Snapshot,
  ThreadContext,
} from "../../../packages/contracts";
import { version } from "../../../package.json";
import { request } from "./bridge";
import { AppearanceSettings, type AppearanceState } from "./Appearance";
import { ModelSettings } from "./ModelSettings";
import { ContextDetails, ProjectMemoryEditor } from "./ProjectContext";
import { AccountSettings } from "./AccountSettings";

export type SettingsCategory =
  "account" | "general" | "appearance" | "model" | "memory" | "about";
const categories = [
  {
    id: "account",
    label: "账户",
    group: "个人",
    icon: UserRound,
    terms: "头像 昵称 个人资料 token tokens 用量 日期",
  },
  {
    id: "general",
    label: "常规",
    group: "个人",
    icon: Settings2,
    terms: "执行 权限 程序联网 网络 确认",
  },
  {
    id: "appearance",
    label: "外观",
    group: "个人",
    icon: Sun,
    terms: "主题 暗色 浅色 跟随系统 界面字号 全局字号 对话字号 代码字号 字体 减少动态效果 动画",
  },
  {
    id: "model",
    label: "模型连接",
    group: "Agent",
    icon: SlidersHorizontal,
    terms:
      "连接方式 连接状态 API 地址 Key 密钥 Responses 模型名称 模型 ID 推理强度",
  },
  {
    id: "memory",
    label: "项目记忆",
    group: "Agent",
    icon: BookOpen,
    terms: "项目 目录 MEMORY 上下文 窗口 tokens 压缩 会话恢复",
  },
  {
    id: "about",
    label: "关于 NEXIOM",
    group: "应用",
    icon: Info,
    terms: "版本 软件 开源 许可 桌面 Electron 内核 架构",
  },
] as const;
const sameSettings = (a: AgentSettings, b: AgentSettings) =>
  JSON.stringify(a) === JSON.stringify(b);

export function SettingsPage({
  initialCategory,
  snapshot,
  appearance,
  project,
  context,
  running,
  onSaved,
  onBack,
}: {
  initialCategory: SettingsCategory;
  snapshot: Snapshot;
  appearance: AppearanceState;
  project?: Project;
  context?: ThreadContext;
  running: boolean;
  onSaved: () => Promise<void>;
  onBack: () => void;
}) {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(snapshot.settings);
  const [baseline, setBaseline] = useState(snapshot.settings);
  const [busy, setBusy] = useState(false);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerDirty, setProviderDirty] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountDirty, setAccountDirty] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const lastSettings = useRef(JSON.stringify(snapshot.settings));
  const dirty = !sameSettings(settings, baseline);
  const anyDirty = dirty || providerDirty || accountDirty;
  const blocked = busy || providerBusy || accountBusy;
  const filtered = categories.filter((item) =>
    `${item.label} ${item.terms}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [category, query]);
  useEffect(() => {
    const current = JSON.stringify(snapshot.settings);
    if (current === lastSettings.current) return;
    lastSettings.current = current;
    if (!dirty && !sameSettings(snapshot.settings, baseline)) {
      setSettings(snapshot.settings);
      setBaseline(snapshot.settings);
    } else if (
      snapshot.settings.activeProviderId !== baseline.activeProviderId
    ) {
      setSettings((currentSettings) => ({
        ...currentSettings,
        activeProviderId: snapshot.settings.activeProviderId,
      }));
      setBaseline((currentBaseline) => ({
        ...currentBaseline,
        activeProviderId: snapshot.settings.activeProviderId,
      }));
    }
  }, [snapshot.settings, baseline, dirty]);
  function change(next: AgentSettings) {
    setSettings(next);
    setSaved(false);
  }
  async function save(leave = false) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await request({
        type: "runtime.configure",
        settings,
      });
      setBaseline(settings);
      await onSaved();
      setSaved(true);
      if (leave && !memoryDirty && !providerDirty && !accountDirty) onBack();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function providerActivated(providerId: string) {
    setSettings((current) => ({ ...current, activeProviderId: providerId }));
    setBaseline((current) => ({ ...current, activeProviderId: providerId }));
    setSaved(false);
    await onSaved();
  }
  async function check() {
    setBusy(true);
    setError("");
    try {
      await request({ type: "runtime.check" });
      await onSaved();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function back() {
    if (blocked) return;
    if (anyDirty || memoryDirty) setConfirmLeave(true);
    else onBack();
  }
  function navigate(next: SettingsCategory) {
    setCategory(next);
    setQuery("");
    setConfirmLeave(false);
  }
  const panels: Record<SettingsCategory, ReactNode> = {
    account: (
      <AccountSettings
        profile={snapshot.account}
        runs={snapshot.runs}
        onSaved={onSaved}
        onDirtyChange={setAccountDirty}
        onBusyChange={setAccountBusy}
      />
    ),
    general: (
      <>
        <section className="settings-section">
          <h2>任务执行</h2>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>执行方式</strong>
                <p>先讨论方案；切换到执行后，确认本次任务再自主编程和实验。</p>
              </div>
              <span className="settings-value">每次任务确认</span>
            </div>
            <label className="settings-row">
              <span className="settings-row-copy">
                <strong>允许程序联网</strong>
                <span>
                  允许研读时检索文献，以及执行任务中的程序访问网络。模型连接不受此设置影响。
                </span>
              </span>
              <input
                aria-label="允许程序联网"
                className="switch"
                type="checkbox"
                checked={settings.network}
                onChange={(event) =>
                  change({ ...settings, network: event.target.checked })
                }
              />
            </label>
          </div>
        </section>
        <section className="settings-section">
          <h2>项目工作区</h2>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>当前项目</strong>
                <p>
                  {project
                    ? project.name
                    : "返回应用后创建项目，或打开现有文件夹。"}
                </p>
              </div>
              <span className="settings-value">
                {project ? "本地项目" : "未选择"}
              </span>
            </div>
            {project && (
              <div className="settings-row">
                <div className="settings-row-copy">
                  <strong>工作目录</strong>
                  <p className="settings-project-path">{project.root}</p>
                </div>
                <FolderOpen size={16} className="muted" />
              </div>
            )}
          </div>
        </section>
      </>
    ),
    appearance: <AppearanceSettings appearance={appearance} />,
    model: (
      <ModelSettings
        snapshot={snapshot}
        settings={settings}
        busy={busy}
        running={running}
        onChange={change}
        onRefresh={onSaved}
        onActivated={providerActivated}
        onDirtyChange={setProviderDirty}
        onBusyChange={setProviderBusy}
        onCheck={() => void check()}
      />
    ),
    memory: project ? (
      <>
        <section className="settings-section">
          <h2>{project.name}</h2>
          <p className="settings-section-description">
            记录研究目标、已确认的假设与实验约定。保存后，在该项目的后续任务中使用。
          </p>
          <div className="settings-card">
            <ProjectMemoryEditor
              projectId={project.id}
              running={running}
              onDirtyChange={setMemoryDirty}
            />
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-card">
            <ContextDetails context={context} />
          </div>
        </section>
      </>
    ) : (
      <div className="settings-empty">
        <BookOpen size={28} />
        <h2>还没有选择项目</h2>
        <p>先创建项目或打开文件夹，即可管理项目记忆与会话上下文。</p>
        <button className="secondary-button" onClick={back}>
          返回应用
        </button>
      </div>
    ),
    about: (
      <>
        <section className="settings-section">
          <h2>应用</h2>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>NEXIOM</strong>
                <p>面向数学建模的项目级 Agent 工作台</p>
              </div>
              <span className="settings-value">{version}</span>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>独立 Agent</strong>
                <p>NEXIOM 使用自己的模型连接和会话数据，支持工具执行、会话恢复和上下文管理。</p>
              </div>
              <span className="settings-value">
                内置运行环境
              </span>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>项目数据</strong>
                <p>
                  项目文件与记忆保存在本地工作区，API 配置和会话记录保存在 NEXIOM 专属的应用数据中。
                </p>
              </div>
            </div>
          </div>
        </section>
        <section className="settings-section">
          <h2>开源与许可</h2>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>Codex</strong>
                <p>
                  Agent 内核采用 Apache-2.0 许可。NEXIOM 的图形界面独立实现。
                </p>
              </div>
              <span className="settings-value">Apache-2.0</span>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <strong>第三方组件</strong>
                <p>
                  Electron、React、Lucide、Motion 与 Thinking Orbs
                  等组件的许可随软件保存在 licenses 目录。
                </p>
              </div>
            </div>
          </div>
        </section>
      </>
    ),
  };
  return (
    <div className={`settings-page ${window.nexiom ? "desktop-app" : ""}`}>
      <div className="window-chrome settings-chrome">
        <button
          className="icon-button"
          aria-label="返回应用"
          onClick={back}
          disabled={blocked}
        >
          <ArrowLeft size={16} />
        </button>
        <span>NEXIOM</span>
        <ChevronRight size={12} />
        <span>设置</span>
      </div>
      <aside className="settings-sidebar">
        <button className="settings-back" onClick={back} disabled={blocked}>
          <ArrowLeft size={16} />
          返回应用
        </button>
        <label className="settings-search">
          <Search size={15} />
          <input
            aria-label="搜索设置"
            placeholder="搜索设置…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="清除设置搜索"
              onClick={() => setQuery("")}
            >
              <X size={13} />
            </button>
          )}
        </label>
        <nav aria-label="设置分类">
          {["个人", "Agent", "应用"].map((group) => (
            <div className="settings-nav-group" key={group}>
              <div className="settings-nav-caption">{group}</div>
              {categories
                .filter((item) => item.group === group)
                .map((item) => (
                  <button
                    key={item.id}
                    className={`settings-nav-item ${!query && category === item.id ? "active" : ""}`}
                    aria-current={
                      !query && category === item.id ? "page" : undefined
                    }
                    onClick={() => navigate(item.id)}
                  >
                    <item.icon size={16} />
                    <span>{item.label}</span>
                    {query && filtered.includes(item) && (
                      <span className="settings-match-dot" />
                    )}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="settings-sidebar-foot">
          <CircleHelp size={15} />
          <span>NEXIOM {version}</span>
        </div>
      </aside>
      <main className="settings-main" ref={contentRef}>
        <div className={`settings-content ${!query && category === "account" ? "account-settings-content" : ""}`}>
          {(query || category !== "account") && (
            <h1>
              {query
                ? "搜索设置"
                : categories.find((item) => item.id === category)?.label}
            </h1>
          )}
          {confirmLeave && (
            <div className="settings-leave-notice" role="alert">
              <strong>还有未保存的更改</strong>
              <p>
                {memoryDirty
                  ? "项目记忆尚未保存，请回到项目记忆保存，或放弃更改后返回应用。"
                  : providerDirty
                    ? "模型供应商还有未保存的更改，请回到模型连接保存，或放弃更改后返回应用。"
                  : accountDirty
                    ? "账户资料尚未保存。"
                  : "保存当前配置，或放弃更改后返回应用。"}
              </p>
              <div>
                {!memoryDirty && !providerDirty && !accountDirty && dirty && (
                  <button
                    className="primary-button"
                    disabled={blocked}
                    onClick={() => void save(true)}
                  >
                    保存并返回
                  </button>
                )}
                {memoryDirty && (
                  <button
                    className="primary-button"
                    onClick={() => navigate("memory")}
                  >
                    查看项目记忆
                  </button>
                )}
                {!memoryDirty && providerDirty && (
                  <button
                    className="primary-button"
                    onClick={() => navigate("model")}
                  >
                    查看模型连接
                  </button>
                )}
                {!memoryDirty && !providerDirty && accountDirty && (
                  <button
                    className="primary-button"
                    onClick={() => navigate("account")}
                  >
                    查看账户资料
                  </button>
                )}
                <button
                  className="secondary-button"
                  onClick={onBack}
                  disabled={blocked}
                >
                  放弃更改并返回
                </button>
                <button
                  className="text-button"
                  onClick={() => setConfirmLeave(false)}
                >
                  继续编辑
                </button>
              </div>
            </div>
          )}
          {query && (
            <div className="settings-search-results">
              {filtered.length ? (
                <>
                  <p className="settings-section-description">
                    找到 {filtered.length} 个相关分类
                  </p>
                  <div className="settings-card">
                    {filtered.map((item) => (
                      <button
                        className="settings-result"
                        key={item.id}
                        onClick={() => navigate(item.id)}
                      >
                        <item.icon size={18} />
                        <span>
                          <strong>{item.label}</strong>
                          <small>{item.terms}</small>
                        </span>
                        <ChevronRight size={16} />
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="settings-empty">
                  <Search size={28} />
                  <h2>没有找到相关设置</h2>
                  <p>试试“主题”“模型”或“程序联网”。</p>
                </div>
              )}
            </div>
          )}
          {categories.map((item) => (
            <div key={item.id} hidden={!!query || category !== item.id}>
              {panels[item.id]}
            </div>
          ))}
          {(category === "general" ||
            category === "model" ||
            dirty ||
            error) && (
            <div className="settings-save-bar">
              <div role="status">
                {error ? (
                  <span className="form-error">{error}</span>
                ) : saved ? (
                  <span className="settings-saved">
                    <Check size={14} />
                    设置已保存，下次任务生效
                  </span>
                ) : (
                  <span>
                    {dirty
                      ? "有未保存的配置更改"
                      : providerDirty
                        ? "供应商配置尚未保存，请使用上方操作"
                      : "修改配置后保存，下次任务生效"}
                  </span>
                )}
              </div>
              <button
                className="primary-button"
                disabled={blocked || !dirty}
                onClick={() => void save()}
              >
                {busy && <LoaderCircle size={14} className="spin" />}保存设置
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
