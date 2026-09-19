import { Component, useEffect, type ReactNode } from "react";
import "./startup.css";

function Mounted({ children }: { children: ReactNode }) {
  useEffect(() => { window.nexiom?.reportReady?.(); }, []);
  return children;
}

export class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    document.documentElement.removeAttribute("data-starting");
    window.nexiom?.reportFailure?.("react-render");
    window.nexiom?.reportStartupComplete?.();
  }
  render() {
    if (!this.state.failed) return <Mounted>{this.props.children}</Mounted>;
    return <main className="startup-screen" role="alert">
      <div className="startup-titlebar">NEXIOM</div>
      <section className="startup-card">
        <span className="startup-mark">N</span>
        <h1>界面暂时无法显示</h1>
        <p>重新载入界面后继续。项目文件和已保存的会话仍保留在本机。</p>
        <div className="startup-actions">
          <button onClick={() => window.location.reload()}>重新载入</button>
          {window.nexiom?.openStartupLogs && <button onClick={() => { void window.nexiom?.openStartupLogs?.(); }}>打开启动日志</button>}
        </div>
      </section>
    </main>;
  }
}
