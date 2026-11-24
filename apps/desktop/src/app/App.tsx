import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppHealthDto,
  BacklinkHit,
  BrokenLinkDto,
  DraftSnapshot,
  EditorTabState,
  EditorViewMode,
  ErrorEnvelope,
  MovePlan,
  NavSection,
  NoteSnapshot,
  NoteSummary,
  RevisionSummaryDto,
  ThemePreference,
  TrashedNoteSummary,
  VaultSummary,
  WatcherEventDto,
} from "../lib/contracts";
import {
  createNote,
  createRequestId,
  createVault,
  createVaultBackup,
  exportVaultFiles,
  fetchAppHealth,
  getNoteBacklinks,
  getVaultBrokenLinks,
  listNotes,
  listRevisions,
  listTrashedNotes,
  listVaults,
  moveNote,
  normalizeIpcError,
  openVault,
  previewMove,
  readNote,
  rebuildVaultIndex,
  restoreRevision,
  restoreTrashedNote,
  restoreVaultBackup,
  saveNote,
  setPinned,
  subscribeVaultReconciled,
  trashNote,
} from "../lib/ipc";
import { ActivityRail } from "../features/shell/ActivityRail";
import { StatusBar } from "../features/shell/StatusBar";
import { OnboardingView } from "../features/onboarding/OnboardingView";
import { HomeDashboard } from "../features/home/HomeDashboard";
import { VaultExplorer } from "../features/explorer/VaultExplorer";
import { EditorWorkspace } from "../features/editor/EditorWorkspace";
import { NoteInspector } from "../features/inspector/NoteInspector";
import { SearchPanel } from "../features/search/SearchPanel";
import { SettingsView } from "../features/settings/SettingsView";

const PREF_THEME_KEY = "pb.pref.theme";
const PREF_VIEW_MODE_KEY = "pb.pref.viewMode";
const PREF_AUTOSAVE_KEY = "pb.pref.autosave";

function readInitialTheme(): ThemePreference {
  const saved = window.localStorage.getItem(PREF_THEME_KEY);
  if (saved === "light" || saved === "dark" || saved === "system") {
    return saved;
  }
  return "system";
}

function readInitialViewMode(): EditorViewMode {
  const saved = window.localStorage.getItem(PREF_VIEW_MODE_KEY);
  if (saved === "edit" || saved === "split" || saved === "preview") {
    return saved;
  }
  return "split";
}

function readInitialAutosave(): boolean {
  const saved = window.localStorage.getItem(PREF_AUTOSAVE_KEY);
  return saved !== "false";
}

function draftStorageKey(vaultId: string, noteId: string): string {
  return `pb.draft.${vaultId}.${noteId}`;
}

function loadSessionDraft(
  vaultId: string,
  noteId: string,
): DraftSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(draftStorageKey(vaultId, noteId));
    if (!raw) return null;
    return JSON.parse(raw) as DraftSnapshot;
  } catch {
    return null;
  }
}

function saveSessionDraft(draft: DraftSnapshot): void {
  try {
    window.sessionStorage.setItem(
      draftStorageKey(draft.vaultId, draft.noteId),
      JSON.stringify(draft),
    );
  } catch {
    // Ignore quota failures cleanly
  }
}

function clearSessionDraft(vaultId: string, noteId: string): void {
  try {
    window.sessionStorage.removeItem(draftStorageKey(vaultId, noteId));
  } catch {
    // Ignore storage cleanup errors
  }
}

function snapshotToTab(
  snapshot: NoteSnapshot,
  recoveredDraft: DraftSnapshot | null,
): EditorTabState {
  const hasRecoveredDraft =
    recoveredDraft !== null &&
    recoveredDraft.baseHash === snapshot.content_hash &&
    recoveredDraft.draftBody !== snapshot.body;

  return {
    noteId: snapshot.note_id,
    relPath: snapshot.rel_path,
    title: snapshot.title,
    savedBody: snapshot.body,
    draftBody: hasRecoveredDraft ? recoveredDraft.draftBody : snapshot.body,
    baseHash: snapshot.content_hash,
    parseStatus: snapshot.parse_status,
    origin: snapshot.origin,
    verification: snapshot.verification,
    pinned: snapshot.pinned,
    tags: snapshot.tags,
    aliases: snapshot.aliases,
    indexGeneration: snapshot.index_generation,
    dirty: hasRecoveredDraft,
    saveState: hasRecoveredDraft ? "dirty" : "saved",
    lastSavedAt: null,
    conflict: null,
    externalUpdateNotice: hasRecoveredDraft
      ? "Recovered unsaved draft from this session."
      : null,
  };
}

function formatTimeShort(): string {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function makeConflictCopyPath(relPath: string): string {
  const dotIdx = relPath.lastIndexOf(".");
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  if (dotIdx > 0) {
    return `${relPath.slice(0, dotIdx)}.conflict-${stamp}${relPath.slice(dotIdx)}`;
  }
  return `${relPath}.conflict-${stamp}.md`;
}

export function App() {
  const [appHealth, setAppHealth] = useState<AppHealthDto | null>(null);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [activeVault, setActiveVault] = useState<VaultSummary | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const [navSection, setNavSection] = useState<NavSection>("home");
  const [theme, setTheme] = useState<ThemePreference>(readInitialTheme);
  const [viewMode, setViewMode] = useState<EditorViewMode>(readInitialViewMode);
  const [autosaveEnabled, setAutosaveEnabled] = useState<boolean>(
    readInitialAutosave,
  );
  const [showExplorer, setShowExplorer] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);

  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [brokenLinks, setBrokenLinks] = useState<BrokenLinkDto[]>([]);
  const [trashedNotes, setTrashedNotes] = useState<TrashedNoteSummary[]>([]);
  const [recentNoteIds, setRecentNoteIds] = useState<string[]>([]);

  const [tabs, setTabs] = useState<EditorTabState[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null,
  );

  const [backlinks, setBacklinks] = useState<BacklinkHit[]>([]);
  const [revisions, setRevisions] = useState<RevisionSummaryDto[]>([]);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);

  const [moveModalNote, setMoveModalNote] = useState<NoteSummary | null>(null);
  const [trashModalNote, setTrashModalNote] = useState<NoteSummary | null>(
    null,
  );
  const [newNoteRequestSeq, setNewNoteRequestSeq] = useState(0);
  const [pendingVaultAction, setPendingVaultAction] = useState<
    | { kind: "activate"; vault: VaultSummary }
    | { kind: "create"; rootPath: string; displayName: string }
    | { kind: "open"; rootPath: string }
    | null
  >(null);

  const [isBusy, setIsBusy] = useState(false);
  const [globalError, setGlobalError] = useState<ErrorEnvelope | null>(null);
  const [externalNotice, setExternalNotice] = useState<string | null>(null);

  const tabsRef = useRef<EditorTabState[]>(tabs);
  const activeVaultRef = useRef<VaultSummary | null>(activeVault);
  const notesRef = useRef<NoteSummary[]>(notes);
  const autosaveTimersRef = useRef<Map<string, number>>(new Map());
  const inFlightSavesRef = useRef<Set<string>>(new Set());
  const pendingResaveRef = useRef<Set<string>>(new Set());
  const performSaveRef = useRef<
    (noteId: string, overrideExpectedHash?: string) => Promise<void>
  >(async () => {});

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeVaultRef.current = activeVault;
  }, [activeVault]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    if (theme === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
    window.localStorage.setItem(PREF_THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(PREF_VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    window.localStorage.setItem(PREF_AUTOSAVE_KEY, String(autosaveEnabled));
  }, [autosaveEnabled]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [health, registeredVaults] = await Promise.all([
          fetchAppHealth(),
          listVaults(),
        ]);
        if (cancelled) return;
        setAppHealth(health);
        setVaults(registeredVaults);
      } catch (err) {
        if (cancelled) return;
        setGlobalError(normalizeIpcError(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshVaultCatalog = useCallback(async (vaultId: string) => {
    const [noteList, brokenList, trashList, allVaults] = await Promise.all([
      listNotes(vaultId),
      getVaultBrokenLinks(vaultId),
      listTrashedNotes(vaultId),
      listVaults(),
    ]);
    setNotes(noteList);
    setBrokenLinks(brokenList);
    setTrashedNotes(trashList);
    setVaults(allVaults);
    const updatedActive = allVaults.find((v) => v.vault_id === vaultId);
    if (updatedActive) {
      setActiveVault(updatedActive);
    }
  }, []);

  const loadNoteDetails = useCallback(async (vaultId: string, noteId: string) => {
    setIsLoadingDetails(true);
    try {
      const [incoming, historyList] = await Promise.all([
        getNoteBacklinks(vaultId, noteId),
        listRevisions(vaultId, noteId),
      ]);
      setBacklinks(incoming);
      setRevisions(historyList);
    } catch (err) {
      setGlobalError(normalizeIpcError(err));
    } finally {
      setIsLoadingDetails(false);
    }
  }, []);

  useEffect(() => {
    if (!activeVault || !activeNoteId) {
      return;
    }
    let cancelled = false;
    const vaultId = activeVault.vault_id;
    const noteId = activeNoteId;

    (async () => {
      try {
        const [incoming, historyList] = await Promise.all([
          getNoteBacklinks(vaultId, noteId),
          listRevisions(vaultId, noteId),
        ]);
        if (cancelled) return;
        setBacklinks(incoming);
        setRevisions(historyList);
      } catch (err) {
        if (cancelled) return;
        setGlobalError(normalizeIpcError(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeVault, activeNoteId]);

  const clearAllAutosaveTimers = useCallback(() => {
    for (const timer of autosaveTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    autosaveTimersRef.current.clear();
  }, []);

  const executeVaultSwitch = useCallback(
    async (
      action:
        | { kind: "activate"; vault: VaultSummary }
        | { kind: "create"; rootPath: string; displayName: string }
        | { kind: "open"; rootPath: string },
    ) => {
      clearAllAutosaveTimers();
      setIsBusy(true);
      setGlobalError(null);
      try {
        const report =
          action.kind === "activate"
            ? await openVault(action.vault.root_path)
            : action.kind === "create"
              ? await createVault(
                  action.rootPath,
                  action.displayName || undefined,
                )
              : await openVault(action.rootPath);
        setActiveVault(report.vault);
        setTabs([]);
        setActiveNoteId(null);
        setBacklinks([]);
        setRevisions([]);
        setShowOnboarding(false);
        setNavSection("knowledge");
        await refreshVaultCatalog(report.vault.vault_id);
      } catch (err) {
        setGlobalError(normalizeIpcError(err));
      } finally {
        setIsBusy(false);
      }
    },
    [clearAllAutosaveTimers, refreshVaultCatalog],
  );

  const handleActivateVault = useCallback(
    async (vaultSummary: VaultSummary) => {
      if (
        activeVaultRef.current &&
        activeVaultRef.current.vault_id !== vaultSummary.vault_id &&
        tabsRef.current.some((t) => t.dirty)
      ) {
        setPendingVaultAction({ kind: "activate", vault: vaultSummary });
        return;
      }
      await executeVaultSwitch({ kind: "activate", vault: vaultSummary });
    },
    [executeVaultSwitch],
  );

  const handleCreateVault = useCallback(
    async (rootPath: string, displayName: string) => {
      if (activeVaultRef.current && tabsRef.current.some((t) => t.dirty)) {
        setPendingVaultAction({ kind: "create", rootPath, displayName });
        return;
      }
      await executeVaultSwitch({ kind: "create", rootPath, displayName });
    },
    [executeVaultSwitch],
  );

  const handleOpenVaultPath = useCallback(
    async (rootPath: string) => {
      if (activeVaultRef.current && tabsRef.current.some((t) => t.dirty)) {
        setPendingVaultAction({ kind: "open", rootPath });
        return;
      }
      await executeVaultSwitch({ kind: "open", rootPath });
    },
    [executeVaultSwitch],
  );

  const openNoteById = useCallback(async (noteId: string) => {
    const vault = activeVaultRef.current;
    if (!vault) return;

    const alreadyOpen = tabsRef.current.find((t) => t.noteId === noteId);
    if (alreadyOpen) {
      setActiveNoteId(noteId);
      setNavSection("knowledge");
      setShowOnboarding(false);
      return;
    }

    setIsBusy(true);
    setGlobalError(null);
    try {
      const snapshot = await readNote(vault.vault_id, noteId);
      const recovered = loadSessionDraft(vault.vault_id, noteId);
      const newTab = snapshotToTab(snapshot, recovered);
      setTabs((prev) => {
        if (prev.some((t) => t.noteId === noteId)) return prev;
        return [...prev, newTab];
      });
      setActiveNoteId(noteId);
      setRecentNoteIds((prev) => [
        noteId,
        ...prev.filter((id) => id !== noteId),
      ].slice(0, 10));
      setNavSection("knowledge");
      setShowOnboarding(false);
    } catch (err) {
      setGlobalError(normalizeIpcError(err));
    } finally {
      setIsBusy(false);
    }
  }, []);

  const performSave = useCallback(
    async (noteId: string, overrideExpectedHash?: string) => {
      const vault = activeVaultRef.current;
      const tab = tabsRef.current.find((t) => t.noteId === noteId);
      if (!vault || !tab) return;

      const timer = autosaveTimersRef.current.get(noteId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        autosaveTimersRef.current.delete(noteId);
      }

      if (inFlightSavesRef.current.has(noteId)) {
        pendingResaveRef.current.add(noteId);
        return;
      }

      inFlightSavesRef.current.add(noteId);
      const bodyToSave = tab.draftBody;
      const baseHashToUse = overrideExpectedHash ?? tab.baseHash;

      setTabs((prev) =>
        prev.map((t) =>
          t.noteId === noteId ? { ...t, saveState: "saving" } : t,
        ),
      );
      setGlobalError(null);

      try {
        const result = await saveNote(
          vault.vault_id,
          noteId,
          baseHashToUse,
          bodyToSave,
          createRequestId(),
        );
        const refreshed = await readNote(vault.vault_id, noteId);
        const latestTab = tabsRef.current.find((t) => t.noteId === noteId);
        const stillModified = Boolean(
          latestTab && latestTab.draftBody !== bodyToSave,
        );

        if (stillModified && latestTab) {
          saveSessionDraft({
            vaultId: vault.vault_id,
            noteId,
            relPath: refreshed.rel_path,
            draftBody: latestTab.draftBody,
            baseHash: result.content_hash,
            updatedAt: new Date().toISOString(),
          });
        } else {
          clearSessionDraft(vault.vault_id, noteId);
        }

        setTabs((prev) =>
          prev.map((t) => {
            if (t.noteId !== noteId) return t;
            const tabStillModified = t.draftBody !== bodyToSave;
            return {
              ...t,
              relPath: refreshed.rel_path,
              title: refreshed.title,
              savedBody: refreshed.body,
              draftBody: tabStillModified ? t.draftBody : refreshed.body,
              baseHash: result.content_hash,
              parseStatus: refreshed.parse_status,
              tags: refreshed.tags,
              aliases: refreshed.aliases,
              indexGeneration: result.index_generation,
              dirty: tabStillModified,
              saveState: tabStillModified ? "dirty" : "saved",
              lastSavedAt: formatTimeShort(),
              conflict: null,
              externalUpdateNotice: null,
            };
          }),
        );

        await refreshVaultCatalog(vault.vault_id);
        await loadNoteDetails(vault.vault_id, noteId);
      } catch (err) {
        pendingResaveRef.current.delete(noteId);
        const envelope = normalizeIpcError(err);
        if (envelope.code === "NOTE_NOT_FOUND") {
          setTabs((prev) =>
            prev.map((t) =>
              t.noteId === noteId
                ? {
                    ...t,
                    saveState: "conflict",
                    conflict: {
                      kind: "deleted",
                      noteId,
                      relPath: t.relPath,
                      localBody: t.draftBody,
                      localBaseHash: t.baseHash,
                      externalBody: null,
                      externalHash: null,
                      message:
                        "Note is missing on disk (deleted or moved externally). Save a local copy or close the tab.",
                    },
                  }
                : t,
            ),
          );
        } else if (envelope.code === "CONFLICT") {
          try {
            const diskSnapshot = await readNote(vault.vault_id, noteId);
            setTabs((prev) =>
              prev.map((t) =>
                t.noteId === noteId
                  ? {
                      ...t,
                      saveState: "conflict",
                      conflict: {
                        kind: "modified",
                        noteId,
                        relPath: diskSnapshot.rel_path,
                        localBody: t.draftBody,
                        localBaseHash: t.baseHash,
                        externalBody: diskSnapshot.body,
                        externalHash: diskSnapshot.content_hash,
                        message:
                          "This note changed on disk since you started editing. Review differences before saving.",
                      },
                    }
                  : t,
              ),
            );
          } catch (readErr) {
            const readEnvelope = normalizeIpcError(readErr);
            setTabs((prev) =>
              prev.map((t) =>
                t.noteId === noteId
                  ? {
                      ...t,
                      saveState: "conflict",
                      conflict: {
                        kind:
                          readEnvelope.code === "NOTE_NOT_FOUND"
                            ? "deleted"
                            : "modified",
                        noteId,
                        relPath: t.relPath,
                        localBody: t.draftBody,
                        localBaseHash: t.baseHash,
                        externalBody: null,
                        externalHash: null,
                        message: readEnvelope.message,
                      },
                    }
                  : t,
              ),
            );
          }
        } else {
          setTabs((prev) =>
            prev.map((t) =>
              t.noteId === noteId ? { ...t, saveState: "error" } : t,
            ),
          );
        }
        setGlobalError(envelope);
      } finally {
        inFlightSavesRef.current.delete(noteId);
        if (pendingResaveRef.current.delete(noteId)) {
          const latest = tabsRef.current.find((t) => t.noteId === noteId);
          if (latest && latest.dirty && !latest.conflict) {
            void performSaveRef.current(noteId);
          }
        }
      }
    },
    [loadNoteDetails, refreshVaultCatalog],
  );

  useEffect(() => {
    performSaveRef.current = performSave;
  }, [performSave]);

  const handleDraftChange = useCallback(
    (noteId: string, nextBody: string) => {
      const vault = activeVaultRef.current;
      const existing = tabsRef.current.find((t) => t.noteId === noteId);
      if (!vault || !existing) return;

      const isDirty = nextBody !== existing.savedBody;
      setTabs((prev) =>
        prev.map((t) => {
          if (t.noteId !== noteId) return t;
          return {
            ...t,
            draftBody: nextBody,
            dirty: isDirty,
            saveState: t.conflict
              ? "conflict"
              : isDirty
                ? "dirty"
                : "saved",
            externalUpdateNotice: null,
          };
        }),
      );

      if (isDirty) {
        saveSessionDraft({
          vaultId: vault.vault_id,
          noteId,
          relPath: existing.relPath,
          draftBody: nextBody,
          baseHash: existing.baseHash,
          updatedAt: new Date().toISOString(),
        });
      } else {
        clearSessionDraft(vault.vault_id, noteId);
      }

      const prevTimer = autosaveTimersRef.current.get(noteId);
      if (prevTimer !== undefined) {
        window.clearTimeout(prevTimer);
        autosaveTimersRef.current.delete(noteId);
      }

      if (autosaveEnabled && isDirty && !existing.conflict) {
        const handle = window.setTimeout(() => {
          autosaveTimersRef.current.delete(noteId);
          void performSave(noteId);
        }, 850);
        autosaveTimersRef.current.set(noteId, handle);
      }
    },
    [autosaveEnabled, performSave],
  );

  // Watcher event synchronization
  useEffect(() => {
    if (!activeVault) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    const vaultId = activeVault.vault_id;

    (async () => {
      unlisten = await subscribeVaultReconciled(async (event: WatcherEventDto) => {
        if (!active || event.vault_id !== vaultId) return;
        setExternalNotice(
          `Synced external changes (Gen #${event.index_generation})`,
        );
        try {
          await refreshVaultCatalog(vaultId);
        } catch (err) {
          setGlobalError(normalizeIpcError(err));
        }

        const openTabsSnapshot = [...tabsRef.current];
        for (const tab of openTabsSnapshot) {
          try {
            const disk = await readNote(vaultId, tab.noteId);
            const changed =
              disk.content_hash !== tab.baseHash ||
              disk.rel_path !== tab.relPath;
            if (!changed) continue;

            setTabs((prev) =>
              prev.map((current) => {
                if (current.noteId !== tab.noteId) return current;
                if (!current.dirty) {
                  return {
                    ...current,
                    relPath: disk.rel_path,
                    title: disk.title,
                    savedBody: disk.body,
                    draftBody: disk.body,
                    baseHash: disk.content_hash,
                    parseStatus: disk.parse_status,
                    tags: disk.tags,
                    aliases: disk.aliases,
                    indexGeneration: disk.index_generation,
                    saveState: "saved",
                    conflict: null,
                    externalUpdateNotice:
                      "Note reloaded after external disk update.",
                  };
                }
                return {
                  ...current,
                  saveState: "conflict",
                  conflict: {
                    kind: "modified",
                    noteId: current.noteId,
                    relPath: disk.rel_path,
                    localBody: current.draftBody,
                    localBaseHash: current.baseHash,
                    externalBody: disk.body,
                    externalHash: disk.content_hash,
                    message:
                      "Modified externally on disk while you have unsaved edits.",
                  },
                };
              }),
            );
          } catch (err) {
            const env = normalizeIpcError(err);
            if (env.code === "NOTE_NOT_FOUND") {
              const target = tabsRef.current.find(
                (t) => t.noteId === tab.noteId,
              );
              if (target && !target.dirty) {
                const remaining = tabsRef.current.filter(
                  (t) => t.noteId !== tab.noteId,
                );
                setTabs(remaining);
                setActiveNoteId((curr) =>
                  curr === tab.noteId
                    ? remaining[remaining.length - 1]?.noteId ?? null
                    : curr,
                );
              } else if (target) {
                setTabs((prev) =>
                  prev.map((t) =>
                    t.noteId === tab.noteId
                      ? {
                          ...t,
                          saveState: "conflict",
                          conflict: {
                            kind: "deleted",
                            noteId: t.noteId,
                            relPath: t.relPath,
                            localBody: t.draftBody,
                            localBaseHash: t.baseHash,
                            externalBody: null,
                            externalHash: null,
                            message:
                              "Note was deleted or moved outside Personal Brain while you have unsaved edits.",
                          },
                        }
                      : t,
                  ),
                );
              }
            }
          }
        }
      });
    })();

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [activeVault, refreshVaultCatalog]);

  // Global keyboard shortcuts
  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const lower = event.key.toLowerCase();

      if (lower === "k" && activeVaultRef.current) {
        event.preventDefault();
        setSearchOpen((prev) => !prev);
      } else if (lower === "n" && activeVaultRef.current) {
        event.preventDefault();
        setShowOnboarding(false);
        setNavSection("knowledge");
        setShowExplorer(true);
        setNewNoteRequestSeq((seq) => seq + 1);
      } else if (lower === "s" && activeNoteId) {
        event.preventDefault();
        void performSave(activeNoteId);
      } else if (lower === "b" && activeVaultRef.current) {
        event.preventDefault();
        setShowExplorer((prev) => !prev);
      } else if (lower === "i" && event.shiftKey && activeVaultRef.current) {
        event.preventDefault();
        setShowInspector((prev) => !prev);
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [activeNoteId, performSave]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.noteId === activeNoteId) ?? null,
    [tabs, activeNoteId],
  );

  const pendingCloseTab = useMemo(
    () => tabs.find((t) => t.noteId === pendingCloseTabId) ?? null,
    [tabs, pendingCloseTabId],
  );

  const closeTabImmediately = useCallback(
    (noteId: string) => {
      const timer = autosaveTimersRef.current.get(noteId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        autosaveTimersRef.current.delete(noteId);
      }
      if (activeVaultRef.current) {
        clearSessionDraft(activeVaultRef.current.vault_id, noteId);
      }
      const nextTabs = tabsRef.current.filter((t) => t.noteId !== noteId);
      setTabs(nextTabs);
      if (activeNoteId === noteId) {
        setActiveNoteId(nextTabs[nextTabs.length - 1]?.noteId ?? null);
      }
      setPendingCloseTabId(null);
    },
    [activeNoteId],
  );

  const handleRequestCloseTab = useCallback(
    (noteId: string) => {
      const target = tabsRef.current.find((t) => t.noteId === noteId);
      if (!target) return;
      if (target.dirty) {
        setPendingCloseTabId(noteId);
      } else {
        closeTabImmediately(noteId);
      }
    },
    [closeTabImmediately],
  );

  const handleCreateNote = useCallback(
    async (relPath: string) => {
      const vault = activeVaultRef.current;
      if (!vault) return;
      setIsBusy(true);
      setGlobalError(null);
      try {
        const stem =
          relPath.split("/").pop()?.replace(/\.md$/i, "") || "Untitled";
        const result = await createNote(
          vault.vault_id,
          relPath,
          `# ${stem}\n\n`,
          createRequestId(),
        );
        await refreshVaultCatalog(vault.vault_id);
        await openNoteById(result.note_id);
      } catch (err) {
        setGlobalError(normalizeIpcError(err));
        throw err;
      } finally {
        setIsBusy(false);
      }
    },
    [openNoteById, refreshVaultCatalog],
  );

  const handleTogglePin = useCallback(
    async (noteId: string, pinned: boolean) => {
      const vault = activeVaultRef.current;
      if (!vault) return;
      setGlobalError(null);
      try {
        await setPinned(vault.vault_id, noteId, pinned);
        setTabs((prev) =>
          prev.map((t) => (t.noteId === noteId ? { ...t, pinned } : t)),
        );
        await refreshVaultCatalog(vault.vault_id);
      } catch (err) {
        setGlobalError(normalizeIpcError(err));
      }
    },
    [refreshVaultCatalog],
  );

  const handleOpenWikilink = useCallback(
    (rawTarget: string) => {
      const normalized = rawTarget.trim().toLowerCase();
      const targetNoExt = normalized.replace(/\.md$/, "");
      const match = notesRef.current.find((note) => {
        const rel = note.rel_path.toLowerCase();
        const relNoExt = rel.replace(/\.md$/, "");
        const stem = relNoExt.split("/").pop() ?? relNoExt;
        return (
          rel === normalized ||
          relNoExt === targetNoExt ||
          stem === targetNoExt ||
          note.title.toLowerCase() === normalized
        );
      });
      if (match) {
        void openNoteById(match.note_id);
      } else {
        setGlobalError({
          code: "NOTE_NOT_FOUND",
          message: `Wikilink target [[${rawTarget}]] could not be resolved in this vault.`,
          retryable: false,
          operation_id: null,
          safe_details: null,
        });
      }
    },
    [openNoteById],
  );

  const handleConfirmMove = useCallback(
    async (plan: MovePlan, expectedHash: string) => {
      const vault = activeVaultRef.current;
      if (!vault) return;
      setIsBusy(true);
      setGlobalError(null);
      try {
        const result = await moveNote(plan, expectedHash, createRequestId());
        const snapshot = await readNote(vault.vault_id, result.note_id);
        setTabs((prev) =>
          prev.map((t) =>
            t.noteId === result.note_id
              ? {
                  ...t,
                  relPath: snapshot.rel_path,
                  title: snapshot.title,
                  baseHash: snapshot.content_hash,
                  savedBody: snapshot.body,
                  draftBody: t.dirty ? t.draftBody : snapshot.body,
                  indexGeneration: result.index_generation,
                }
              : t,
          ),
        );
        setMoveModalNote(null);
        await refreshVaultCatalog(vault.vault_id);
        if (activeNoteId === result.note_id) {
          await loadNoteDetails(vault.vault_id, result.note_id);
        }
      } catch (err) {
        setGlobalError(normalizeIpcError(err));
      } finally {
        setIsBusy(false);
      }
    },
    [activeNoteId, loadNoteDetails, refreshVaultCatalog],
  );

  const handleConfirmTrash = useCallback(
    async (noteId: string, expectedHash: string) => {
      const vault = activeVaultRef.current;
      if (!vault) return;
      setIsBusy(true);
      setGlobalError(null);
      try {
        await trashNote(vault.vault_id, noteId, expectedHash, createRequestId());
        setTrashModalNote(null);
        closeTabImmediately(noteId);
        await refreshVaultCatalog(vault.vault_id);
      } catch (err) {
        setGlobalError(normalizeIpcError(err));
      } finally {
        setIsBusy(false);
      }
    },
    [closeTabImmediately, refreshVaultCatalog],
  );

  const handleResolveReloadExternal = useCallback(
    async (noteId: string) => {
      const vault = activeVaultRef.current;
      if (!vault) return;
      setGlobalError(null);
      try {
        const disk = await readNote(vault.vault_id, noteId);
        clearSessionDraft(vault.vault_id, noteId);
        setTabs((prev) =>
          prev.map((t) =>
            t.noteId === noteId ? snapshotToTab(disk, null) : t,
          ),
        );
      } catch (err) {
        setGlobalError(normalizeIpcError(err));
        throw err;
      }
    },
    [],
  );

  const handleResolveSaveCopy = useCallback(
    async (noteId: string) => {
      const vault = activeVaultRef.current;
      const tab = tabsRef.current.find((t) => t.noteId === noteId);
      if (!vault || !tab) return;
      setGlobalError(null);
      try {
        const copyPath = makeConflictCopyPath(tab.relPath);
        const created = await createNote(
          vault.vault_id,
          copyPath,
          tab.draftBody,
          createRequestId(),
        );
        clearSessionDraft(vault.vault_id, noteId);
        await refreshVaultCatalog(vault.vault_id);
        await openNoteById(created.note_id);
      } catch (err) {
        setGlobalError(normalizeIpcError(err));
        throw err;
      }
    },
    [openNoteById, refreshVaultCatalog],
  );

  const handleResolveOverwriteDisk = useCallback(
    async (noteId: string) => {
      const tab = tabsRef.current.find((t) => t.noteId === noteId);
      if (!tab?.conflict?.externalHash) return;
      await performSave(noteId, tab.conflict.externalHash);
    },
    [performSave],
  );

  const handleRestoreRevision = useCallback(
    async (revision: RevisionSummaryDto) => {
      const vault = activeVaultRef.current;
      const tab = tabsRef.current.find((t) => t.noteId === revision.note_id);
      if (!vault || !tab) return;
      setIsBusy(true);
      setGlobalError(null);
      try {
        await restoreRevision(
          vault.vault_id,
          revision.revision_id,
          tab.baseHash,
          createRequestId(),
        );
        const restored = await readNote(vault.vault_id, tab.noteId);
        clearSessionDraft(vault.vault_id, tab.noteId);
        setTabs((prev) =>
          prev.map((t) =>
            t.noteId === tab.noteId ? snapshotToTab(restored, null) : t,
          ),
        );
        await refreshVaultCatalog(vault.vault_id);
        await loadNoteDetails(vault.vault_id, tab.noteId);
      } catch (err) {
        setGlobalError(normalizeIpcError(err));
      } finally {
        setIsBusy(false);
      }
    },
    [loadNoteDetails, refreshVaultCatalog],
  );

  const renderContent = () => {
    if (showOnboarding || (!activeVault && navSection !== "settings")) {
      return (
        <OnboardingView
          vaults={vaults}
          isSubmitting={isBusy}
          error={globalError}
          onCreateVault={handleCreateVault}
          onOpenVault={handleOpenVaultPath}
          onSelectExistingVault={handleActivateVault}
        />
      );
    }

    if (navSection === "settings") {
      return (
        <SettingsView
          activeVault={activeVault}
          vaults={vaults}
          theme={theme}
          viewMode={viewMode}
          autosaveEnabled={autosaveEnabled}
          appHealth={appHealth}
          trashedNotes={trashedNotes}
          isBusy={isBusy}
          onChangeTheme={setTheme}
          onChangeViewMode={setViewMode}
          onChangeAutosave={setAutosaveEnabled}
          onSwitchVault={handleActivateVault}
          onOpenOnboarding={() => setShowOnboarding(true)}
          onRebuildIndex={async () => {
            if (!activeVault) throw new Error("No active vault");
            setGlobalError(null);
            try {
              const summary = await rebuildVaultIndex(activeVault.vault_id);
              await refreshVaultCatalog(activeVault.vault_id);
              return summary;
            } catch (err) {
              setGlobalError(normalizeIpcError(err));
              throw err;
            }
          }}
          onExportMarkdown={async (destination) => {
            if (!activeVault) throw new Error("No active vault");
            setGlobalError(null);
            try {
              return await exportVaultFiles(activeVault.vault_id, destination);
            } catch (err) {
              setGlobalError(normalizeIpcError(err));
              throw err;
            }
          }}
          onCreateBackup={async (destination) => {
            if (!activeVault) throw new Error("No active vault");
            setGlobalError(null);
            try {
              return await createVaultBackup(activeVault.vault_id, destination);
            } catch (err) {
              setGlobalError(normalizeIpcError(err));
              throw err;
            }
          }}
          onRestoreBackup={async (backupDir, destination) => {
            setGlobalError(null);
            try {
              const res = await restoreVaultBackup(backupDir, destination);
              const all = await listVaults();
              setVaults(all);
              return res;
            } catch (err) {
              setGlobalError(normalizeIpcError(err));
              throw err;
            }
          }}
          onRestoreTrashed={async (noteId) => {
            if (!activeVault) return;
            setGlobalError(null);
            try {
              await restoreTrashedNote(
                activeVault.vault_id,
                noteId,
                createRequestId(),
              );
              await refreshVaultCatalog(activeVault.vault_id);
              await openNoteById(noteId);
            } catch (err) {
              setGlobalError(normalizeIpcError(err));
              throw err;
            }
          }}
          onRefreshTrash={async () => {
            if (!activeVault) return;
            setGlobalError(null);
            try {
              setTrashedNotes(await listTrashedNotes(activeVault.vault_id));
            } catch (err) {
              setGlobalError(normalizeIpcError(err));
              throw err;
            }
          }}
        />
      );
    }

    if (navSection === "home" || !activeVault) {
      return (
        <HomeDashboard
          activeVault={activeVault}
          vaults={vaults}
          notes={notes}
          brokenLinksCount={brokenLinks.length}
          recentNoteIds={recentNoteIds}
          appHealth={appHealth}
          onOpenKnowledge={() => setNavSection("knowledge")}
          onOpenNote={(noteId) => {
            void openNoteById(noteId);
          }}
          onSelectVault={(vault) => {
            void handleActivateVault(vault);
          }}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenOnboarding={() => setShowOnboarding(true)}
        />
      );
    }

    return (
      <div
        className={`pb-knowledge-shell ${showExplorer ? "" : "no-explorer"} ${
          showInspector ? "" : "no-inspector"
        }`}
      >
        {showExplorer ? (
          <VaultExplorer
            vault={activeVault}
            allVaults={vaults}
            notes={notes}
            selectedNoteId={activeNoteId}
            newNoteRequestSeq={newNoteRequestSeq}
            isBusy={isBusy}
            onSwitchVault={(vault) => {
              void handleActivateVault(vault);
            }}
            onOpenOtherVault={() => setShowOnboarding(true)}
            onSelectNote={(noteId) => {
              void openNoteById(noteId);
            }}
            onCreateNote={handleCreateNote}
            onTogglePin={handleTogglePin}
            onRequestMove={(note) => setMoveModalNote(note)}
            onRequestTrash={(note) => setTrashModalNote(note)}
            onOpenSearch={() => setSearchOpen(true)}
          />
        ) : null}

        <EditorWorkspace
          vaultId={activeVault.vault_id}
          notes={notes}
          tabs={tabs}
          activeTab={activeTab}
          viewMode={viewMode}
          showExplorer={showExplorer}
          showInspector={showInspector}
          isBusy={isBusy}
          onChangeViewMode={setViewMode}
          onToggleExplorer={() => setShowExplorer((p) => !p)}
          onToggleInspector={() => setShowInspector((p) => !p)}
          onSelectTab={(noteId) => setActiveNoteId(noteId)}
          onRequestCloseTab={handleRequestCloseTab}
          onChangeDraft={handleDraftChange}
          onSaveTab={performSave}
          onCreateNotePrompt={handleCreateNote}
          onPreviewMove={async (noteId, dest) => {
            setGlobalError(null);
            try {
              return await previewMove(activeVault.vault_id, noteId, dest);
            } catch (err) {
              setGlobalError(normalizeIpcError(err));
              throw err;
            }
          }}
          onConfirmMove={handleConfirmMove}
          onConfirmTrash={handleConfirmTrash}
          onResolveReloadExternal={handleResolveReloadExternal}
          onResolveSaveCopy={handleResolveSaveCopy}
          onResolveOverwriteDisk={handleResolveOverwriteDisk}
          onCloseDeletedTab={closeTabImmediately}
          onOpenWikilink={handleOpenWikilink}
          pendingCloseTab={pendingCloseTab}
          onCancelClosePending={() => setPendingCloseTabId(null)}
          onConfirmDiscardClosePending={() => {
            if (pendingCloseTab) {
              closeTabImmediately(pendingCloseTab.noteId);
            }
          }}
          onConfirmSaveAndClosePending={async () => {
            if (!pendingCloseTab) return;
            await performSave(pendingCloseTab.noteId);
            const refreshed = tabsRef.current.find(
              (t) => t.noteId === pendingCloseTab.noteId,
            );
            if (!refreshed?.dirty && !refreshed?.conflict) {
              closeTabImmediately(pendingCloseTab.noteId);
            } else {
              setPendingCloseTabId(null);
            }
          }}
          moveModalNote={moveModalNote}
          onCloseMoveModal={() => setMoveModalNote(null)}
          trashModalNote={trashModalNote}
          onCloseTrashModal={() => setTrashModalNote(null)}
        />

        {showInspector ? (
          <NoteInspector
            note={activeTab}
            backlinks={backlinks}
            revisions={revisions}
            brokenLinks={brokenLinks}
            isLoadingDetails={isLoadingDetails}
            onTogglePin={handleTogglePin}
            onOpenNote={(noteId) => {
              void openNoteById(noteId);
            }}
            onRestoreRevision={handleRestoreRevision}
            onRefreshDetails={() => {
              if (activeVault && activeTab) {
                void loadNoteDetails(activeVault.vault_id, activeTab.noteId);
              }
            }}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className="pb-workbench">
      <ActivityRail
        activeSection={navSection}
        hasActiveVault={Boolean(activeVault)}
        onSelectSection={(section) => {
          setShowOnboarding(false);
          setNavSection(section);
        }}
        onOpenSearch={() => setSearchOpen(true)}
      />

      <div className="pb-main-region">{renderContent()}</div>

      <StatusBar
        vault={activeVault}
        activeTab={activeTab}
        isBusy={isBusy}
        externalNotice={externalNotice}
        errorEnvelope={globalError}
        onDismissError={() => setGlobalError(null)}
        onDismissNotice={() => setExternalNotice(null)}
      />

      {activeVault ? (
        <SearchPanel
          isOpen={searchOpen}
          vaultId={activeVault.vault_id}
          notes={notes}
          onSelectNote={(noteId) => {
            void openNoteById(noteId);
          }}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}

      {pendingVaultAction ? (
        <div
          className="pb-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Unsaved changes before switching vaults"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setPendingVaultAction(null);
            }
          }}
        >
          <div className="pb-modal">
            <div className="pb-modal-header">
              <h2>Unsaved notes in {activeVault?.display_name ?? "current vault"}</h2>
            </div>
            <div className="pb-modal-body">
              <p style={{ margin: 0 }}>
                You have unsaved edits in open tabs. Save them before switching
                vaults, or discard them.
              </p>
            </div>
            <div className="pb-modal-footer">
              <button
                type="button"
                className="pb-btn"
                onClick={() => setPendingVaultAction(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-danger"
                onClick={async () => {
                  const action = pendingVaultAction;
                  if (activeVaultRef.current) {
                    for (const tab of tabsRef.current) {
                      clearSessionDraft(activeVaultRef.current.vault_id, tab.noteId);
                    }
                  }
                  setPendingVaultAction(null);
                  await executeVaultSwitch(action);
                }}
              >
                Discard &amp; Switch
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-primary"
                onClick={async () => {
                  const action = pendingVaultAction;
                  const dirtyTabs = tabsRef.current.filter((t) => t.dirty);
                  for (const tab of dirtyTabs) {
                    await performSave(tab.noteId);
                  }
                  const stillDirty = tabsRef.current.some(
                    (t) => t.dirty || Boolean(t.conflict),
                  );
                  if (stillDirty) {
                    setPendingVaultAction(null);
                    return;
                  }
                  setPendingVaultAction(null);
                  await executeVaultSwitch(action);
                }}
              >
                Save All &amp; Switch
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
