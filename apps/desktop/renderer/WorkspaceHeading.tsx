import type { ReactNode } from "react";
import { WorkspaceLogo } from "./WorkspaceLogo";
import { dimensions, type Dimension } from "./ModelingSidebar";

export function WorkspaceHeading({ dimension, projectName, title, detail }: { dimension: Dimension; projectName: string; title: string; detail?: ReactNode }) {
  const Icon = dimensions.find(item => item.id === dimension)!.icon;
  return <div className="workspace-heading"><WorkspaceLogo dimension={dimension}/><div className="workspace-heading-copy"><span className="workspace-heading-project"><Icon size={14}/><span>{projectName}</span></span><h1>{title}</h1>{detail && <p>{detail}</p>}</div></div>;
}
