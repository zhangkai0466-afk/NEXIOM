export function PanelToggleIcon({ expanded }: { expanded: boolean }) {
  return <svg className={`sidebar-toggle-icon ${expanded ? "expanded" : ""}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false">
    <rect x="3" y="4" width="18" height="16" rx="4" />
    <path d="M9 4v16" />
  </svg>;
}
