import { useState } from "react";
import { AlertCircle, Eye, FolderX, Plus, RefreshCw, X } from "lucide-react";
import type { ExclusionPreviewDto, ReconcileSummary } from "../../lib/contracts";

const PRESET_EXCLUSIONS = [
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vite",
  "__pycache__",
  ".venv",
  "coverage",
];

interface ExclusionsModalProps {
  vaultName: string;
  initialPatterns: string[];
  onPreview: (patterns: string[]) => Promise<ExclusionPreviewDto>;
  onApply: (patterns: string[]) => Promise<ReconcileSummary>;
  onClose: () => void;
}

export function ExclusionsModal({
  vaultName,
  initialPatterns,
  onPreview,
  onApply,
  onClose,
}: ExclusionsModalProps) {
  const [patterns, setPatterns] = useState<string[]>(initialPatterns);
  const [customPattern, setCustomPattern] = useState("");
  const [preview, setPreview] = useState<ExclusionPreviewDto | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [appliedSummary, setAppliedSummary] = useState<ReconcileSummary | null>(
    null,
  );

  function togglePreset(preset: string) {
    setPreview(null);
    setAppliedSummary(null);
    setPatterns((prev) =>
      prev.includes(preset)
        ? prev.filter((p) => p !== preset)
        : [...prev, preset],
    );
  }

  function addCustomPattern() {
    const cleaned = customPattern.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    const lower = cleaned.toLowerCase();
    if (!patterns.includes(lower)) {
      setPatterns((prev) => [...prev, lower]);
      setPreview(null);
      setAppliedSummary(null);
    }
    setCustomPattern("");
  }

  function removePattern(pat: string) {
    setPatterns((prev) => prev.filter((p) => p !== pat));
    setPreview(null);
    setAppliedSummary(null);
  }

  async function handlePreview() {
    setIsWorking(true);
    setErrorMessage(null);
    try {
      const result = await onPreview(patterns);
      setPreview(result);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to preview exclusions.",
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function handleApply() {
    setIsWorking(true);
    setErrorMessage(null);
    try {
      const summary = await onApply(patterns);
      setAppliedSummary(summary);
      onClose();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to apply exclusions.",
      );
    } finally {
      setIsWorking(false);
    }
  }

  return (
    <div
      className="pb-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Configure Vault Indexing Exclusions"
    >
      <div className="pb-modal">
        <div className="pb-modal-header">
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <FolderX size={16} /> Indexing Exclusions — {vaultName}
          </h2>
          <button
            type="button"
            className="pb-icon-btn"
            aria-label="Close exclusions dialog"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="pb-modal-body">
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 12.5 }}>
            Exclude dependency directories, generated docs, or build outputs from
            indexing and the Knowledge Universe. Source Markdown files on disk are
            never deleted, and full backups continue to preserve all files.
          </p>

          {errorMessage ? (
            <div className="pb-banner pb-banner-error" role="alert">
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <AlertCircle size={14} /> {errorMessage}
              </span>
            </div>
          ) : null}

          <div className="pb-field">
            <label>Common directories</label>
            <div className="pb-tag-list">
              {PRESET_EXCLUSIONS.map((preset) => {
                const active = patterns.includes(preset);
                return (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={active}
                    className={`pb-btn pb-btn-sm ${active ? "pb-btn-primary" : ""}`}
                    onClick={() => togglePreset(preset)}
                  >
                    {preset}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pb-field">
            <label htmlFor="pb-custom-exclusion">Add custom folder or glob pattern</label>
            <div className="pb-input-row">
              <input
                id="pb-custom-exclusion"
                className="pb-input pb-input-mono"
                value={customPattern}
                onChange={(e) => setCustomPattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomPattern();
                  }
                }}
                placeholder="e.g. docs/generated, packages/*/dist, *.generated.md"
              />
              <button
                type="button"
                className="pb-btn"
                onClick={addCustomPattern}
                disabled={!customPattern.trim()}
              >
                <Plus size={13} /> Add
              </button>
            </div>
          </div>

          <div className="pb-field">
            <label>Active patterns ({patterns.length})</label>
            {patterns.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                No exclusion patterns configured.
              </span>
            ) : (
              <div className="pb-tag-list">
                {patterns.map((pat) => (
                  <span
                    key={pat}
                    className="pb-badge"
                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)" }}>{pat}</span>
                    <button
                      type="button"
                      className="pb-icon-btn"
                      style={{ width: 16, height: 16 }}
                      aria-label={`Remove pattern ${pat}`}
                      onClick={() => removePattern(pat)}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {preview ? (
            <div className="pb-surface-card" style={{ padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <strong>Impact Preview</strong>
                <span className="pb-badge" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {preview.excluded_note_count} excluded · {preview.remaining_note_count} indexed
                </span>
              </div>
              {preview.sample_excluded_paths.length > 0 ? (
                <div
                  style={{
                    maxHeight: 140,
                    overflowY: "auto",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "var(--text-secondary)",
                    display: "grid",
                    gap: 2,
                  }}
                >
                  {preview.sample_excluded_paths.map((rel) => (
                    <div key={rel}>{rel}</div>
                  ))}
                  {preview.excluded_note_count >
                  preview.sample_excluded_paths.length ? (
                    <div style={{ color: "var(--text-muted)" }}>
                      …and{" "}
                      {preview.excluded_note_count -
                        preview.sample_excluded_paths.length}{" "}
                      more notes
                    </div>
                  ) : null}
                </div>
              ) : (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  No Markdown notes match these exclusion patterns.
                </span>
              )}
            </div>
          ) : null}

          {appliedSummary ? (
            <div className="pb-banner pb-banner-info" role="status">
              Index rebuilt to generation #{appliedSummary.index_generation} (
              {appliedSummary.indexed_notes} indexed).
            </div>
          ) : null}
        </div>

        <div className="pb-modal-footer">
          <button
            type="button"
            className="pb-btn"
            disabled={isWorking}
            onClick={() => void handlePreview()}
          >
            <Eye size={13} /> Preview Impact
          </button>
          <button
            type="button"
            className="pb-btn"
            disabled={isWorking}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pb-btn pb-btn-primary"
            disabled={isWorking}
            onClick={() => void handleApply()}
          >
            <RefreshCw size={13} /> Apply &amp; Rebuild Index
          </button>
        </div>
      </div>
    </div>
  );
}
