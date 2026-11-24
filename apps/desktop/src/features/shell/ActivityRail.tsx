import {
  BookOpen,
  BrainCircuit,
  Home,
  Orbit,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import type { NavSection } from "../../lib/contracts";

interface ActivityRailProps {
  activeSection: NavSection;
  hasActiveVault: boolean;
  onSelectSection: (section: NavSection) => void;
  onOpenSearch: () => void;
}

export function ActivityRail({
  activeSection,
  hasActiveVault,
  onSelectSection,
  onOpenSearch,
}: ActivityRailProps) {
  return (
    <aside className="pb-rail" aria-label="Primary navigation">
      <div className="pb-rail-brand" title="Personal Brain">
        PB
      </div>

      <button
        type="button"
        className={`pb-rail-btn ${activeSection === "home" ? "is-active" : ""}`}
        aria-label="Home"
        title="Home"
        aria-pressed={activeSection === "home"}
        onClick={() => onSelectSection("home")}
      >
        <Home size={18} strokeWidth={1.75} />
      </button>

      <button
        type="button"
        className={`pb-rail-btn ${activeSection === "knowledge" ? "is-active" : ""}`}
        aria-label="Knowledge"
        title={hasActiveVault ? "Knowledge Workspace" : "Open a vault first"}
        aria-pressed={activeSection === "knowledge"}
        disabled={!hasActiveVault}
        onClick={() => onSelectSection("knowledge")}
      >
        <BookOpen size={18} strokeWidth={1.75} />
      </button>

      <button
        type="button"
        className="pb-rail-btn"
        aria-label="Search notes"
        title={hasActiveVault ? "Search Notes (Ctrl+K)" : "Open a vault first"}
        disabled={!hasActiveVault}
        onClick={onOpenSearch}
      >
        <Search size={18} strokeWidth={1.75} />
      </button>

      <button
        type="button"
        className="pb-rail-btn"
        aria-label="Universe (Unavailable in Phase 4)"
        title="Universe (Phase 5 — not yet enabled)"
        disabled
        aria-disabled="true"
      >
        <Orbit size={18} strokeWidth={1.75} />
      </button>

      <button
        type="button"
        className="pb-rail-btn"
        aria-label="AI Brain (Unavailable in Phase 4)"
        title="AI Brain (Phase 7 — not yet enabled)"
        disabled
        aria-disabled="true"
      >
        <Sparkles size={18} strokeWidth={1.75} />
      </button>

      <button
        type="button"
        className="pb-rail-btn"
        aria-label="Memory (Unavailable in Phase 4)"
        title="Shared Memory (Phase 6 — not yet enabled)"
        disabled
        aria-disabled="true"
      >
        <BrainCircuit size={18} strokeWidth={1.75} />
      </button>

      <div className="pb-rail-spacer" />

      <button
        type="button"
        className={`pb-rail-btn ${activeSection === "settings" ? "is-active" : ""}`}
        aria-label="Settings"
        title="Settings & Vault Maintenance"
        aria-pressed={activeSection === "settings"}
        onClick={() => onSelectSection("settings")}
      >
        <Settings size={18} strokeWidth={1.75} />
      </button>
    </aside>
  );
}
