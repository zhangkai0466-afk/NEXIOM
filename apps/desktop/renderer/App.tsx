import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  ArrowDown,
  ArrowRight,
  BookOpen,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Check,
  CircleCheck,
  File,
  FolderOpen,
  FolderPlus,
  Info,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Plus,
  Settings2,
  SquarePen,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type {
  Snapshot,
  ProjectFile,
  FileContent,
  CoreResponse,
  CoreEvent,
  Project,
  Thread,
  ConversationStage,
  Command,
  AgentItem,
} from "../../../packages/contracts";
import { applyDesktopUpdate, request, subscribe } from "./bridge";
import { createSnapshotRefresh, type SnapshotRefresh, type RefreshFailure } from "./snapshot-refresh";
import { AgentOutput, RichText } from "./AgentOutput";
import { useAppearance } from "./Appearance";
import { ContextDetails } from "./ProjectContext";
import { SettingsPage, type SettingsCategory } from "./SettingsPage";
import { ProjectResetPanel } from "./ProjectResetPanel";
import { readPreference, removePreference, writePreference } from "./preferences";
import { ModelingSidebar, dimensionName, isThreadStage, projectDisplayName, readProjectSelection, type Dimension } from "./ModelingSidebar";
import { AgentActivity } from "./AgentActivity";
import { getAgentItemOutcome, outputBlockedByThinking } from "./agent-task-state";
import { PdfViewer } from "./PdfViewer";
import { ChromeMenuBar } from "./ChromeMenuBar";
import { VisualDesignWorkspace } from "./VisualDesignWorkspace";
import { WorkspaceLogo } from "./WorkspaceLogo";
import { NexiomMark } from "./NexiomMark";
import { VisualizationIcon } from "./VisualizationIcon";
import {
  ReadingWorkspace,
  READING_TASK_MARKER,
  type ReadingCorrectionTarget,
} from "./ReadingWorkspace";
import {
  AttachmentWorkspace,
  ATTACHMENT_ANALYSIS_LIMIT,
  type AttachmentCorrectionTarget,
} from "./AttachmentWorkspace";
import { MotionConfig } from "motion/react";
import { buildReadingDiscussionPrompt, readingReportStructure } from "../../../packages/contracts/reading-workflow";
import { buildAttachmentTaskPrompt, buildAttachmentCorrectionPrompt } from "../../../packages/contracts/attachment-workflow";
import logo from "../../../assets/brand/nexiom-desktop-icon-1024.png";

const emptySnapshot: Snapshot = {
  tokenActivity: [],
  projects: [],
  questions: [],
  threads: [],
  messages: [],
  runs: [],
  events: [],
  runtime: {
    connected: false,
    available: false,
    authenticated: false,
    label: "正在读取 NEXIOM 配置",
    version: "",
    hasApiKey: false,
    activeProviderId: "nexiom-default",
    activeProviderName: "NEXIOM API",
    activeModel: "",
    activeModelProvider: "",
  },
  settings: {
    activeProviderId: "nexiom-default",
    effort: "default",
    network: false,
  },
  providers: [
    {
      id: "nexiom-default",
      name: "NEXIOM API",
      kind: "responses",
      endpoint: "https://api.openai.com/v1",
      modelName: "",
      model: "",
      auth: "bearer",
      revision: 1,
      hasApiKey: false,
      createdAt: "",
      updatedAt: "",
    },
  ],
  items: [],
  contexts: [],
  account: { nickname: "NEXIOM 用户", avatar: null },
};
const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const time = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': Error:\s*/,
    "",
  );
const projectRecordSaveFailure = "无法安全移除项目：最新项目记录未能保存";
const CASUAL_PROJECT_NAME = "__nexiom_casual_chat__";
const isCasualProject = (item?: Pick<Project, "name">) => item?.name === CASUAL_PROJECT_NAME;
const folderName = (value: string) => value.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || value;
const SIDEBAR_DEFAULT_WIDTH = 248;
const SIDEBAR_COLLAPSE_THRESHOLD = 176;
const SIDEBAR_MAX_WIDTH = 420;
const MAIN_MIN_WIDTH = 480;
const sidebarMaximum = () =>
  Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_DEFAULT_WIDTH, window.innerWidth - MAIN_MIN_WIDTH),
  );
const initialSidebarWidth = () => {
  const stored = Number(readPreference("nexiom.sidebarWidth"));
  return Number.isFinite(stored) && stored >= SIDEBAR_COLLAPSE_THRESHOLD
    ? Math.min(stored, sidebarMaximum())
    : SIDEBAR_DEFAULT_WIDTH;
};

function buildReadingTaskPrompt(files: ProjectFile[]) {
  const relevantFiles = files
    .filter((file) => file.path.replace(/\\/g, "/").toLowerCase().startsWith("inputs/") && file.extension.toLowerCase() === ".pdf")
    .slice(0, 8);
  const materials = relevantFiles.length
    ? relevantFiles.map((file) => `- ${file.name.slice(0, 80)}`).join("\n")
    : "- 暂无已导入材料";
  return `${READING_TASK_MARKER}

你正在执行数学建模赛题的正式研读，不是普通聊天。请逐一打开并完整读取项目中的赛题文件。你的目标是帮助参赛者准确理解题目，而不是提前编造结论。凡是文件中无法可靠解析的公式、图片或表格，必须定位并标为待核对。

研读过程中使用 nexiom_reading.set_reading_stage 如实报告阶段开始与完成。顺序为起始思考（仅在实际发生时）→阅读→分析→思考→按需检索→思考→编写，第一项实质工作必须是阅读赛题。不需检索可从思考进入编写。每个阶段代表一个完整工作目标，分批读取、逐问拆解、内部思考和多次查询都在所属阶段内完成，不为小动作反复上报阶段。重读和反复查证纳入当前复核工作；确需再次开启主阶段时仍如实报告，界面合并到原有环节，最多展示七个节点。只有达到工作目标或明确留下待核对项才报告完成。界面只显示阶段动画，不展示过程正文或隐藏思维链。完成术语、信息泄漏及跨问依赖核验后输出唯一一份完整报告。口径推荐限于题意理解，最终交由人工抉择；严禁输出可行路线或建模建议。

【项目材料】
${materials}

【研读要求】
${readingReportStructure}`;
}

function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement>("input:not([type='file']), textarea")?.focus();
  }, []);
  return (
    <dialog
      className={`${wide ? "modal wide" : "modal"} ${className}`.trim()}
      ref={ref}
      aria-label={title}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <IconButton label="关闭" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      {children}
    </dialog>
  );
}
function EventRow({ event }: { event: CoreEvent }) {
  const success = event.type.endsWith("completed");
  const failure = /failed|interrupted|cancelled/.test(event.type);
  return (
    <details className={`event-row ${failure ? "event-error" : ""}`}>
      <summary>
        <ChevronRight className="disclosure" size={13} />
        {success ? (
          <CircleCheck size={15} className="success" />
        ) : (
          <Terminal size={15} />
        )}
        <span>{event.summary}</span>
        <time>{time(event.createdAt)}</time>
      </summary>
      <div className="event-detail">
        <span>{event.type}</span>
        <code>{event.runId ?? event.id}</code>
        <span>{new Date(event.createdAt).toLocaleString("zh-CN")}</span>
      </div>
    </details>
  );
}

export function App({ onStartupReady }: { onStartupReady?: (ready: boolean) => void }) {
  const requestedThreadId = useRef(new URLSearchParams(window.location.search).get("thread") ?? "");
  const detachedWindow = useRef(!!requestedThreadId.current).current;
  const appearance = useAppearance();
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [projectId, setProjectId] = useState(
    () => readPreference("nexiom.project") ?? "",
  );
  const [insideProject, setInsideProject] = useState(() => detachedWindow || readPreference("nexiom.navLayer") === "workspace");
  const [casualMode, setCasualMode] = useState(() => readPreference("nexiom.casualMode") === "true");
  const [dimension, setDimension] = useState<Dimension>(() => readProjectSelection(readPreference("nexiom.project") ?? "").dimension);
  const [threadId, setThreadId] = useState(
    () => requestedThreadId.current || readProjectSelection(readPreference("nexiom.project") ?? "").threadId,
  );
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!loading) onStartupReady?.(true);
  }, [loading, onStartupReady]);
  useEffect(() => {
    let previous: boolean | null = null;
    const syncModalState = () => {
      const open = Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'));
      if (open === previous) return;
      previous = open;
      window.nexiom?.setWindowModalState?.(open);
    };
    const observer = new MutationObserver(syncModalState);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "aria-modal"],
    });
    syncModalState();
    return () => {
      observer.disconnect();
      if (previous) window.nexiom?.setWindowModalState?.(false);
    };
  }, []);
  const [error, setError] = useState("");
  const [refreshFailure, setRefreshFailure] = useState<RefreshFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [modal, setModal] = useState<"project" | "rename" | "context" | null>(
    null,
  );
  const [name, setName] = useState("");
  const [projectFolder, setProjectFolder] = useState("");
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [openingDimension, setOpeningDimension] = useState(false);
  const [dimensionAttempt, setDimensionAttempt] = useState(0);
  const [renamingProject, setRenamingProject] = useState<Project | null>(null);
  const [removingProject, setRemovingProject] = useState<Project | null>(null);
  const [resettingProject, setResettingProject] = useState<Project | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState("");
  const [deletingThread, setDeletingThread] = useState<Thread | null>(null);
  const [projectName, setProjectName] = useState("");
  const [newThread, setNewThread] = useState<{ projectId: string; stageId: ConversationStage } | null>(null);
  const [questionName, setQuestionName] = useState("");
  const [threadName, setThreadName] = useState("");
  const [view, setView] = useState<"conversation" | "activity">("conversation");
  const [settingsPage, setSettingsPage] = useState<SettingsCategory | null>(
    null,
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const settingsReturn = useRef({
    top: 0,
    stick: true,
    focus: null as HTMLElement | null,
  });
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 850);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const sidebarResize = useRef({
    active: false,
    pointerId: -1,
    open: true,
    width: sidebarWidth,
    restoreWidth: sidebarWidth,
  });
  const picker = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const snapshotRefresh = useRef<SnapshotRefresh<Snapshot> | null>(null);
  const hasSnapshot = useRef(false);
  const filesRequest = useRef(0);
  const submitId = useRef<{
    threadId: string;
    text: string;
    id: string;
  } | null>(null);
  const project = snapshot.projects.find((item) => item.id === projectId);
  const casualProject = snapshot.projects.find(isCasualProject);
  const casualThreads = snapshot.threads.filter((item) => item.projectId === casualProject?.id && item.stageId === "model");
  const visibleProjects = snapshot.projects.filter((item) => !isCasualProject(item));
  const threads = snapshot.threads.filter(
    (item) => item.projectId === projectId,
  );
  const thread = threads.find((item) => item.id === threadId);
  const dimensionThread = dimension !== "overview" && !isThreadStage(dimension) ? threads.find((item) => item.stageId === dimension) : undefined;
  const showProjectOverview = insideProject && !!project && !casualMode && dimension === "overview";
  const showConversation = !showProjectOverview && insideProject && !!thread && thread.stageId === dimension;
  const showReadingWorkspace = showConversation && !casualMode && dimension === "reading" && view === "conversation";
  const showAttachmentWorkspace = showConversation && !casualMode && dimension === "attachments" && view === "conversation";
  const showStructuredWorkspace = showReadingWorkspace || showAttachmentWorkspace;
  const showVisualLibrary = insideProject && !!project && !casualMode && dimension === "chart" && !showConversation && view !== "activity";
  const currentQuestion = snapshot.questions.find((item) => item.id === thread?.questionId);
  const messages = snapshot.messages.filter(
    (item) => item.threadId === threadId,
  );
  const agentItems = snapshot.items.filter(
    (item) => item.threadId === threadId,
  );
  const activeProvider = snapshot.providers.find(
    (item) => item.id === snapshot.settings.activeProviderId,
  );
  const configuredProviders = snapshot.providers.filter((item) => item.model);
  const activeModelLabel = activeProvider?.modelName || activeProvider?.model || "配置模型";
  const needsModelSetup = !activeProvider?.model ||
    (activeProvider.auth === "bearer" && !activeProvider.hasApiKey);
  const context = snapshot.contexts?.find((item) => item.threadId === threadId);
  const runs = snapshot.runs.filter((item) => item.projectId === projectId);
  const activeRun = runs.find((item) => item.status === "running");
  const threadRuns = runs
    .filter((item) => item.threadId === threadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latestThreadRun = threadRuns.at(-1);
  const events = snapshot.events.filter((item) => item.projectId === projectId);
  const draft = drafts[threadId] ?? "";
  const toolEvents = events.filter(
    (item) =>
      item.runId &&
      snapshot.runs.some(
        (run) =>
          run.id === item.runId &&
          run.threadId === threadId &&
          run.kind !== "agent",
      ),
  );
  const timeline = [
    ...messages.map((message) => ({
      type: "message" as const,
      value: message,
    })),
    ...toolEvents.map((event) => ({ type: "event" as const, value: event })),
    ...agentItems
      .filter((item) => item.item.type !== "reasoning" && item.item.type !== "agent_activity" && !outputBlockedByThinking(agentItems, item))
      .map((item) => ({ type: "agent" as const, value: item })),
  ].sort((a, b) => a.value.sequence - b.value.sequence);
  const answerHeader = (record: AgentItem) => {
    if (record.item.type !== "agent_message") return;
    const run = threadRuns.find((item) => item.id === record.runId);
    if (!run || run.kind === "inspection") return;
    const latest = agentItems.reduce<AgentItem | undefined>((chosen, item) =>
      item.runId === run.id && item.item.type === "agent_message" && !outputBlockedByThinking(agentItems, item) && (!chosen || item.sequence > chosen.sequence) ? item : chosen, undefined);
    if (latest?.id !== record.id) return;
    const streaming = run.status === "running" && getAgentItemOutcome(record) === "running";
    return (
      <AgentActivity
        run={run}
        items={agentItems}
        paused={appearance.reduceMotion}
        casual={casualMode}
        kind={streaming ? "writing" : undefined}
        settled={!streaming}
        ruled
      />
    );
  };
  const waitingRun = latestThreadRun && latestThreadRun.kind !== "inspection" && !timeline.some((item) =>
    item.type === "agent" && item.value.runId === latestThreadRun.id && item.value.item.type === "agent_message",
  ) ? latestThreadRun : undefined;

  const applySnapshot = useCallback((next: Snapshot) => {
    hasSnapshot.current = true;
    if (requestedThreadId.current) {
      const selected = next.threads.find((item) => item.id === requestedThreadId.current);
      if (selected) {
        setCasualMode(isCasualProject(next.projects.find((item) => item.id === selected.projectId)));
        setProjectId(selected.projectId);
        setDimension(selected.stageId);
        setThreadId(selected.id);
        setInsideProject(true);
        requestedThreadId.current = "";
      }
    }
    setSnapshot(next);
    setDrafts(previous => {
      const validIds = new Set(next.threads.map(item => item.id));
      const entries = Object.entries(previous);
      return entries.some(([id]) => !validIds.has(id)) ? Object.fromEntries(entries.filter(([id]) => validIds.has(id))) : previous;
    });
    setLoading(false);
  }, []);
  const acceptSnapshot = useCallback((next: Snapshot) => {
    snapshotRefresh.current?.accept(next);
  }, []);
  const refresh = useCallback(async () => {
    await snapshotRefresh.current?.refresh();
  }, []);
  useEffect(() => {
    const controller = createSnapshotRefresh({
      load: async () => {
        const result = await request({ type: "snapshot" });
        if (!result.snapshot) throw new Error("本地核心未返回状态，请重试。");
        return result.snapshot;
      },
      onSnapshot: applySnapshot,
      onFailure: setRefreshFailure,
      onRecovered: () => setRefreshFailure(null),
      onSettled: () => setLoading(false),
    });
    snapshotRefresh.current = controller;
    const unsubscribe = subscribe(() => controller.changed());
    let disposed = false;
    void controller.refresh();
    void request({ type: "runtime.check" })
      .then(() => { if (!disposed) return controller.refresh(); })
      .catch((err) => { if (!disposed) setError(errorMessage(err)); });
    return () => {
      disposed = true;
      unsubscribe();
      controller.dispose();
      if (snapshotRefresh.current === controller) snapshotRefresh.current = null;
    };
  }, [applySnapshot]);
  useEffect(() => {
    if (hasSnapshot.current && !loading && projectId && !project) {
      setProjectId("");
      setThreadId("");
      setInsideProject(false);
      setCasualMode(false);
    }
  }, [loading, projectId, project]);
  useEffect(() => {
    if (!hasSnapshot.current || loading || !threadId || thread) return;
    if (!detachedWindow && insideProject && project) {
      const projectThreads = snapshot.threads.filter((item) => item.projectId === project.id && !item.archivedAt);
      const fallback = projectThreads.find((item) => item.stageId === dimension) ?? projectThreads[0];
      if (fallback) {
        setDimension(fallback.stageId);
        setThreadId(fallback.id);
        writePreference(
          `nexiom.selection.${project.id}`,
          JSON.stringify({ dimension: fallback.stageId, threadId: fallback.id }),
        );
        return;
      }
    }
    setThreadId("");
  }, [loading, threadId, thread, detachedWindow, insideProject, project?.id, dimension, snapshot.threads]);
  useEffect(() => {
    if (!detachedWindow) writePreference("nexiom.navLayer", insideProject ? "workspace" : "projects");
  }, [insideProject, detachedWindow]);
  useEffect(() => {
    if (!detachedWindow) writePreference("nexiom.casualMode", String(casualMode));
  }, [casualMode, detachedWindow]);
  useEffect(() => {
    if (!detachedWindow) writePreference("nexiom.project", projectId);
  }, [projectId, detachedWindow]);
  useEffect(() => {
    if (!detachedWindow) writePreference("nexiom.thread", threadId);
  }, [threadId, detachedWindow]);
  useEffect(() => {
    if (!insideProject || !project || isThreadStage(dimension) || dimension === "overview") {
      if (insideProject && project && dimension === "overview" && threadId) {
        setThreadId("");
        writePreference(`nexiom.selection.${project.id}`, JSON.stringify({ dimension: "overview", threadId: "" }));
      }
      setOpeningDimension(false);
      return;
    }
    const selectedProjectId = project.id;
    const stageId = dimension;
    let cancelled = false;
    const select = (selected: Thread) => {
      setThreadId(selected.id);
      writePreference(`nexiom.selection.${selectedProjectId}`, JSON.stringify({ dimension: stageId, threadId: selected.id }));
    };
    if (dimensionThread) {
      if (threadId !== dimensionThread.id) select(dimensionThread);
      setOpeningDimension(false);
      return;
    }
    setOpeningDimension(true);
    void request({ type: "thread.ensure", projectId: selectedProjectId, stageId })
      .then((result) => {
        if (cancelled) return;
        if (!result.thread) throw new Error("无法打开对话，请重新点击该工作维度。");
        const created = result.thread;
        setSnapshot((current) => current.threads.some((item) => item.id === created.id) ? current : { ...current, threads: [...current.threads, created] });
        select(created);
      })
      .catch((failure) => { if (!cancelled) setError(errorMessage(failure)); })
      .finally(() => { if (!cancelled) setOpeningDimension(false); });
    return () => { cancelled = true; };
  }, [insideProject, project?.id, dimension, dimensionThread?.id, threadId, dimensionAttempt]);
  const loadFiles = useCallback(async () => {
    const generation = ++filesRequest.current;
    if (!projectId) {
      setFiles([]);
      return;
    }
    try {
      const result = await request({ type: "project.files", projectId });
      if (generation === filesRequest.current) setFiles(result.files ?? []);
    } catch (err) {
      if (generation === filesRequest.current) {
        setFiles([]);
        setError(errorMessage(err));
      }
    }
  }, [projectId]);
  useEffect(() => {
    setFiles([]);
    setPreview(null);
    void loadFiles();
  }, [loadFiles]);
  const runStates = runs.map((run) => `${run.id}:${run.status}`).join(",");
  useEffect(() => {
    void loadFiles();
  }, [runStates, loadFiles]);
  useEffect(() => {
    stickToBottom.current = true;
    setShowScrollDown(false);
    requestAnimationFrame(() =>
      endRef.current?.scrollIntoView({ block: "end" }),
    );
  }, [threadId, view]);
  useEffect(() => {
    if (!stickToBottom.current) return;
    const frame = requestAnimationFrame(() =>
      endRef.current?.scrollIntoView({ block: "end" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [snapshot.items, messages.length, toolEvents.length]);
  useEffect(() => {
    const media = matchMedia("(max-width: 850px)");
    const update = () => {
      if (media.matches) {
        setSidebar(false);
      }
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setModelMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [modelMenuOpen]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const activateComposerModel = (providerId: string) => {
    setModelMenuOpen(false);
    if (providerId === snapshot.settings.activeProviderId || busy || activeRun) return;
    void act(async () => {
      const result = await request({ type: "provider.activate", providerId });
      if (result.snapshot) acceptSnapshot(result.snapshot);
      else await refresh();
    });
  };
  const acceptSelection = async (result: CoreResponse) => {
    if (result.snapshot) {
      acceptSnapshot(result.snapshot);
    } else {
      await refresh();
    }
    if (result.thread) selectThread(result.thread, result.snapshot ?? snapshot);
    setView("conversation");
  };
  function selectWorkspace(dimension: Dimension, selectedThreadId = "", selectedProjectId = projectId) {
    setProjectId(selectedProjectId);
    setDimension(dimension);
    setThreadId(selectedThreadId);
    setView("conversation");
    if (!detachedWindow)
      writePreference(`nexiom.selection.${selectedProjectId}`, JSON.stringify({ dimension, threadId: selectedThreadId }));
  }
  function enterProject(id: string, source: Snapshot = snapshot) {
    const hasSavedSelection = readPreference(`nexiom.selection.${id}`) !== null;
    const selection = readProjectSelection(id);
    const projectThreads = source.threads.filter((item) => item.projectId === id);
    const savedThread = projectThreads.find((item) => item.id === selection.threadId);
    const needsConversation = isThreadStage(selection.dimension) && selection.dimension !== "chart";
    const fallbackThread = projectThreads.find((item) => item.stageId === selection.dimension) ?? projectThreads[0];
    const selected = selection.dimension === "overview"
      ? undefined
      : savedThread ?? (!hasSavedSelection || needsConversation ? fallbackThread : undefined);
    setCasualMode(false);
    selectWorkspace(selected?.stageId ?? selection.dimension, selected?.id ?? "", id);
    setInsideProject(true);
  }
  function selectThread(selected: Thread, source: Snapshot = snapshot) {
    setCasualMode(isCasualProject(source.projects.find((item) => item.id === selected.projectId)));
    selectWorkspace(selected.stageId, selected.id, selected.projectId);
    setInsideProject(true);
    if (selected.unread)
      void request({ type: "thread.unread", threadId: selected.id, unread: false })
        .then((result) => result.snapshot ? acceptSnapshot(result.snapshot) : refresh())
        .catch((err) => setError(errorMessage(err)));
  }
  function openThreadDialog(stageId: ConversationStage) {
    const questions = snapshot.questions.filter((item) => item.projectId === projectId);
    const available = questions.find((item) => !threads.some((t) => t.stageId === stageId && t.questionId === item.id));
    const numerals = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
    let index = 0;
    while (questions.some((item) => item.name === `问题${numerals[index] ?? index + 1}`)) index++;
    setQuestionName(available?.name ?? `问题${numerals[index] ?? index + 1}`);
    setThreadName("");
    setError("");
    setNewThread({ projectId, stageId });
  }
  function createThread(event: FormEvent) {
    event.preventDefault();
    if (!newThread || busy) return;
    const normalized = questionName.trim().normalize("NFKC");
    const question = snapshot.questions.find((item) => item.projectId === newThread.projectId && item.name.normalize("NFKC") === normalized);
    void act(async () => {
      await acceptSelection(await request({ type: "thread.create", ...newThread, ...(question ? { questionId: question.id } : { questionName: normalized }), ...(threadName.trim() ? { title: threadName.trim() } : {}) }));
      setNewThread(null);
    });
  }
  const createProject = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    void act(async () => {
      if (modal === "rename") {
        if (!renamingThreadId) return;
        await request({ type: "thread.rename", threadId: renamingThreadId, title: name });
        await refresh();
      } else {
        let result: CoreResponse;
        if (window.nexiom?.openSelectedProject) {
          result = await window.nexiom.openSelectedProject(projectFolder, name.trim());
        } else {
          result = await request({ type: "project.create", name });
        }
        if (result.snapshot) {
          acceptSnapshot(result.snapshot);
        } else await refresh();
        if (result.thread) selectThread(result.thread, result.snapshot ?? snapshot);
        else if (result.project) enterProject(result.project.id, result.snapshot ?? snapshot);
      }
      setModal(null);
      setRenamingThreadId(null);
      setName("");
      setProjectFolder("");
    });
  };
  const chooseProjectFolder = () =>
    void act(async () => {
      if (!window.nexiom?.chooseProjectFolder) {
        setProjectFolder("NEXIOM 工作区");
        return;
      }
      const selected = await window.nexiom.chooseProjectFolder();
      if (!selected) return;
      setProjectFolder(selected);
      setName((current) => current.trim() ? current : folderName(selected));
    });
  const addProject = () => {
    if (busy) return;
    setName("");
    setProjectFolder("");
    setError("");
    setModal("project");
  };
  const openCasualChat = (createNew = false) => {
    if (busy) return;
    void act(async () => {
      let source = snapshot;
      let casual = source.projects.find(isCasualProject);
      let selected: Thread | undefined;
      if (!casual) {
        const created = await request({ type: "project.create", name: CASUAL_PROJECT_NAME });
        source = created.snapshot ?? source;
        casual = created.project ?? source.projects.find(isCasualProject);
        selected = created.thread ?? (casual ? source.threads.find((item) => item.projectId === casual!.id) : undefined);
        if (selected) {
          const renamed = await request({ type: "thread.rename", threadId: selected.id, title: "新对话" });
          source = renamed.snapshot ?? source;
          selected = source.threads.find((item) => item.id === selected!.id) ?? { ...selected, title: "新对话" };
        }
      }
      if (!casual) throw new Error("无法打开随便聊聊。");
      const conversations = source.threads.filter((item) => item.projectId === casual.id && item.stageId === "model")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      if (!selected && createNew) {
        let title = "新对话";
        let number = 2;
        while (conversations.some((item) => item.title === title)) title = `新对话 ${number++}`;
        const createdThread = await request({ type: "thread.create", projectId: casual.id, stageId: "model", title });
        source = createdThread.snapshot ?? source;
        selected = createdThread.thread;
        if (!selected) throw new Error("无法创建新对话。");
      } else if (!selected) {
        const savedId = readProjectSelection(casual.id).threadId;
        selected = conversations.find((item) => item.id === savedId && !item.archivedAt)
          ?? conversations.find((item) => !item.archivedAt);
      }
      acceptSnapshot(source);
      setCasualMode(true);
      if (selected) selectThread(selected, source);
      else {
        selectWorkspace("model", "", casual.id);
        setInsideProject(true);
      }
    });
  };
  const openProjectRename = (target: Project) => {
    setProjectName(target.name);
    setError("");
    setRenamingProject(target);
  };
  const renameProject = (event: FormEvent) => {
    event.preventDefault();
    if (!renamingProject || busy) return;
    const target = renamingProject;
    void act(async () => {
      const result = await request({
        type: "project.rename",
        projectId: target.id,
        name: projectName,
      });
      if (result.snapshot) acceptSnapshot(result.snapshot);
      else await refresh();
      setRenamingProject(null);
      setProjectName("");
    });
  };
  const resetProject = async (command: Extract<Command, { type: "project.reset" }>) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await request(command);
      if (result.snapshot) acceptSnapshot(result.snapshot);
      else await refresh();
      removePreference(`nexiom.selection.${command.projectId}`);
      setProjectId(command.projectId);
      setInsideProject(true); setCasualMode(false);
      setThreadId(""); setDimension("reading"); setView("conversation");
      setPreview(null);
      setDimensionAttempt(value => value + 1);
      setCleanupNotice(`项目已重置，可重新开始赛题研读。${result.cleanup?.warnings.join(" ") ?? ""}`);
      setResettingProject(null);
      void loadFiles();
    } finally { setBusy(false); }
  };
  const removeProject = (discardUnsavedRecord = false) => {
    if (!removingProject || busy) return;
    const target = removingProject;
    void act(async () => {
      const result = await request({
        type: "project.remove",
        projectId: target.id,
        discardUnsavedRecord,
      });
      if (result.snapshot) acceptSnapshot(result.snapshot);
      else await refresh();
      removePreference(`nexiom.selection.${target.id}`);
      const removedThreads = new Set(
        snapshot.threads.filter((item) => item.projectId === target.id).map((item) => item.id),
      );
      setDrafts((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([id]) => !removedThreads.has(id))),
      );
      if (projectId === target.id) {
        setProjectId("");
        setThreadId("");
        setInsideProject(false);
      }
      setRemovingProject(null);
    });
  };
  const leaveThread = (target: Thread, source: Snapshot) => {
    if (threadId !== target.id) return;
    if (isCasualProject(source.projects.find((item) => item.id === target.projectId))) {
      const next = source.threads.filter((item) => item.projectId === target.projectId && item.stageId === "model" && item.id !== target.id && !item.archivedAt)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (next) {
        selectThread(next, source);
        return;
      }
    }
    selectWorkspace(target.stageId, "", target.projectId);
  };
  const updateThreadState = (command: { type: "thread.unread"; threadId: string; unread: boolean } | { type: "thread.archive"; threadId: string; archived: boolean }) => {
    if (busy) return;
    void act(async () => {
      const result = await request(command);
      if (result.snapshot) acceptSnapshot(result.snapshot);
      else await refresh();
      if (command.type === "thread.archive" && command.archived) {
        const target = snapshot.threads.find((item) => item.id === command.threadId);
        if (target) leaveThread(target, result.snapshot ?? snapshot);
      }
    });
  };
  const deleteThread = () => {
    if (!deletingThread || busy) return;
    const target = deletingThread;
    void act(async () => {
      const result = await request({ type: "thread.delete", threadId: target.id });
      if (result.snapshot) acceptSnapshot(result.snapshot);
      else await refresh();
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[target.id];
        return next;
      });
      leaveThread(target, result.snapshot ?? snapshot);
      setDeletingThread(null);
    });
  };
  const moveThread = (target: Thread, targetProjectId: string) => {
    if (busy) return;
    void act(async () => {
      const result = await request({ type: "thread.move", threadId: target.id, projectId: targetProjectId });
      if (result.snapshot) acceptSnapshot(result.snapshot);
      else await refresh();
      if (result.thread) selectThread(result.thread);
    });
  };
  const forkThread = (target: Thread, targetProjectId: string) => {
    if (busy) return;
    void act(async () => {
      const result = await request({ type: "thread.fork", threadId: target.id, projectId: targetProjectId });
      if (result.snapshot) acceptSnapshot(result.snapshot);
      else await refresh();
      if (result.thread) selectThread(result.thread);
    });
  };
  const copyThread = (target: Thread, kind: "title" | "content") => {
    const transcript = [
      ...snapshot.messages.filter((item) => item.threadId === target.id).map((item) => ({ sequence: item.sequence, text: `${item.role === "user" ? "用户" : "NEXIOM"}：${item.text}` })),
      ...snapshot.items.flatMap((item) => item.threadId === target.id && item.item.type === "agent_message" ? [{ sequence: item.sequence, text: `NEXIOM：${item.item.text}` }] : []),
    ].sort((left, right) => left.sequence - right.sequence);
    const text = kind === "title" ? target.title : [`# ${target.title}`, ...transcript.map((item) => item.text)].join("\n\n");
    void navigator.clipboard.writeText(text).catch((err) => setError(errorMessage(err)));
  };
  const openThreadWindow = (target: Thread) => {
    if (window.nexiom?.openThreadWindow) void window.nexiom.openThreadWindow(target.id).catch((err) => setError(errorMessage(err)));
    else window.open(`${window.location.pathname}?thread=${encodeURIComponent(target.id)}`, "_blank", "noopener");
  };
  const submitAgent = (
    payload: { threadId: string; text: string; clientRequestId: string },
  ) =>
    void act(async () => {
      await request({
        type: "agent.submit",
        ...payload,
      });
      stickToBottom.current = true;
      setShowScrollDown(false);
      setDrafts((previous) => ({ ...previous, [payload.threadId]: "" }));
      submitId.current = null;
      setView("conversation");
      await refresh();
    });
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || !thread || busy || activeRun) return;
    if (!snapshot.runtime.connected) {
      openSettings("model");
      return;
    }
    const target = thread.id;
    const text = draft.trim();
    if (submitId.current?.threadId !== target || submitId.current.text !== text)
      submitId.current = { threadId: target, text, id: crypto.randomUUID() };
    const id = submitId.current.id;
    const payload = { threadId: target, text, clientRequestId: id };
    submitAgent(payload);
  };
  const startReading = () => {
    if (!thread || activeRun || busy) return;
    if (!snapshot.runtime.connected) {
      openSettings("model");
      return;
    }
    submitAgent({
      threadId: thread.id,
      text: buildReadingTaskPrompt(files),
      clientRequestId: crypto.randomUUID(),
    });
  };
  const correctReading = (correction: string, target: ReadingCorrectionTarget) => {
    if (!thread || activeRun || busy) return;
    if (!snapshot.runtime.connected) {
      openSettings("model");
      return;
    }
    submitAgent({
      threadId: thread.id,
      text: buildReadingDiscussionPrompt(correction, target),
      clientRequestId: crypto.randomUUID(),
    });
  };
  const startAttachmentAnalysis = (analysisFiles: ProjectFile[]) => {
    if (!thread || activeRun || busy || !analysisFiles.length) return;
    if (!snapshot.runtime.connected) {
      openSettings("model");
      return;
    }
    submitAgent({
      threadId: thread.id,
      text: buildAttachmentTaskPrompt(analysisFiles),
      clientRequestId: crypto.randomUUID(),
    });
  };
  const correctAttachmentAnalysis = (correction: string, target: AttachmentCorrectionTarget) => {
    if (!thread || activeRun || busy) return;
    if (!snapshot.runtime.connected) {
      openSettings("model");
      return;
    }
    submitAgent({
      threadId: thread.id,
      text: buildAttachmentCorrectionPrompt(correction, target),
      clientRequestId: crypto.randomUUID(),
    });
  };
  const retryAttachmentAnalysis = (targets: AttachmentCorrectionTarget[]) => {
    if (!thread || activeRun || busy || !targets.length) return;
    if (!snapshot.runtime.connected) { openSettings("model"); return; }
    submitAgent({ threadId: thread.id, text: buildAttachmentTaskPrompt([], targets), clientRequestId: crypto.randomUUID() });
  };
  const cancelActiveRun = () => {
    if (!activeRun) return;
    void act(async () => {
      await request({ type: "run.cancel", runId: activeRun.id });
      await refresh();
    });
  };
  const removeReadingFile = async (file: ProjectFile) => {
    if (!project || busy || activeRun) return;
    await act(async () => {
      await request({ type: "file.unimport", projectId: project.id, path: file.path });
      await loadFiles();
      await refresh();
    });
  };
  const importFiles = async (selected: FileList | null) => {
    if (!selected || !project) return;
    const selectedFiles = Array.from(selected);
    const attachmentImport = dimension === "attachments" && thread?.stageId === "attachments";
    if (attachmentImport && selectedFiles.length > ATTACHMENT_ANALYSIS_LIMIT) {
      setError(`单次最多导入 ${ATTACHMENT_ANALYSIS_LIMIT} 个附件。`);
      if (picker.current) picker.current.value = "";
      return;
    }
    const target = project.id;
    const importedFiles: ProjectFile[] = [];
    let completed = false;
    await act(async () => {
      try {
        for (const file of selectedFiles) {
          if (file.size > 10 * 1024 * 1024)
            throw new Error(`${file.name} 超过 10 MB。`);
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(new Error("无法读取附件。"));
            reader.readAsDataURL(file);
          });
          const result = await request({
            type: "file.import",
            projectId: target,
            name: file.name,
            base64,
          });
          if (result.importedPath) {
            const dot = file.name.lastIndexOf(".");
            importedFiles.push({
              path: result.importedPath,
              name: file.name,
              size: file.size,
              extension: dot >= 0 ? file.name.slice(dot).toLowerCase() : "",
            });
          }
        }
        completed = true;
      } finally {
        await loadFiles();
        await refresh();
        if (picker.current) picker.current.value = "";
      }
    });
    if (completed && attachmentImport && importedFiles.length) {
      startAttachmentAnalysis(importedFiles);
    }
  };
  const openFile = (file: ProjectFile) =>
    void act(async () => {
      const result = await request({
        type: "file.read",
        projectId,
        path: file.path,
      });
      setPreview(result.file ?? null);
    });
  const readWorkspaceFile = async (file: ProjectFile) => {
    try {
      setError("");
      const result = await request({
        type: "file.read",
        projectId,
        path: file.path,
      });
      return result.file;
    } catch (failure) {
      setError(errorMessage(failure));
      return undefined;
    }
  };
  const openAgentFile = (filePath: string) => {
    const root = (project?.root ?? "").replaceAll("\\", "/");
    let relative = filePath.replaceAll("\\", "/").replace(/:\d+(?::\d+)?$/, "");
    if (relative.toLowerCase().startsWith(root.toLowerCase() + "/"))
      relative = relative.slice(root.length + 1);
    openFile({ path: relative, name: relative, size: 0, extension: "" });
  };
  function openSettings(category: SettingsCategory = "general") {
    setModelMenuOpen(false);
    settingsReturn.current = {
      top: scrollRef.current?.scrollTop ?? 0,
      stick: stickToBottom.current,
      focus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    };
    stickToBottom.current = false;
    setModal(null);
    setRenamingProject(null);
    setRemovingProject(null);
    setSettingsPage(category);
  }
  function closeSettings() {
    setSettingsPage(null);
    requestAnimationFrame(() => {
      if (scrollRef.current)
        scrollRef.current.scrollTop = settingsReturn.current.top;
      stickToBottom.current = settingsReturn.current.stick;
      settingsReturn.current.focus?.focus({ preventScroll: true });
    });
  }

  function updateSidebarWidth(nextWidth: number, persist = false) {
    const width = Math.min(sidebarMaximum(), Math.max(0, nextWidth));
    const open = width >= SIDEBAR_COLLAPSE_THRESHOLD;
    sidebarResize.current.open = open;
    if (open) {
      sidebarResize.current.width = width;
      if (!sidebarResize.current.active)
        sidebarResize.current.restoreWidth = width;
      setSidebarWidth(width);
      setSidebar(true);
      if (persist) writePreference("nexiom.sidebarWidth", String(Math.round(width)));
    } else {
      if (sidebarResize.current.active) {
        sidebarResize.current.width = sidebarResize.current.restoreWidth;
        setSidebarWidth(sidebarResize.current.restoreWidth);
      }
      setSidebar(false);
    }
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      window.innerWidth <= 850
    )
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResize.current = {
      active: true,
      pointerId: event.pointerId,
      open: sidebar,
      width: sidebarWidth,
      restoreWidth: sidebarWidth,
    };
    setResizingSidebar(true);
  }

  function moveSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      !sidebarResize.current.active ||
      sidebarResize.current.pointerId !== event.pointerId
    )
      return;
    updateSidebarWidth(event.clientX);
  }

  function finishSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      !sidebarResize.current.active ||
      sidebarResize.current.pointerId !== event.pointerId
    )
      return;
    sidebarResize.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setResizingSidebar(false);
    if (sidebarResize.current.open)
      writePreference(
        "nexiom.sidebarWidth",
        String(Math.round(sidebarResize.current.width)),
      );
  }

  function resizeSidebarWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (event.key === "ArrowLeft")
      next = sidebar ? sidebarWidth - 16 : 0;
    else if (event.key === "ArrowRight")
      next = sidebar ? sidebarWidth + 16 : SIDEBAR_DEFAULT_WIDTH;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = sidebarMaximum();
    else if (event.key === "Enter" || event.key === " ")
      next = sidebar ? 0 : sidebarWidth;
    if (next === null) return;
    event.preventDefault();
    updateSidebarWidth(next, true);
  }

  return (
    <MotionConfig reducedMotion={appearance.reduceMotion ? "always" : "user"}>
      {settingsPage && (
        <SettingsPage
          initialCategory={settingsPage}
          snapshot={snapshot}
          appearance={appearance}
          project={casualMode ? undefined : project}
          context={casualMode ? undefined : context}
          running={!!activeRun}
          onSaved={refresh}
          onBack={closeSettings}
        />
      )}
      <div
        style={
          {
            ...(settingsPage ? { display: "none" } : {}),
            "--sidebar-open-width": `${sidebarWidth}px`,
          } as CSSProperties
        }
        className={`app ${window.nexiom ? "desktop-app" : ""} ${sidebar ? "" : "sidebar-hidden"} ${resizingSidebar ? "sidebar-resizing" : ""} ${casualMode ? "casual-chat" : ""} ${showStructuredWorkspace ? "reading-mode" : ""} ${!timeline.length && showConversation && view === "conversation" && !showStructuredWorkspace ? "empty-thread" : ""}`}
      >
        <div className="window-chrome">
          <IconButton
            label={sidebar ? "收起侧栏" : "展开侧栏"}
            onClick={() => setSidebar((value) => !value)}
          >
            <PanelLeftOpen size={15} />
          </IconButton>
          <ChromeMenuBar hidden={!!settingsPage} menus={[
            { label: "文件", items: [
              { label: "添加", onSelect: addProject },
              { label: "设置", onSelect: () => openSettings() },
            ] },
            { label: "视图", items: [
              { label: "切换侧栏", onSelect: () => setSidebar((value) => !value) },
              { label: "外观", onSelect: () => openSettings("appearance") },
            ] },
          ]} />
        </div>
        {sidebar && (
          <button
            className="sidebar-scrim"
            aria-label="关闭侧栏"
            onClick={() => setSidebar(false)}
          />
        )}
        <ModelingSidebar
          projects={visibleProjects} project={project} threads={threads}
          casualThreads={casualThreads}
          questions={snapshot.questions} runs={snapshot.runs} account={snapshot.account}
          agentItems={snapshot.items}
          inside={insideProject && !!project && !casualMode} casualSelected={casualMode} dimension={dimension} threadId={threadId} busy={busy}
          onAddProject={addProject} onEnterProject={enterProject}
          onCasualChat={() => openCasualChat()}
          onAddCasualThread={() => openCasualChat(true)}
          onRenameProject={openProjectRename}
          onRemoveProject={(item) => { setError(""); setRemovingProject(item); }}
          onResetProject={(item) => { setError(""); setResettingProject(item); }}
          onBack={() => setInsideProject(false)}
          onDimension={(id) => { setError(""); selectWorkspace(id); setDimensionAttempt((value) => value + 1); }} onThread={selectThread}
          onRenameThread={(item) => { setError(""); setRenamingThreadId(item.id); setName(item.title); setModal("rename"); }}
          onUnreadThread={(item, unread) => updateThreadState({ type: "thread.unread", threadId: item.id, unread })}
          onArchiveThread={(item, archived) => updateThreadState({ type: "thread.archive", threadId: item.id, archived })}
          onDeleteThread={(item) => { setError(""); setDeletingThread(item); }}
          onMoveThread={moveThread} onCopyThread={copyThread} onForkThread={forkThread} onOpenThreadWindow={openThreadWindow}
          onAddThread={openThreadDialog} onSettings={() => openSettings("account")}
          onUpdate={applyDesktopUpdate}
        />

        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_COLLAPSE_THRESHOLD}
          aria-valuemax={Math.round(sidebarMaximum())}
          aria-valuenow={sidebar ? Math.round(sidebarWidth) : 0}
          aria-valuetext={sidebar ? `${Math.round(sidebarWidth)} 像素` : "已收起"}
          tabIndex={sidebar ? 0 : -1}
          title="拖动调整侧栏宽度；双击恢复默认宽度"
          onPointerDown={beginSidebarResize}
          onPointerMove={moveSidebarResize}
          onPointerUp={finishSidebarResize}
          onPointerCancel={finishSidebarResize}
          onDoubleClick={() => updateSidebarWidth(SIDEBAR_DEFAULT_WIDTH, true)}
          onKeyDown={resizeSidebarWithKeyboard}
        />

        <main className="main">
          <header className="topbar">
            {showReadingWorkspace && <div className="breadcrumbs"><BookOpen size={16} /><strong>赛题研读</strong></div>}
            {showAttachmentWorkspace && <div className="breadcrumbs"><Paperclip size={16} /><strong>附件分析</strong></div>}
            {showConversation && !casualMode && !showStructuredWorkspace && view === "conversation" && !!timeline.length && (
              <div className="breadcrumbs"><WorkspaceLogo dimension={dimension} className="workspace-logo-compact" /><strong>{dimensionName(dimension)}</strong></div>
            )}
            {insideProject && dimension === "chart" && showConversation && <button type="button" className="visual-library-back" onClick={() => selectWorkspace("chart")}><VisualizationIcon size={15} />可视化工作台</button>}
          </header>
          {insideProject && view === "activity" && (
            <div className="viewbar">
              <div className="tabs">
                <button className="" onClick={() => setView("conversation")}>
                  <MessageSquare size={14} />
                  会话
                </button>
                <button
                  className={view === "activity" ? "active" : ""}
                  onClick={() => setView("activity")}
                >
                  <Terminal size={14} />
                  执行记录
                  {events.length > 0 && (
                    <span className="count">{events.length}</span>
                  )}
                </button>
              </div>
              <span className="mode-label">{activeRun ? "正在工作" : ""}</span>
            </div>
          )}
          {cleanupNotice && <div className="cleanup-notice" role="status"><CircleCheck size={16} /><span>{cleanupNotice}</span><IconButton label="关闭重置提示" onClick={() => setCleanupNotice("")}><X size={15} /></IconButton></div>}
          {(error || refreshFailure) && (
            <div className="error-banner" role="alert">
              <Info size={16} />
              <span>{error || (refreshFailure?.retrying
                ? `状态更新暂时中断，正在重试。${errorMessage(refreshFailure.error)}`
                : errorMessage(refreshFailure?.error))}</span>
              <IconButton label="关闭错误提示" onClick={() => error ? setError("") : setRefreshFailure(null)}>
                <X size={15} />
              </IconButton>
            </div>
          )}
          {!loading && insideProject && !!project && needsModelSetup && !showVisualLibrary && !showProjectOverview && !showStructuredWorkspace && (
            <div className="model-setup-banner" role="status">
              <KeyRound size={17} />
              <div>
                <strong>配置 NEXIOM 的模型连接</strong>
                <span>填写 API 地址、密钥和模型，即可开始对话。配置与会话由 NEXIOM 独立保存。</span>
              </div>
              <button className="secondary-button" onClick={() => openSettings("model")}>
                配置模型
              </button>
            </div>
          )}
          <section
            ref={scrollRef}
            className={`conversation-scroll ${showStructuredWorkspace ? "reading-scroll" : ""}`}
            aria-label={showProjectOverview ? "项目总览" : showVisualLibrary ? "可视化工作台" : showReadingWorkspace ? "赛题研读工作台" : showAttachmentWorkspace ? "附件分析工作台" : view === "conversation" ? "会话内容" : "执行记录"}
            onWheel={(event) => {
              if (event.deltaY < 0) {
                stickToBottom.current = false;
                setShowScrollDown(true);
              }
            }}
            onTouchMove={() => {
              stickToBottom.current = false;
            }}
            onScroll={() => {
              const node = scrollRef.current;
              if (!node) return;
              const near =
                node.scrollHeight - node.scrollTop - node.clientHeight < 90;
              if (near) stickToBottom.current = true;
              else if (node.scrollTop < lastScrollTop.current - 2)
                stickToBottom.current = false;
              lastScrollTop.current = node.scrollTop;
              setShowScrollDown(!near);
            }}
          >
            {insideProject && project && !casualMode && <div className="vws-host" hidden={!showVisualLibrary || loading || openingDimension}>
              <VisualDesignWorkspace
                key={project.id}
                projectId={project.id}
                onFilesChanged={loadFiles}
              />
            </div>}
            {loading || openingDimension ? (
              <div className="empty-state">
                <LoaderCircle className="spin" size={24} />
                <p>{openingDimension ? "正在打开对话" : "正在打开 NEXIOM 工作区"}</p>
              </div>
            ) : !insideProject || !project ? (
              <section className={`workspace-welcome ${visibleProjects.length ? "has-recent" : ""}`} aria-labelledby="workspace-welcome-title">
                <div className="workspace-welcome-hero">
                  <svg className="workspace-welcome-logo" viewBox="0 0 123 123" aria-hidden="true">
                    <g fill="currentColor" transform="translate(61.5 61.5) scale(1.1) translate(-56 -57)">
                      <path d="M31 17V72L46 87V76L39 69V36L66 63V52Z" />
                      <path d="M66 27V38L73 45V78L46 51V62L81 97V42Z" />
                    </g>
                  </svg>
                  <h1 id="workspace-welcome-title">欢迎使用 NEXIOM</h1>
                  <div className="workspace-welcome-actions">
                    <button className="primary-button" onClick={addProject} disabled={busy}>
                      <FolderOpen size={17} />
                      添加
                    </button>
                  </div>
                </div>

                {!!visibleProjects.length && (
                  <section className="workspace-welcome-recent" aria-labelledby="recent-workspaces-title">
                    <div className="workspace-welcome-section-heading">
                      <h2 id="recent-workspaces-title">继续最近的赛题</h2>
                    </div>
                    <div className="workspace-welcome-projects">
                      {[...visibleProjects]
                        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                        .slice(0, 3)
                        .map((item) => (
                          <button key={item.id} onClick={() => enterProject(item.id)}>
                            <span className="workspace-project-icon"><FolderOpen size={17} /></span>
                            <span><strong>{projectDisplayName(item)}</strong></span>
                            <ArrowRight size={15} />
                          </button>
                        ))}
                    </div>
                  </section>
                )}
              </section>
            ) : showProjectOverview ? (
              <div className="empty-state project-overview-empty">
                <WorkspaceLogo dimension="overview" />
                <h2>项目总览</h2>
                <p>总览、调度与成果查看界面待后续设计。</p>
              </div>
            ) : showVisualLibrary ? null : !showConversation && view !== "activity" ? (
              <div className="empty-state">
                {casualMode ? <>
                  <div className="empty-mark"><NexiomMark /></div>
                  <h2>聊点什么？</h2>
                  <p>新建一个对话，开始聊聊吧。</p>
                  <button className="primary-button" type="button" disabled={busy} onClick={() => openCasualChat(true)}><Plus size={16} />新建对话</button>
                </> : <>
                  <WorkspaceLogo dimension={dimension} />
                  <h2>{dimensionName(dimension)}</h2>
                  <p>从左侧选择已有对话，或为这个工作维度添加一个对话。</p>
                  {isThreadStage(dimension) && (
                    <button className="primary-button" type="button" disabled={busy} onClick={() => openThreadDialog(dimension)}>
                      <Plus size={16} />添加对话
                    </button>
                  )}
                </>}
              </div>
            ) : showReadingWorkspace && project && thread ? (
              <ReadingWorkspace
                key={thread.id}
                projectName={projectDisplayName(project)}
                messages={messages}
                agentItems={agentItems}
                files={files}
                activeRun={activeRun?.threadId === threadId ? activeRun : undefined}
                latestRun={latestThreadRun}
                runs={threadRuns}
                busy={busy || !!activeRun}
                modelReady={!needsModelSetup && snapshot.runtime.connected}
                onStart={startReading}
                researchEnabled={snapshot.settings.network}
                onConfigureResearch={() => openSettings("general")}
                onCorrect={correctReading}
                onImport={importFiles}
                onRemove={removeReadingFile}
                onReadFile={readWorkspaceFile}
                onConfigureModel={() => openSettings("model")}
                onCancel={cancelActiveRun}
              />
            ) : showAttachmentWorkspace && project && thread ? (
              <AttachmentWorkspace
                key={thread.id}
                projectName={projectDisplayName(project)}
                messages={messages}
                agentItems={agentItems}
                files={files}
                runs={snapshot.runs.filter(run => run.threadId === threadId)}
                activeRun={activeRun?.threadId === threadId ? activeRun : undefined}
                latestRun={latestThreadRun}
                busy={busy}
                modelReady={!needsModelSetup && snapshot.runtime.connected}
                onCorrect={correctAttachmentAnalysis}
                onRetry={retryAttachmentAnalysis}
                onImport={() => picker.current?.click()}
                onOpenFile={openFile}
                onConfigureModel={() => openSettings("model")}
                onCancel={cancelActiveRun}
              />
            ) : view === "activity" ? (
              <div className="activity-view">
                <div className="section-heading">
                  <h2>项目执行记录</h2>
                  <span>{events.length} 条记录</span>
                </div>
                {events.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </div>
            ) : (
              <div className="conversation">
                {!timeline.length && <div className="thread-empty">{casualMode ? <div className="empty-mark"><NexiomMark /></div> : <WorkspaceLogo dimension={dimension} />}<h1>{casualMode ? "聊点什么？" : currentQuestion?.name ?? thread?.title}</h1></div>}
                {timeline.map((item) =>
                  item.type === "agent" ? (
                    <AgentOutput
                      key={item.value.id}
                      record={item.value}
                      openFile={openAgentFile}
                      showProgress={!casualMode}
                      activity={item.type === "agent" ? answerHeader(item.value) : undefined}
                    />
                  ) : item.type === "event" ? (
                    <EventRow key={item.value.id} event={item.value} />
                  ) : (
                    <article
                      key={item.value.id}
                      className={`message ${item.value.role} ${item.value.kind}`}
                    >
                      <div className="message-heading">
                        {item.value.role === "assistant" ? (
                          <>
                            <img src={logo} alt="" />
                            <strong>NEXIOM</strong>
                            {item.value.kind === "progress" && (
                              <span className="muted">执行进展</span>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="user-avatar">我</span>
                            <strong>你</strong>
                          </>
                        )}
                        <time>{time(item.value.createdAt)}</time>
                      </div>
                      <div className="message-body">
                        {item.value.role === "assistant" ? (
                          <RichText text={item.value.text} openFile={openAgentFile} />
                        ) : (
                          item.value.text
                        )}
                      </div>
                    </article>
                  ),
                )}
                {waitingRun && (
                  <AgentActivity
                    run={waitingRun}
                    items={agentItems}
                    paused={appearance.reduceMotion}
                    casual={casualMode}
                    settled={waitingRun.status !== "running"}
                  />
                )}
                <div ref={endRef} />
              </div>
            )}
          </section>
          {showConversation && view === "conversation" && !showStructuredWorkspace && (
            <div className="composer-region">
              {showScrollDown && (
                <button
                  className="scroll-bottom"
                  aria-label="回到最新消息"
                  title="回到最新消息"
                  onClick={() => {
                    stickToBottom.current = true;
                    endRef.current?.scrollIntoView({
                      behavior: appearance.reduceMotion ? "instant" : "smooth",
                      block: "end",
                    });
                  }}
                >
                  <ArrowDown size={17} />
                </button>
              )}
              <form className="composer" onSubmit={send}>
                <textarea
                  aria-label="任务输入"
                  placeholder="向 NEXIOM 发送任务…"
                  value={draft}
                  disabled={!thread}
                  onChange={(event) => {
                    event.target.style.height = "auto";
                    event.target.style.height = `${Math.min(220, event.target.scrollHeight)}px`;
                    setDrafts((previous) => ({
                      ...previous,
                      [threadId]: event.target.value,
                    }));
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      send(event);
                    }
                  }}
                  maxLength={20000}
                />
                <div className="composer-toolbar">
                  <div className="composer-tools">
                    <IconButton
                      label="导入附件"
                      disabled={busy}
                      onClick={() => picker.current?.click()}
                    >
                      <Plus size={19} />
                    </IconButton>
                  </div>
                  <div className="composer-right">
                    <div className="model-selector-wrap" ref={modelMenuRef}>
                      <button
                        type="button"
                        className="model-selector"
                        aria-haspopup="listbox"
                        aria-expanded={modelMenuOpen}
                        onClick={() => setModelMenuOpen((open) => !open)}
                        title="选择模型"
                      >
                        {activeModelLabel}
                        <ChevronDown size={12} />
                      </button>
                      {modelMenuOpen && (
                        <div className="model-selector-menu" role="listbox" aria-label="选择模型">
                          {configuredProviders.map((item) => {
                            const selected = item.id === snapshot.settings.activeProviderId;
                            return (
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                key={item.id}
                                disabled={busy || !!activeRun}
                                title={`模型 ID：${item.model}`}
                                onClick={() => activateComposerModel(item.id)}
                              >
                                <span>{item.modelName || item.model}</span>
                                {selected && <Check size={14} />}
                              </button>
                            );
                          })}
                          {!configuredProviders.length && (
                            <span className="model-selector-empty">尚未配置模型</span>
                          )}
                          <button
                            type="button"
                            className="model-selector-settings"
                            onClick={() => openSettings("model")}
                          >
                            <Settings2 size={14} />管理模型
                          </button>
                        </div>
                      )}
                    </div>
                    {activeRun ? (
                      <IconButton
                        label="停止任务"
                        onClick={cancelActiveRun}
                      >
                        <Square size={16} />
                      </IconButton>
                    ) : (
                      <button
                        className="send-button"
                        type="submit"
                        title="发送任务"
                        aria-label="发送任务"
                        disabled={!draft.trim() || busy || !thread}
                      >
                        {busy ? (
                          <LoaderCircle size={17} className="spin" />
                        ) : (
                          <ArrowUp size={18} />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </form>
              <div className="composer-footer">
                <span>
                  <span className="local-dot" />
                  {snapshot.runtime.label}
                </span>
                <button
                  className="context-shortcut"
                  onClick={() => setModal("context")}
                  title="会话上下文"
                >
                  <BrainCircuit size={12} />
                  {context?.lastInputTokens != null
                    ? `${context.lastInputTokens.toLocaleString("zh-CN")} tokens`
                    : "上下文"}
                </button>
              </div>
            </div>
          )}
        </main>

        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => void importFiles(event.target.files)}
        />

        {renamingProject && (
          <Modal title="重命名项目" onClose={() => { if (!busy) setRenamingProject(null); }}>
            <form className="modal-form" onSubmit={renameProject}>
              <label>
                项目名称
                <input
                  autoFocus
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={busy}
                />
              </label>
              <p className="muted">只修改 NEXIOM 中显示的名称，工作文件夹不会移动或改名。</p>
              {error && <p className="form-error" role="alert">{error}</p>}
              <footer>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setRenamingProject(null)}>取消</button>
                <button className="primary-button" disabled={busy || !projectName.trim()}>
                  {busy && <LoaderCircle size={15} className="spin" />}保存
                </button>
              </footer>
            </form>
          </Modal>
        )}
        {resettingProject && (
          <Modal title="重置项目" className="project-reset-modal" onClose={() => { if (!busy) setResettingProject(null); }}>
            <ProjectResetPanel project={resettingProject} busy={busy} running={snapshot.runs.some(run => run.projectId === resettingProject.id && run.status === "running")} onClose={() => { if (!busy) setResettingProject(null); }} onReset={resetProject} />
          </Modal>
        )}
        {removingProject && (
          <Modal title="从 NEXIOM 中移除项目" onClose={() => { if (!busy) setRemovingProject(null); }}>
            <div className="project-remove-confirmation">
              <p>确定移除“{removingProject.name}”吗？该项目会从当前 NEXIOM 项目列表中移除。</p>
              {error.startsWith(projectRecordSaveFailure) ? (
                <p className="project-remove-safety">最新项目记录无法写入工作文件夹。若仍要移除，项目、对话和运行记录将从当前 NEXIOM 中删除，且可能无法通过重新选择文件夹恢复；工作文件夹中的现有文件不会删除。</p>
              ) : (
                <p className="project-remove-safety">工作文件夹及其中的附件、代码、图表、论文和 .nexiom/project.json 都会保留；重新选择该文件夹即可恢复项目、对话和运行记录。</p>
              )}
              <code>{removingProject.root}</code>
              {error && <p className="form-error" role="alert">{error}</p>}
              <footer>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setRemovingProject(null)}>取消</button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={busy}
                  onClick={() => removeProject(error.startsWith(projectRecordSaveFailure))}
                >
                  {busy && <LoaderCircle size={15} className="spin" />}
                  {error.startsWith(projectRecordSaveFailure) ? "仍要移除" : "移除项目"}
                </button>
              </footer>
            </div>
          </Modal>
        )}
        {deletingThread && (
          <Modal title="永久删除对话" onClose={() => { if (!busy) setDeletingThread(null); }}>
            <div className="project-remove-confirmation">
              <p>确定永久删除“{deletingThread.title}”吗？该对话的消息、运行记录和上下文都会被删除。</p>
              <p className="project-remove-safety">此操作无法撤销，项目工作文件夹中的文件不会被删除。</p>
              {error && <p className="form-error" role="alert">{error}</p>}
              <footer>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setDeletingThread(null)}>取消</button>
                <button type="button" className="danger-button" disabled={busy} onClick={deleteThread}>
                  {busy && <LoaderCircle size={15} className="spin" />}永久删除
                </button>
              </footer>
            </div>
          </Modal>
        )}
        {(modal === "project" || modal === "rename") && (
          <Modal
            title={modal === "project" ? "创建项目" : "重命名对话"}
            className={modal === "project" ? "project-create-modal" : ""}
            onClose={() => { if (!busy) { setModal(null); setRenamingThreadId(null); setProjectFolder(""); } }}
          >
            <form className={`modal-form ${modal === "project" ? "project-create-form" : ""}`} onSubmit={createProject}>
              {modal === "project" ? <>
                <label className="project-create-name">
                  <FolderOpen size={20} />
                  <input
                    autoFocus
                    aria-label="项目名称"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="项目名称"
                    maxLength={80}
                    required
                    disabled={busy}
                  />
                </label>
                <h3>源文件夹</h3>
                <button
                  type="button"
                  className={`project-source-picker ${projectFolder ? "selected" : ""}`}
                  onClick={chooseProjectFolder}
                  disabled={busy}
                  title={projectFolder || "选择源文件夹"}
                >
                  <FolderPlus size={18} />
                  <strong>{projectFolder ? folderName(projectFolder) : "选择源文件夹"}</strong>
                  <span>{projectFolder ? "更改" : "浏览"}</span>
                </button>
              </> : <label>
                对话名称
                <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required disabled={busy} />
              </label>}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => { setModal(null); setRenamingThreadId(null); setProjectFolder(""); }}
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  disabled={!name.trim() || busy || (modal === "project" && !projectFolder)}
                >
                  {busy && <LoaderCircle size={15} className="spin" />}
                  {modal === "project" ? "创建项目" : "保存"}
                </button>
              </footer>
            </form>
          </Modal>
        )}
        {newThread && (
          <Modal title={`${dimensionName(newThread.stageId)} · 添加对话`} onClose={() => { if (!busy) setNewThread(null); }}>
            <form className="modal-form" onSubmit={createThread}>
              <label>问题<input autoFocus list="modeling-question-options" value={questionName} onChange={(event) => setQuestionName(event.target.value)} required maxLength={80} disabled={busy} /></label>
              <datalist id="modeling-question-options">{snapshot.questions.filter((item) => item.projectId === newThread.projectId).map((item) => <option key={item.id} value={item.name} />)}</datalist>
              <label>对话名称<input value={threadName} onChange={(event) => setThreadName(event.target.value)} placeholder={questionName.trim()} maxLength={80} disabled={busy} /></label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <footer><button type="button" className="secondary-button" disabled={busy} onClick={() => setNewThread(null)}>取消</button><button className="primary-button" disabled={busy || !questionName.trim()}>{busy && <LoaderCircle size={15} className="spin" />}添加对话</button></footer>
            </form>
          </Modal>
        )}
        {modal === "context" && (
          <Modal title="上下文与记忆" onClose={() => setModal(null)}>
            <ContextDetails context={context} />
            <div className="context-actions">
              <button
                className="secondary-button"
                disabled={!project}
                onClick={() => openSettings("memory")}
              >
                <BookOpen size={15} />
                项目记忆
              </button>
            </div>
          </Modal>
        )}
        {preview && (
          <Modal
            title={preview.path.split("/").at(-1) ?? "文件预览"}
            wide
            onClose={() => setPreview(null)}
          >
            <div className="preview-meta">
              <span>{preview.path}</span>
              <span>{bytes(preview.size)}</span>
            </div>
            {preview.text !== null ? (
              <pre className="file-preview">{preview.text}</pre>
            ) : preview.mime === "application/pdf" && preview.base64 ? (
              <PdfViewer
                className="file-pdf-preview"
                base64={preview.base64}
                title={preview.path.split("/").at(-1) ?? preview.path}
              />
            ) : preview.base64 ? (
              <div className="image-preview">
                <img
                  alt={preview.path}
                  src={`data:${preview.mime};base64,${preview.base64}`}
                />
              </div>
            ) : (
              <div className="preview-unavailable">
                <File size={30} />
                <p>
                  {preview.mime === "large"
                    ? "文件超过 2 MB 预览上限"
                    : "此格式暂不支持预览"}
                </p>
                <span>{preview.path}</span>
              </div>
            )}
          </Modal>
        )}
      </div>
    </MotionConfig>
  );
}
