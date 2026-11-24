import { useState, type FormEvent } from "react";
import { FolderOpen, FolderPlus, ShieldCheck } from "lucide-react";
import type { ErrorEnvelope, VaultSummary } from "../../lib/contracts";
import { pickDirectoryDialog } from "../../lib/ipc";

interface OnboardingViewProps {
  vaults: VaultSummary[];
  isSubmitting: boolean;
  error: ErrorEnvelope | null;
  onCreateVault: (rootPath: string, displayName: string) => Promise<void>;
  onOpenVault: (rootPath: string) => Promise<void>;
  onSelectExistingVault: (vault: VaultSummary) => Promise<void>;
}

export function OnboardingView({
  vaults,
  isSubmitting,
  error,
  onCreateVault,
  onOpenVault,
  onSelectExistingVault,
}: OnboardingViewProps) {
  const [createPath, setCreatePath] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [openPath, setOpenPath] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  async function handleBrowseCreate() {
    const selected = await pickDirectoryDialog("Choose folder for new vault");
    if (selected) {
      setCreatePath(selected);
      setValidationError(null);
    }
  }

  async function handleBrowseOpen() {
    const selected = await pickDirectoryDialog("Select existing Markdown vault");
    if (selected) {
      setOpenPath(selected);
      setValidationError(null);
    }
  }

  async function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = createPath.trim();
    if (!trimmed) {
      setValidationError("Enter or choose a folder path to create a vault.");
      return;
    }
    setValidationError(null);
    await onCreateVault(trimmed, displayName.trim());
  }

  async function handleOpenSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = openPath.trim();
    if (!trimmed) {
      setValidationError("Enter or choose an existing folder path to open.");
      return;
    }
    setValidationError(null);
    await onOpenVault(trimmed);
  }

  return (
    <section className="pb-onboarding" aria-label="Vault onboarding">
      <div className="pb-onboarding-container">
        <header className="pb-onboarding-header">
          <h1>Open or create a local Markdown vault</h1>
          <p>
            Notes remain plain Markdown files on your Windows disk. Opening an
            existing folder scans and indexes it non-destructively without
            requiring cloud accounts or changing your notes without consent.
          </p>
        </header>

        {validationError ? (
          <div className="pb-banner pb-banner-warn" role="alert">
            <span>{validationError}</span>
          </div>
        ) : null}

        {error ? (
          <div className="pb-banner pb-banner-error" role="alert">
            <span>
              <strong>{error.code}:</strong> {error.message}
            </span>
          </div>
        ) : null}

        <div className="pb-onboarding-actions">
          <form className="pb-surface-card" onSubmit={handleCreateSubmit}>
            <h2>
              <FolderPlus
                size={15}
                style={{ verticalAlign: "-2px", marginRight: 6 }}
              />
              Create New Vault
            </h2>
            <div className="pb-field">
              <label htmlFor="create-vault-path">Target folder</label>
              <div className="pb-input-row">
                <input
                  id="create-vault-path"
                  className="pb-input pb-input-mono"
                  value={createPath}
                  onChange={(e) => setCreatePath(e.target.value)}
                  placeholder="C:\Notes\MyBrain"
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  className="pb-btn"
                  onClick={handleBrowseCreate}
                  disabled={isSubmitting}
                >
                  Browse…
                </button>
              </div>
            </div>

            <div className="pb-field">
              <label htmlFor="create-vault-name">Display name (optional)</label>
              <input
                id="create-vault-name"
                className="pb-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Personal Knowledge"
                disabled={isSubmitting}
              />
            </div>

            <button
              type="submit"
              className="pb-btn pb-btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Creating…" : "Create Vault"}
            </button>
          </form>

          <form className="pb-surface-card" onSubmit={handleOpenSubmit}>
            <h2>
              <FolderOpen
                size={15}
                style={{ verticalAlign: "-2px", marginRight: 6 }}
              />
              Open Existing Folder
            </h2>
            <div className="pb-field">
              <label htmlFor="open-vault-path">Existing Markdown folder</label>
              <div className="pb-input-row">
                <input
                  id="open-vault-path"
                  className="pb-input pb-input-mono"
                  value={openPath}
                  onChange={(e) => setOpenPath(e.target.value)}
                  placeholder="C:\Users\you\Documents\ObsidianVault"
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  className="pb-btn"
                  onClick={handleBrowseOpen}
                  disabled={isSubmitting}
                >
                  Browse…
                </button>
              </div>
            </div>

            <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 12 }}>
              Compatible with Obsidian Markdown, YAML frontmatter, tags, and
              wikilinks. Index databases live inside your AppData workspace.
            </p>

            <button
              type="submit"
              className="pb-btn"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Opening…" : "Open Vault"}
            </button>
          </form>
        </div>

        <section className="pb-surface-card" aria-label="Registered vaults">
          <h2>Recent &amp; Registered Vaults</h2>
          {vaults.length === 0 ? (
            <p style={{ margin: 0, color: "var(--text-secondary)" }}>
              No vaults registered yet. Create a new vault or open an existing
              Markdown folder above.
            </p>
          ) : (
            <div className="pb-recent-list">
              {vaults.map((vault) => (
                <div key={vault.vault_id} className="pb-recent-row">
                  <div className="pb-recent-meta">
                    <strong>{vault.display_name}</strong>
                    <span className="pb-recent-path" title={vault.root_path}>
                      {vault.root_path}
                    </span>
                    <span
                      style={{ fontSize: 11.5, color: "var(--text-muted)" }}
                    >
                      {vault.note_count} notes · Index Gen{" "}
                      {vault.active_index_generation} · {vault.status}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="pb-btn"
                    disabled={isSubmitting}
                    onClick={() => onSelectExistingVault(vault)}
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--text-secondary)",
            fontSize: 12,
          }}
        >
          <ShieldCheck size={15} />
          <span>
            Local-first boundary: path traversal, junctions, and unauthorized
            locations are blocked by the Rust core.
          </span>
        </div>
      </div>
    </section>
  );
}
