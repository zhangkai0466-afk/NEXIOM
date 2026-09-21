import { dimensions, type Dimension } from "./ModelingSidebar";
import "./workspace-logo.css";

/** A work-dimension identity for content headings; navigation stays monochrome. */
export function WorkspaceLogo({ dimension, className = "" }: { dimension: Dimension; className?: string }) {
  const Icon = dimensions.find((item) => item.id === dimension)!.icon;
  return (
    <span className={`workspace-logo ${className}`} data-dimension={dimension} aria-hidden="true">
      <Icon size={30} />
    </span>
  );
}
