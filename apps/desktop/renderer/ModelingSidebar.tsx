import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, ClipboardCheck, Copy, Download, Eye, EyeOff, FileText, FolderInput, FolderOpen, GitFork, LayoutDashboard, LoaderCircle, MessageSquare, MoreHorizontal, PanelTopOpen, Paperclip, Pencil, Plus, RotateCcw, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import type { AccountProfile, AgentItem, ConversationStage, Project, Question, Run, Thread } from "../../../packages/contracts";
import { readPreference, writePreference } from "./preferences";
import { PaperWritingIcon } from "./PaperWritingIcon";
import { VisualizationIcon } from "./VisualizationIcon";
import { AgentTaskIcon } from "./AgentTaskStatus";
import { AGENT_TASK_STATES, getCurrentAgentTaskKind } from "./agent-task-state";
import { NexiomMark } from "./NexiomMark";
import "./modeling-navigation.css";

export const dimensions = [
  { id: "overview", label: "项目总览", icon: LayoutDashboard },
  { id: "reading", label: "赛题研读", icon: BookOpen },
  { id: "attachments", label: "附件分析", icon: Paperclip },
  { id: "model", label: "开始建模", icon: ModelingIcon },
  { id: "validation", label: "模型检验", icon: ShieldCheck },
  { id: "chart", label: "图表设计", icon: VisualizationIcon },
  { id: "paper", label: "论文写作", icon: PaperWritingIcon },
  { id: "delivery", label: "检查交付", icon: ClipboardCheck },
] as const;
export type Dimension = typeof dimensions[number]["id"];
export const isThreadStage = (id: string): id is ConversationStage => ["model", "validation", "chart", "paper"].includes(id);
export const dimensionName = (id: Dimension) => dimensions.find((item) => item.id === id)!.label;
export function projectDisplayName(project: Pick<Project, "name" | "root">): string {
  const saved = project.name.trim();
  if (saved) return saved;
  const normalized = project.root.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || normalized || project.root || "未命名项目";
}
export function readProjectSelection(projectId: string): { dimension: Dimension; threadId: string } {
  try {
    const value = JSON.parse(readPreference(`nexiom.selection.${projectId}`) ?? "{}");
    return { dimension: dimensions.some((item) => item.id === value.dimension) ? value.dimension : "overview", threadId: typeof value.threadId === "string" ? value.threadId : "" };
  } catch { return { dimension: "overview", threadId: "" }; }
}

function ModelingIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="-128 -128 1280 1280" className="modeling-hierarchy-icon" aria-hidden="true"><path d="M896 682.666667V469.333333h-341.333333V341.333333H768V0H256v341.333333h213.333333v128h-341.333333V682.666667H0v341.333333h341.333333V682.666667H213.333333V554.666667h597.333334V682.666667H682.666667v341.333333h341.333333V682.666667h-128zM256 768v170.666667H85.333333V768h170.666667z m85.333333-512V85.333333h341.333334v170.666667H341.333333z m597.333334 682.666667H768V768h170.666667v170.666667z" /></svg>;
}

function SidebarAgentActivity({ run, items }: { run?: Run; items: AgentItem[] }) {
  if (!run) return null;
  const kind = getCurrentAgentTaskKind(items, run.id, "thinking");
  return <span className="nexiom-task-sidebar-activity" role="img" aria-label={AGENT_TASK_STATES[kind].label} title={AGENT_TASK_STATES[kind].label}><AgentTaskIcon kind={kind} size={12} /></span>;
}

export function ModelingSidebar({ projects, project, threads, casualThreads = [], questions, runs, agentItems = [], account, inside, casualSelected, dimension, threadId, busy, onAddProject, onCasualChat, onAddCasualThread, onEnterProject, onRenameProject, onRemoveProject, onResetProject, onArchiveProject, onQuestion, onBack, onDimension, onThread, onRenameThread, onUnreadThread, onArchiveThread, onDeleteThread, onMoveThread, onCopyThread, onForkThread, onOpenThreadWindow, onAddThread, onSettings, onUpdate }: {
  projects: Project[]; project?: Project; threads: Thread[]; questions: Question[]; runs: Run[]; agentItems?: AgentItem[]; account: AccountProfile;
  casualThreads?: Thread[];
  inside: boolean; casualSelected: boolean; dimension: Dimension; threadId: string; busy: boolean;
  onAddProject: () => void; onCasualChat: () => void; onEnterProject: (id: string) => void; onBack: () => void;
  onAddCasualThread: () => void;
  onRenameProject: (project: Project) => void; onRemoveProject: (project: Project) => void; onResetProject: (project: Project) => void;
  onQuestion: (stage: "model" | "validation", questionId: string) => void;
  onArchiveProject: (project: Project, archived: boolean) => void;
  onDimension: (id: Dimension) => void; onThread: (thread: Thread) => void; onRenameThread: (thread: Thread) => void;
  onUnreadThread: (thread: Thread, unread: boolean) => void;
  onArchiveThread: (thread: Thread, archived: boolean) => void; onDeleteThread: (thread: Thread) => void;
  onMoveThread: (thread: Thread, projectId: string) => void; onCopyThread: (thread: Thread, kind: "title" | "content") => void;
  onForkThread: (thread: Thread, projectId: string) => void; onOpenThreadWindow: (thread: Thread) => void;
  onAddThread: (stage: ConversationStage) => void; onSettings: () => void;
  onUpdate: () => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try { const stored = JSON.parse(readPreference("nexiom.expandedStages") ?? "{}"); return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}; } catch { return {}; }
  });
  const [accountOpen, setAccountOpen] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState(false);
  const avatarTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const avatarHeld = useRef(false);
  const clearAvatarTimer = () => { if (avatarTimer.current) clearTimeout(avatarTimer.current); avatarTimer.current = null; };
  useEffect(() => () => clearAvatarTimer(), []);
  useEffect(() => { if (!avatarPreview) return; const close = (e: KeyboardEvent) => { if (e.key === "Escape") setAvatarPreview(false); }; document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close); }, [avatarPreview]);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(() => readPreference("nexiom.projectsExpanded") !== "false");
  const [casualExpanded, setCasualExpanded] = useState(() => readPreference("nexiom.casualExpanded") !== "false");
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{ project: Project; triggerId: string; top: number; left: number } | null>(null);
  const [threadMenu, setThreadMenu] = useState<{ thread: Thread; top: number; left: number } | null>(null);
  const [threadSubmenu, setThreadSubmenu] = useState<"project" | "copy" | "fork" | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState<Record<string, boolean>>({});
  const [casualArchivedExpanded, setCasualArchivedExpanded] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const accountMenu = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const projectHeader = useRef<HTMLDivElement>(null);
  const projectMenuElement = useRef<HTMLDivElement>(null);
  const projectMenuButton = useRef<HTMLButtonElement>(null);
  const projectMenuAnchor = useRef<HTMLButtonElement>(null);
  const threadMenuElement = useRef<HTMLDivElement>(null);
  const threadMenuButton = useRef<HTMLButtonElement>(null);
  const threadMenuAnchor = useRef<HTMLButtonElement>(null);
  const previousLayer = useRef(inside);
  useEffect(() => { writePreference("nexiom.expandedStages", JSON.stringify(expanded)); }, [expanded]);
  useEffect(() => { writePreference("nexiom.projectsExpanded", String(projectsExpanded)); }, [projectsExpanded]);
  useEffect(() => { writePreference("nexiom.casualExpanded", String(casualExpanded)); }, [casualExpanded]);
  useEffect(() => { if (casualSelected && threadId) setCasualExpanded(true); }, [casualSelected, threadId]);
  useEffect(() => {
    if (!libraryMenuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!projectHeader.current?.contains(event.target as Node)) setLibraryMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLibraryMenuOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [libraryMenuOpen]);
  useEffect(() => {
    if (!project || !threadId || !isThreadStage(dimension)) return;
    const key = `${project.id}:${dimension}`;
    setExpanded((value) => value[key] ? value : { ...value, [key]: true });
  }, [project?.id, dimension, threadId]);
  useEffect(() => {
    if (previousLayer.current === inside) return;
    previousLayer.current = inside;
    requestAnimationFrame(() => {
      const target = inside ? sidebar.current?.querySelector<HTMLButtonElement>(".modeling-back") : casualSelected ? sidebar.current?.querySelector<HTMLButtonElement>(".modeling-casual-chat") : sidebar.current?.querySelector<HTMLButtonElement>(`[data-project-id="${project?.id}"]`) ?? sidebar.current?.querySelector<HTMLButtonElement>(".modeling-project-section-toggle");
      target?.focus({ preventScroll: true });
    });
  }, [inside, project?.id, casualSelected]);
  useEffect(() => {
    if (!accountOpen) return;
    settingsButton.current?.focus();
    const outside = (event: PointerEvent) => { if (!accountMenu.current?.contains(event.target as Node)) setAccountOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setAccountOpen(false); accountButton.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [accountOpen]);
  useEffect(() => {
    if (!projectMenu) return;
    projectMenuButton.current?.focus();
    const close = (restoreFocus = false) => {
      const anchor = projectMenuAnchor.current;
      setProjectMenu(null);
      if (restoreFocus) requestAnimationFrame(() => anchor?.focus());
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!projectMenuElement.current?.contains(target) && !projectMenuAnchor.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const viewportChanged = () => close();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", viewportChanged);
    window.addEventListener("scroll", viewportChanged, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", viewportChanged);
      window.removeEventListener("scroll", viewportChanged, true);
    };
  }, [projectMenu?.triggerId]);
  useEffect(() => {
    if (!threadMenu) return;
    threadMenuButton.current?.focus();
    const close = (restoreFocus = false) => {
      const anchor = threadMenuAnchor.current;
      setThreadMenu(null);
      setThreadSubmenu(null);
      if (restoreFocus) anchor?.focus({ preventScroll: true });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!threadMenuElement.current?.contains(target) && !threadMenuAnchor.current?.contains(target)) close();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      } else if (event.key === "Tab") {
        close(true);
      } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        threadMenuButton.current?.focus();
      }
    };
    const viewportChanged = () => close(!!threadMenuElement.current?.contains(document.activeElement));
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    window.addEventListener("resize", viewportChanged);
    window.addEventListener("scroll", viewportChanged, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
      window.removeEventListener("resize", viewportChanged);
      window.removeEventListener("scroll", viewportChanged, true);
    };
  }, [threadMenu?.thread.id]);
  useEffect(() => { setThreadMenu(null); setThreadSubmenu(null); }, [inside, project?.id, dimension]);
  useEffect(() => {
    const selected = threads.find((item) => item.id === threadId);
    if (!selected) return;
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.ctrlKey && event.altKey && event.code === "KeyR") { event.preventDefault(); onRenameThread(selected); }
      else if (event.ctrlKey && event.shiftKey && event.code === "KeyU") { event.preventDefault(); onUnreadThread(selected, !selected.unread); }
      else if (event.ctrlKey && event.shiftKey && event.code === "KeyA") { event.preventDefault(); onArchiveThread(selected, !selected.archivedAt); }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [threadId, threads, onRenameThread, onUnreadThread, onArchiveThread]);
  const openProjectMenu = (item: Project, triggerId: string, anchor: HTMLButtonElement) => {
    if (projectMenu?.triggerId === triggerId) {
      setProjectMenu(null);
      return;
    }
    const bounds = anchor.getBoundingClientRect();
    const menuWidth = 214;
    const menuHeight = 128;
    const margin = 8;
    const left = Math.max(margin, Math.min(bounds.right - menuWidth, window.innerWidth - menuWidth - margin));
    const below = bounds.bottom + 5;
    const top = below + menuHeight <= window.innerHeight - margin ? below : Math.max(margin, bounds.top - menuHeight - 5);
    projectMenuAnchor.current = anchor;
    setAccountOpen(false);
    setThreadMenu(null);
    setProjectMenu({ project: item, triggerId, top, left });
  };
  const openThreadMenu = (item: Thread, anchor: HTMLButtonElement, toggleOpen = true, point?: { x: number; y: number }) => {
    if (toggleOpen && threadMenu?.thread.id === item.id) {
      setThreadMenu(null);
      anchor.focus({ preventScroll: true });
      return;
    }
    const bounds = anchor.getBoundingClientRect();
    const menuWidth = 270;
    const menuHeight = 304;
    const margin = 8;
    const left = Math.max(margin, Math.min(point?.x ?? bounds.right + 5, window.innerWidth - menuWidth - margin));
    const candidateTop = point?.y ?? bounds.top;
    const top = Math.max(margin, Math.min(candidateTop, window.innerHeight - menuHeight - margin));
    threadMenuAnchor.current = anchor;
    setAccountOpen(false);
    setProjectMenu(null);
    setThreadSubmenu(null);
    setThreadMenu({ thread: item, top, left });
  };
  const toggle = (stage: ConversationStage) => setExpanded((value) => ({ ...value, [`${project?.id}:${stage}`]: !value[`${project?.id}:${stage}`] }));
  const activeCasualThreads = casualThreads.filter((item) => !item.archivedAt).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const archivedCasualThreads = casualThreads.filter((item) => item.archivedAt).sort((left, right) => right.archivedAt!.localeCompare(left.archivedAt!));
  const renderCasualThread = (item: Thread) => <div className={`modeling-thread-row ${item.archivedAt ? "archived" : ""}`} key={item.id} onContextMenu={(event) => {
    event.preventDefault();
    const anchor = event.currentTarget.querySelector<HTMLButtonElement>(".modeling-thread-more");
    if (anchor) openThreadMenu(item, anchor, false, { x: event.clientX, y: event.clientY });
  }}>
    <button className={`modeling-thread ${casualSelected && threadId === item.id ? "active" : ""} ${item.unread ? "unread" : ""}`} aria-current={casualSelected && threadId === item.id ? "page" : undefined} title={item.title} disabled={busy} onClick={() => onThread(item)} onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); onRenameThread(item); } }}>
      <span>{item.title}</span>
      {item.unread && <span className="modeling-unread" aria-label="未读" />}
      <SidebarAgentActivity run={runs.find((run) => run.threadId === item.id && run.status === "running")} items={agentItems} />
    </button>
    <button className="modeling-thread-more" aria-label={`${item.title}的对话菜单`} aria-haspopup="menu" aria-expanded={threadMenu?.thread.id === item.id} aria-controls={threadMenu?.thread.id === item.id ? "modeling-thread-menu" : undefined} title="对话菜单" disabled={busy} onClick={(event) => openThreadMenu(item, event.currentTarget)} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openThreadMenu(item, event.currentTarget, false); }
      if (event.key === "F2") { event.preventDefault(); onRenameThread(item); }
    }}><MoreHorizontal size={15} /></button>
  </div>;
  const updateBlocked = busy || runs.some((run) => run.status === "running");
  const applyUpdate = async () => {
    if (updating || updateBlocked) return;
    setAccountOpen(false);
    setUpdateError("");
    setUpdating(true);
    try {
      await onUpdate();
    } catch (error) {
      setUpdating(false);
      setUpdateError(error instanceof Error ? error.message : "更新失败，请稍后重试。");
    }
  };
  return <aside ref={sidebar} className={`sidebar modeling-sidebar ${inside ? "modeling-inside" : ""}`} aria-label="赛题项目导航">
    <div className="brand"><NexiomMark /><span>NEXIOM</span></div>
    <div className="modeling-layers">
      <section className="modeling-layer modeling-library" inert={inside} aria-hidden={inside} aria-label="赛题项目列表">
        <div className="modeling-casual-heading">
          <button className="modeling-casual-chat" aria-expanded={casualExpanded} aria-controls="casual-conversations" onClick={() => {
            if (!casualThreads.length) { setCasualExpanded(true); onCasualChat(); return; }
            setCasualExpanded((value) => !value);
            if (!casualExpanded) onCasualChat();
          }} disabled={busy}><MessageSquare size={18} /><span>随便聊聊</span><ChevronDown size={14} /></button>
          <button className="modeling-casual-add" aria-label="新建随便聊聊对话" title="新建对话" onClick={() => { setCasualExpanded(true); onAddCasualThread(); }} disabled={busy}><Plus size={17} /></button>
        </div>
        <div id="casual-conversations" className={`modeling-list-reveal ${casualExpanded ? "open" : ""}`} aria-hidden={!casualExpanded} inert={!casualExpanded}>
          <div className="modeling-list-reveal-inner">
            <nav className="modeling-casual-threads" aria-label="随便聊聊对话列表">
              {activeCasualThreads.map(renderCasualThread)}
              {!!archivedCasualThreads.length && <div className="modeling-archived">
                <button className="modeling-archived-toggle" aria-expanded={casualArchivedExpanded} onClick={() => setCasualArchivedExpanded((value) => !value)}><ChevronRight size={13} /><Archive size={13} /><span>已归档</span><small>{archivedCasualThreads.length}</small></button>
                {casualArchivedExpanded && archivedCasualThreads.map(renderCasualThread)}
              </div>}
            </nav>
          </div>
        </div>
        <div className="modeling-project-section" ref={projectHeader}>
          <button className="modeling-project-section-toggle" aria-expanded={projectsExpanded} aria-controls="sidebar-projects" onClick={() => setProjectsExpanded((value) => !value)}><span>项目</span><ChevronDown size={15} /></button>
          <div className="modeling-project-section-actions">
            <button aria-label="项目选项" aria-haspopup="menu" aria-expanded={libraryMenuOpen} onClick={() => setLibraryMenuOpen((value) => !value)}><MoreHorizontal size={17} /></button>
            <button aria-label="添加项目" title="添加项目" onClick={onAddProject} disabled={busy}><Plus size={18} /></button>
          </div>
          {libraryMenuOpen && <div className="modeling-library-menu" role="menu">
            <button role="menuitem" onClick={() => { setLibraryMenuOpen(false); onAddProject(); }}><Plus size={16} />添加项目</button>
            <button role="menuitem" onClick={() => { setLibraryMenuOpen(false); setProjectsExpanded((value) => !value); }}><ChevronDown size={16} />{projectsExpanded ? "收起项目" : "展开项目"}</button>
          </div>}
        </div>
        <div id="sidebar-projects" className={`modeling-list-reveal ${projectsExpanded ? "open" : ""}`} aria-hidden={!projectsExpanded} inert={!projectsExpanded}>
          <div className="modeling-list-reveal-inner">
            <nav className="modeling-project-list" aria-label="已添加的赛题项目">
              {projects.some(item => item.archived) && <button className="modeling-archived-toggle" onClick={() => setShowArchivedProjects(value => !value)}><Archive size={14}/>{showArchivedProjects ? "返回活跃项目" : "已归档项目"}</button>}
              {projects.filter(item => !!item.archived === showArchivedProjects).map((item) => {
                const triggerId = `library:${item.id}`;
                const name = projectDisplayName(item);
                return <div className="modeling-project-row" key={item.id}>
                  <button data-project-id={item.id} className="modeling-project" onClick={() => onEnterProject(item.id)} onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); onRenameProject(item); } }}><FolderOpen size={18} /><span>{name}</span><SidebarAgentActivity run={runs.find((run) => run.projectId === item.id && run.status === "running")} items={agentItems} /></button>
                  <button className="modeling-project-more" aria-label={`${name}的项目菜单`} aria-haspopup="menu" aria-expanded={projectMenu?.triggerId === triggerId} title="项目菜单" onClick={(event) => openProjectMenu(item, triggerId, event.currentTarget)}><MoreHorizontal size={16} /></button>
                </div>;
              })}
            </nav>
          </div>
        </div>
      </section>
      <section className="modeling-layer modeling-workspace" inert={!inside} aria-hidden={!inside} aria-label="项目内工作维度">
        <button className="modeling-back" onClick={onBack}><ArrowLeft size={17} />所有赛题</button>
        <div className="modeling-project-heading">
          <h2 className="modeling-project-name" title={project?.root}>{project ? projectDisplayName(project) : ""}</h2>
          {project && <button className="modeling-project-more" aria-label={`${projectDisplayName(project)}的项目菜单`} aria-haspopup="menu" aria-expanded={projectMenu?.triggerId === `workspace:${project.id}`} title="项目菜单" onClick={(event) => openProjectMenu(project, `workspace:${project.id}`, event.currentTarget)}><MoreHorizontal size={16} /></button>}
        </div>
        <nav className="modeling-dimensions" aria-label="数学建模工作维度">
          {dimensions.map(({ id, label, icon: Icon }) => {
            const grouped = isThreadStage(id);
            const open = !!expanded[`${project?.id}:${id}`];
            const selected = dimension === id && (!grouped || !threadId);
            const sortThreads = (left: Thread, right: Thread) => {
              return left.createdAt.localeCompare(right.createdAt);
            };
            const stageThreads = threads.filter((item) => item.stageId === id && !item.archivedAt).sort(sortThreads);
            const archivedThreads = threads.filter((item) => item.stageId === id && !!item.archivedAt).sort((left, right) => right.archivedAt!.localeCompare(left.archivedAt!));
            return <section className="modeling-group" key={id}>
              <div className={`modeling-dimension-row ${selected ? "selected" : ""}`}>
                <button className="modeling-dimension" aria-current={selected ? "page" : undefined} aria-expanded={grouped ? open : undefined} aria-controls={grouped ? `stage-threads-${id}` : undefined} onClick={() => { onDimension(id); if (grouped) toggle(id); }}><Icon size={18} /><span>{label}</span></button>
                {grouped && <div className="modeling-group-actions">{!["model", "validation"].includes(id) && <button aria-label={`在${label}中添加对话`} title="添加对话" disabled={busy} onClick={() => onAddThread(id)}><Plus size={15} /></button>}<button className="modeling-disclosure" aria-label={`${open ? "收起" : "展开"}${label}`} aria-expanded={open} aria-controls={`stage-threads-${id}`} onClick={() => toggle(id)}><ChevronRight size={14} /></button></div>}
              </div>
              {grouped && <div id={`stage-threads-${id}`} className={`modeling-threads ${open ? "open" : ""}`} aria-hidden={!open} inert={!open}>
                <div className="modeling-threads-inner">
                  {!stageThreads.length && !["model", "validation"].includes(id) && <button className="modeling-thread" onClick={() => onAddThread(id)} disabled={busy}><Plus size={14} /><span>添加对话</span></button>}
                  {["model", "validation"].includes(id) && questions.filter(q => q.projectId === project?.id).map(q => <div className="modeling-question-group" key={q.id}><button className="modeling-thread" onClick={() => { const latest = stageThreads.filter(t => t.questionId === q.id).at(-1); if (latest) onThread(latest); else onQuestion(id as "model" | "validation", q.id); }}><span>{q.name}</span></button>{["AI独立建模", "协同AI建模"].map(route => { const latest = stageThreads.filter(t => t.questionId === q.id && t.title.includes(route)).at(-1); return latest && <button key={route} className={`modeling-thread modeling-route ${threadId === latest.id ? "active" : ""}`} onClick={() => onThread(latest)}><span>{route}</span><SidebarAgentActivity run={runs.find(run => run.threadId === latest.id && run.status === "running")} items={agentItems}/></button>; })}</div>)}
                  {stageThreads.filter(item => !["model", "validation"].includes(id) || !item.questionId || !/ · (AI独立建模|协同AI建模) · /.test(item.title)).map((item) => <div className="modeling-thread-row" key={item.id} onContextMenu={(event) => {
                  event.preventDefault();
                  const anchor = event.currentTarget.querySelector<HTMLButtonElement>(".modeling-thread-more");
                  if (anchor) openThreadMenu(item, anchor, false, { x: event.clientX, y: event.clientY });
                }}>
                  <button className={`modeling-thread ${threadId === item.id ? "active" : ""} ${item.unread ? "unread" : ""}`} aria-current={threadId === item.id ? "page" : undefined} title={[questions.find((question) => question.id === item.questionId)?.name, item.title].filter(Boolean).join(" · ")} onClick={() => onThread(item)} onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); onRenameThread(item); } }}><MessageSquare size={14} /><span>{item.title}</span>{item.unread && <span className="modeling-unread" aria-label="未读" />}<SidebarAgentActivity run={runs.find((run) => run.threadId === item.id && run.status === "running")} items={agentItems} /></button>
                  <button className="modeling-thread-more" aria-label={`${item.title}的对话菜单`} aria-haspopup="menu" aria-expanded={threadMenu?.thread.id === item.id} aria-controls={threadMenu?.thread.id === item.id ? "modeling-thread-menu" : undefined} title="对话菜单" onClick={(event) => openThreadMenu(item, event.currentTarget)} onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openThreadMenu(item, event.currentTarget, false); }
                    if (event.key === "F2") { event.preventDefault(); onRenameThread(item); }
                  }}><MoreHorizontal size={15} /></button>
                </div>)}
                  {!!archivedThreads.length && <div className="modeling-archived">
                  <button className="modeling-archived-toggle" aria-expanded={!!archivedExpanded[`${project?.id}:${id}`]} onClick={() => setArchivedExpanded((value) => ({ ...value, [`${project?.id}:${id}`]: !value[`${project?.id}:${id}`] }))}><ChevronRight size={13} /><Archive size={13} /><span>已归档</span><small>{archivedThreads.length}</small></button>
                  {!!archivedExpanded[`${project?.id}:${id}`] && archivedThreads.map((item) => <div className="modeling-thread-row archived" key={item.id} onContextMenu={(event) => {
                    event.preventDefault();
                    const anchor = event.currentTarget.querySelector<HTMLButtonElement>(".modeling-thread-more");
                    if (anchor) openThreadMenu(item, anchor, false, { x: event.clientX, y: event.clientY });
                  }}>
                    <button className={`modeling-thread ${threadId === item.id ? "active" : ""}`} onClick={() => onThread(item)}><Archive size={14} /><span>{item.title}</span></button>
                    <button className="modeling-thread-more" aria-label={`${item.title}的对话菜单`} aria-haspopup="menu" aria-expanded={threadMenu?.thread.id === item.id} onClick={(event) => openThreadMenu(item, event.currentTarget)}><MoreHorizontal size={15} /></button>
                  </div>)}
                  </div>}
                </div>
              </div>}
            </section>;
          })}
        </nav>
      </section>
    </div>
    {avatarPreview && account.avatar && createPortal(<div className="avatar-preview" role="dialog" aria-label="头像原图" aria-modal="true" onClick={() => setAvatarPreview(false)}><button autoFocus aria-label="关闭头像原图" onClick={() => setAvatarPreview(false)}><img src={account.avatarOriginal ?? account.avatar} alt={`${account.nickname}的头像原图`} /></button></div>, document.body)}
    {projectMenu && createPortal(<div ref={projectMenuElement} className="modeling-project-menu" role="menu" aria-label={`${projectDisplayName(projectMenu.project)}的项目菜单`} style={{ top: projectMenu.top, left: projectMenu.left }}>
      <button ref={projectMenuButton} role="menuitem" onClick={() => { const item = projectMenu.project; setProjectMenu(null); onRenameProject(item); }}><Pencil size={15} />重命名项目</button>
      <button role="menuitem" disabled={busy} onClick={() => { const item = projectMenu.project; setProjectMenu(null); onArchiveProject(item, !item.archived); }}><Archive size={16} />{projectMenu.project.archived ? "恢复项目" : "归档项目"}</button>
      <button className="modeling-project-remove" role="menuitem" disabled={busy} onClick={() => { const item = projectMenu.project; setProjectMenu(null); onResetProject(item); }}><RotateCcw size={16} />重置项目</button>
      <button className="modeling-project-remove" role="menuitem" onClick={() => { const item = projectMenu.project; setProjectMenu(null); onRemoveProject(item); }}><X size={16} />从 NEXIOM 中移除</button>
    </div>, document.body)}
    {threadMenu && createPortal(<div id="modeling-thread-menu" ref={threadMenuElement} className="modeling-thread-menu" role="menu" aria-label={`${threadMenu.thread.title}的对话菜单`} style={{ top: threadMenu.top, left: threadMenu.left }}>
      <button ref={threadMenuButton} role="menuitem" onClick={() => { const item = threadMenu.thread; setThreadMenu(null); onRenameThread(item); }}><Pencil size={17} /><span>重命名</span><kbd>Alt+Ctrl+R</kbd></button>
      <button role="menuitem" onClick={() => { const item = threadMenu.thread; setThreadMenu(null); onUnreadThread(item, !item.unread); }}>{threadMenu.thread.unread ? <Eye size={17} /> : <EyeOff size={17} />}<span>{threadMenu.thread.unread ? "标记为已读" : "标记为未读"}</span><kbd>Ctrl+Shift+U</kbd></button>
      <button role="menuitem" onClick={() => { const item = threadMenu.thread; setThreadMenu(null); onArchiveThread(item, !item.archivedAt); }}>{threadMenu.thread.archivedAt ? <ArchiveRestore size={17} /> : <Archive size={17} />}<span>{threadMenu.thread.archivedAt ? "取消归档" : "归档"}</span><kbd>Ctrl+Shift+A</kbd></button>
      <button className="modeling-thread-delete" role="menuitem" onClick={() => { const item = threadMenu.thread; setThreadMenu(null); onDeleteThread(item); }}><Trash2 size={17} /><span>永久删除</span></button>
      <div className="modeling-menu-separator" role="separator" />
      <div className="modeling-submenu-row">
        <button role="menuitem" aria-haspopup="menu" aria-expanded={threadSubmenu === "project"} onClick={() => setThreadSubmenu((value) => value === "project" ? null : "project")}><FolderInput size={17} /><span>项目</span><ChevronRight size={16} /></button>
        {threadSubmenu === "project" && <div className="modeling-thread-submenu" role="menu" aria-label="移动到项目">
          {projects.filter((item) => item.id !== threadMenu.thread.projectId).map((item) => <button key={item.id} role="menuitem" onClick={() => { const thread = threadMenu.thread; setThreadMenu(null); onMoveThread(thread, item.id); }}><FolderOpen size={16} /><span>{projectDisplayName(item)}</span></button>)}
          {!projects.some((item) => item.id !== threadMenu.thread.projectId) && <span className="modeling-submenu-empty">没有其他项目</span>}
        </div>}
      </div>
      <div className="modeling-menu-separator" role="separator" />
      <div className="modeling-submenu-row">
        <button role="menuitem" aria-haspopup="menu" aria-expanded={threadSubmenu === "copy"} onClick={() => setThreadSubmenu((value) => value === "copy" ? null : "copy")}><Copy size={17} /><span>复制</span><ChevronRight size={16} /></button>
        {threadSubmenu === "copy" && <div className="modeling-thread-submenu" role="menu" aria-label="复制选项">
          <button role="menuitem" onClick={() => { const thread = threadMenu.thread; setThreadMenu(null); onCopyThread(thread, "title"); }}><Copy size={16} /><span>复制名称</span></button>
          <button role="menuitem" onClick={() => { const thread = threadMenu.thread; setThreadMenu(null); onCopyThread(thread, "content"); }}><FileText size={16} /><span>复制对话内容</span></button>
        </div>}
      </div>
      <div className="modeling-menu-separator" role="separator" />
      <div className="modeling-submenu-row">
        <button role="menuitem" aria-haspopup="menu" aria-expanded={threadSubmenu === "fork"} onClick={() => setThreadSubmenu((value) => value === "fork" ? null : "fork")}><GitFork size={17} /><span>分叉</span><ChevronRight size={16} /></button>
        {threadSubmenu === "fork" && <div className="modeling-thread-submenu" role="menu" aria-label="分叉到项目">
          {projects.map((item) => <button key={item.id} role="menuitem" onClick={() => { const thread = threadMenu.thread; setThreadMenu(null); onForkThread(thread, item.id); }}>{item.id === threadMenu.thread.projectId ? <Check size={16} /> : <FolderOpen size={16} />}<span>{item.id === threadMenu.thread.projectId ? "当前项目" : projectDisplayName(item)}</span></button>)}
        </div>}
      </div>
      <div className="modeling-menu-separator" role="separator" />
      <button role="menuitem" onClick={() => { const item = threadMenu.thread; setThreadMenu(null); onOpenThreadWindow(item); }}><PanelTopOpen size={17} /><span>在新窗口中打开</span></button>
    </div>, document.body)}
    <div className="modeling-account" ref={accountMenu} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setAccountOpen(false); }}>
      {accountOpen && <div className="modeling-account-menu" role="menu" aria-label="账户菜单"><button ref={settingsButton} role="menuitem" onClick={() => { setAccountOpen(false); accountButton.current?.focus(); onSettings(); }}><Settings2 size={17} />设置</button></div>}
      {updateError && <div className="modeling-update-error" role="alert">{updateError}</div>}
      <div className="modeling-account-row">
        <button ref={accountButton} className="modeling-account-button" aria-label={`账户：${account.nickname}`} aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => { setProjectMenu(null); setThreadMenu(null); setAccountOpen((value) => !value); }} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setProjectMenu(null); setThreadMenu(null); setAccountOpen(true); } }}>
          <span className="modeling-account-avatar" title={account.avatar ? "长按查看头像" : undefined} onPointerDown={event => { if (!account.avatar) return; event.stopPropagation(); avatarHeld.current = false; clearAvatarTimer(); avatarTimer.current = setTimeout(() => { avatarHeld.current = true; setAvatarPreview(true); }, 500); }} onPointerUp={clearAvatarTimer} onPointerLeave={clearAvatarTimer} onPointerCancel={clearAvatarTimer} onClick={event => { if (avatarHeld.current) { event.preventDefault(); event.stopPropagation(); avatarHeld.current = false; } }}>{account.avatar ? <img src={account.avatar} alt="" /> : account.nickname.trim().slice(0, 1).toUpperCase()}</span><span>{account.nickname}</span>
        </button>
        <span className="modeling-update-slot">
          <button className="modeling-update-button" type="button" aria-label={updating ? "正在更新" : "更新"} disabled={updating || updateBlocked} onClick={() => void applyUpdate()}>
            {updating ? <LoaderCircle size={15} /> : <><Download size={15} /><span className="update-hover-label" aria-hidden="true">更新</span></>}
          </button>
        </span>
      </div>
    </div>
  </aside>;
}
