import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Edit3,
  File,
  Folder,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "@/lib/shared/utils";

type FileTreeKind = "file" | "dir";

type FsListResponse = {
  path?: string | null;
  entries: Array<{ path: string; kind: FileTreeKind }>;
  hasMore?: boolean;
};

type MentionListResponse = {
  entries: Array<{ path: string; kind: FileTreeKind }>;
  truncated: boolean;
};

type FileTreeNode = {
  path: string;
  name: string;
  kind: FileTreeKind;
  children: string[];
  loaded: boolean;
  loading: boolean;
  error?: string;
};

type FileTreeState = {
  initialized: boolean;
  nodes: Record<string, FileTreeNode>;
  expanded: string[];
  selectedPath: string;
};

type PendingAction = "file" | "folder" | "rename" | null;

const ROOT_PATH = "";
const DEFAULT_MAX_RESULTS = 1000;
const SEARCH_MAX_RESULTS = 80;

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return "";
  return normalized.split("/").pop() || normalized;
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function joinPath(parent: string, name: string) {
  const cleanName = name.trim().replace(/^\/+|\/+$/g, "");
  return parent ? `${parent}/${cleanName}` : cleanName;
}

function rootName(cwd: string) {
  return basename(cwd) || cwd.trim() || "Project";
}

function createRootNode(cwd: string): FileTreeNode {
  return {
    path: ROOT_PATH,
    name: rootName(cwd),
    kind: "dir",
    children: [],
    loaded: false,
    loading: false,
  };
}

function createInitialState(cwd: string): FileTreeState {
  return {
    initialized: false,
    nodes: {
      [ROOT_PATH]: createRootNode(cwd),
    },
    expanded: [ROOT_PATH],
    selectedPath: ROOT_PATH,
  };
}

function sortEntries(entries: Array<{ path: string; kind: FileTreeKind }>) {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    const leftName = basename(left.path).toLowerCase();
    const rightName = basename(right.path).toLowerCase();
    if (leftName === rightName) return left.path.localeCompare(right.path);
    return leftName.localeCompare(rightName);
  });
}

function removeNodeSubtree(nodes: Record<string, FileTreeNode>, path: string) {
  const next = { ...nodes };
  for (const key of Object.keys(next)) {
    if (key === path || key.startsWith(`${path}/`)) {
      delete next[key];
    }
  }
  return next;
}

function toErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text || fallback;
}

export function ProjectFileTreePanel(props: {
  projectPathKey: string;
  cwd: string;
  initialized: boolean;
  onInitializedChange: (initialized: boolean) => void;
  onInsertFileMention?: (path: string, kind: FileTreeKind) => void;
}) {
  const { projectPathKey, cwd, initialized, onInitializedChange, onInsertFileMention } = props;
  const [states, setStates] = useState<Record<string, FileTreeState>>({});
  const [query, setQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<MentionListResponse["entries"]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [draftName, setDraftName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [copiedPath, setCopiedPath] = useState("");

  const state = states[projectPathKey] ?? createInitialState(cwd);
  const selectedNode = state.nodes[state.selectedPath] ?? state.nodes[ROOT_PATH];
  const selectedPath = selectedNode?.path ?? ROOT_PATH;
  const selectedKind = selectedNode?.kind ?? "dir";
  const selectedDir = selectedKind === "dir" ? selectedPath : dirname(selectedPath);
  const hasSelection = Boolean(selectedNode && selectedPath);
  const canMutate = initialized && Boolean(projectPathKey && cwd);

  const setProjectState = useCallback(
    (updater: (state: FileTreeState) => FileTreeState) => {
      if (!projectPathKey) return;
      setStates((prev) => {
        const current = prev[projectPathKey] ?? createInitialState(cwd);
        return {
          ...prev,
          [projectPathKey]: updater(current),
        };
      });
    },
    [cwd, projectPathKey],
  );

  const loadChildren = useCallback(
    async (path: string, options?: { force?: boolean }) => {
      if (!projectPathKey || !cwd.trim()) return;
      let shouldLoad = true;
      setProjectState((current) => {
        const node = current.nodes[path] ?? (path === ROOT_PATH ? createRootNode(cwd) : null);
        if (!node || node.kind !== "dir") {
          shouldLoad = false;
          return current;
        }
        if (node.loaded && !options?.force) {
          shouldLoad = false;
          return current;
        }
        return {
          ...current,
          initialized: true,
          nodes: {
            ...current.nodes,
            [path]: { ...node, loading: true, error: undefined },
          },
        };
      });
      if (!shouldLoad) return;

      try {
        const response = await invoke<FsListResponse>("fs_list", {
          workdir: cwd,
          path: path || undefined,
          depth: 1,
          offset: 0,
          max_results: DEFAULT_MAX_RESULTS,
        });
        const entries = sortEntries(Array.isArray(response.entries) ? response.entries : []);
        setProjectState((current) => {
          const nodes = { ...current.nodes };
          const parent = nodes[path] ?? createRootNode(cwd);
          const childPaths = entries.map((entry) => entry.path).filter(Boolean);
          nodes[path] = {
            ...parent,
            children: childPaths,
            loaded: true,
            loading: false,
            error: response.hasMore ? "Too many items. Showing the first page." : undefined,
          };
          for (const entry of entries) {
            if (!entry.path) continue;
            const existing = nodes[entry.path];
            nodes[entry.path] = {
              path: entry.path,
              name: basename(entry.path) || entry.path,
              kind: entry.kind,
              children: existing?.children ?? [],
              loaded: existing?.loaded ?? false,
              loading: false,
              error: existing?.error,
            };
          }
          return {
            ...current,
            initialized: true,
            nodes,
            expanded: current.expanded.includes(path)
              ? current.expanded
              : [...current.expanded, path],
          };
        });
        onInitializedChange(true);
      } catch (error) {
        setProjectState((current) => {
          const node = current.nodes[path] ?? createRootNode(cwd);
          return {
            ...current,
            nodes: {
              ...current.nodes,
              [path]: {
                ...node,
                loading: false,
                error: toErrorMessage(error, "Failed to read directory"),
              },
            },
          };
        });
      }
    },
    [cwd, onInitializedChange, projectPathKey, setProjectState],
  );

  useEffect(() => {
    if (!initialized || !projectPathKey) return;
    void loadChildren(ROOT_PATH);
  }, [initialized, loadChildren, projectPathKey]);

  useEffect(() => {
    if (!query.trim() || !cwd.trim() || !initialized) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      setSearchTruncated(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      void invoke<MentionListResponse>("fs_mention_list", {
        workdir: cwd,
        query,
        max_results: SEARCH_MAX_RESULTS,
      })
        .then((response) => {
          if (cancelled) return;
          setSearchResults(Array.isArray(response.entries) ? response.entries : []);
          setSearchTruncated(Boolean(response.truncated));
        })
        .catch((error) => {
          if (cancelled) return;
          setSearchResults([]);
          setSearchError(toErrorMessage(error, "Search failed"));
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cwd, initialized, query]);

  const revealPath = useCallback(
    async (path: string, kind: FileTreeKind) => {
      const parts = path.split("/").filter(Boolean);
      const dirs = kind === "dir" ? parts : parts.slice(0, -1);
      let current = ROOT_PATH;
      await loadChildren(ROOT_PATH);
      for (const part of dirs) {
        current = joinPath(current, part);
        await loadChildren(current);
      }
      setProjectState((state) => ({
        ...state,
        selectedPath: path,
        expanded: Array.from(new Set([...state.expanded, ROOT_PATH, ...dirs.map((_, index) => parts.slice(0, index + 1).join("/"))])),
      }));
    },
    [loadChildren, setProjectState],
  );

  const startAction = useCallback(
    (action: Exclude<PendingAction, null>) => {
      setPendingAction(action);
      setActionError(null);
      setDraftName(action === "rename" && selectedPath ? basename(selectedPath) : "");
    },
    [selectedPath],
  );

  const finishAction = useCallback(async () => {
    if (!pendingAction || busyAction) return;
    const name = draftName.trim();
    if (!name) {
      setActionError("Name is required");
      return;
    }
    setBusyAction(true);
    setActionError(null);
    try {
      if (pendingAction === "file") {
        const nextPath = joinPath(selectedDir, name);
        await invoke("fs_write_text", {
          workdir: cwd,
          path: nextPath,
          content: "",
          mode: "rewrite",
        });
        await loadChildren(selectedDir, { force: true });
        setProjectState((state) => ({ ...state, selectedPath: nextPath }));
      } else if (pendingAction === "folder") {
        const nextPath = joinPath(selectedDir, name);
        await invoke("fs_create_dir", {
          workdir: cwd,
          path: nextPath,
        });
        await loadChildren(selectedDir, { force: true });
        await loadChildren(nextPath);
        setProjectState((state) => ({
          ...state,
          selectedPath: nextPath,
          expanded: Array.from(new Set([...state.expanded, selectedDir, nextPath])),
        }));
      } else if (pendingAction === "rename" && selectedPath) {
        const parent = dirname(selectedPath);
        const nextPath = joinPath(parent, name);
        await invoke("fs_rename", {
          workdir: cwd,
          from_path: selectedPath,
          to_path: nextPath,
        });
        await loadChildren(parent, { force: true });
        setProjectState((state) => ({
          ...state,
          nodes: removeNodeSubtree(state.nodes, selectedPath),
          selectedPath: nextPath,
          expanded: state.expanded
            .filter((item) => item !== selectedPath && !item.startsWith(`${selectedPath}/`))
            .map((item) => (item.startsWith(`${selectedPath}/`) ? item.replace(selectedPath, nextPath) : item)),
        }));
      }
      setPendingAction(null);
      setDraftName("");
    } catch (error) {
      setActionError(toErrorMessage(error, "Action failed"));
    } finally {
      setBusyAction(false);
    }
  }, [
    busyAction,
    cwd,
    draftName,
    loadChildren,
    pendingAction,
    selectedDir,
    selectedPath,
    setProjectState,
  ]);

  const deleteSelected = useCallback(async () => {
    if (!selectedPath || busyAction) return;
    const confirmed = window.confirm(`Delete "${selectedPath}"?`);
    if (!confirmed) return;
    const parent = dirname(selectedPath);
    setBusyAction(true);
    setActionError(null);
    try {
      await invoke("fs_delete", { workdir: cwd, path: selectedPath });
      setProjectState((state) => ({
        ...state,
        nodes: removeNodeSubtree(state.nodes, selectedPath),
        selectedPath: parent,
        expanded: state.expanded.filter(
          (item) => item !== selectedPath && !item.startsWith(`${selectedPath}/`),
        ),
      }));
      await loadChildren(parent, { force: true });
    } catch (error) {
      setActionError(toErrorMessage(error, "Delete failed"));
    } finally {
      setBusyAction(false);
    }
  }, [busyAction, cwd, loadChildren, selectedPath, setProjectState]);

  const copySelectedPath = useCallback(() => {
    if (!selectedPath) return;
    void navigator.clipboard?.writeText(selectedPath).then(() => {
      setCopiedPath(selectedPath);
      window.setTimeout(() => setCopiedPath(""), 1200);
    });
  }, [selectedPath]);

  const renderNode = useCallback(
    (path: string, depth: number): React.ReactNode => {
      const node = state.nodes[path];
      if (!node) return null;
      const expanded = state.expanded.includes(path);
      const selected = state.selectedPath === path;
      return (
        <div key={path || "__root__"}>
          <div
            className={cn(
              "group flex h-7 items-center gap-1 rounded-md pr-2 text-xs text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              selected && "bg-muted text-foreground",
            )}
            style={{ paddingLeft: 6 + depth * 14 }}
          >
            {node.kind === "dir" ? (
              <button
                type="button"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-background"
                onClick={() => {
                  if (expanded) {
                    setProjectState((state) => ({
                      ...state,
                      expanded: state.expanded.filter((item) => item !== path),
                    }));
                  } else {
                    void loadChildren(path);
                  }
                }}
                title={expanded ? "Collapse" : "Expand"}
              >
                {node.loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ChevronRight
                    className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")}
                  />
                )}
              </button>
            ) : (
              <span className="h-5 w-5 shrink-0" />
            )}
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent p-0 text-left text-inherit"
              title={path || cwd}
              onClick={() => {
                setProjectState((state) => ({ ...state, selectedPath: path }));
              }}
              onDoubleClick={() => {
                if (node.kind !== "dir") return;
                if (expanded) {
                  setProjectState((state) => ({
                    ...state,
                    expanded: state.expanded.filter((item) => item !== path),
                  }));
                } else {
                  void loadChildren(path);
                }
              }}
            >
              {node.kind === "dir" ? (
                expanded ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                )
              ) : (
                <File className="h-3.5 w-3.5 shrink-0 text-sky-500" />
              )}
              <span className="min-w-0 truncate">{node.name}</span>
            </button>
          </div>
          {node.error ? <div className="px-3 py-1 text-[11px] text-amber-600">{node.error}</div> : null}
          {node.kind === "dir" && expanded
            ? node.children.map((childPath) => renderNode(childPath, depth + 1))
            : null}
        </div>
      );
    },
    [cwd, loadChildren, setProjectState, state],
  );

  const actionPlaceholder = useMemo(() => {
    if (pendingAction === "file") return "New file name";
    if (pendingAction === "folder") return "New folder name";
    if (pendingAction === "rename") return "New name";
    return "";
  }, [pendingAction]);

  if (!initialized) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
        <FolderOpen className="h-8 w-8 text-muted-foreground" />
        <Button
          onClick={() => {
            onInitializedChange(true);
            void loadChildren(ROOT_PATH, { force: true });
          }}
        >
          New File Tree
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search files"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          title="Refresh file tree"
          onClick={() => void loadChildren(ROOT_PATH, { force: true })}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-3 py-2">
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={!canMutate} onClick={() => startAction("file")}>
          <Plus className="h-3.5 w-3.5" />
          File
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={!canMutate} onClick={() => startAction("folder")}>
          <Folder className="h-3.5 w-3.5" />
          Folder
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={!hasSelection || !canMutate} onClick={() => startAction("rename")}>
          <Edit3 className="h-3.5 w-3.5" />
          Rename
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive" disabled={!hasSelection || !canMutate} onClick={() => void deleteSelected()}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={!selectedPath} onClick={copySelectedPath}>
          <Copy className="h-3.5 w-3.5" />
          {copiedPath === selectedPath ? "Copied" : "Path"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={!selectedPath || !onInsertFileMention}
          onClick={() => selectedPath && onInsertFileMention?.(selectedPath, selectedKind)}
        >
          @
        </Button>
      </div>

      {pendingAction ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void finishAction();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setPendingAction(null);
                setActionError(null);
              }
            }}
            placeholder={actionPlaceholder}
            className="h-8 text-xs"
          />
          <Button size="icon" variant="ghost" className="h-8 w-8 rounded-lg" disabled={busyAction} onClick={() => void finishAction()}>
            {busyAction ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 rounded-lg" onClick={() => setPendingAction(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {actionError}
        </div>
      ) : null}

      {query.trim() ? (
        <div className="max-h-40 shrink-0 overflow-auto border-b border-border/60 px-2 py-2">
          {searchLoading ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Searching...
            </div>
          ) : searchError ? (
            <div className="px-2 py-1 text-xs text-destructive">{searchError}</div>
          ) : searchResults.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">No matches</div>
          ) : (
            searchResults.map((entry) => (
              <button
                key={`${entry.kind}:${entry.path}`}
                type="button"
                className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                title={entry.path}
                onClick={() => void revealPath(entry.path, entry.kind)}
              >
                {entry.kind === "dir" ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : (
                  <File className="h-3.5 w-3.5 shrink-0 text-sky-500" />
                )}
                <span className="min-w-0 truncate">{entry.path}</span>
              </button>
            ))
          )}
          {searchTruncated ? (
            <div className="px-2 pt-1 text-[11px] text-muted-foreground">Results truncated</div>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {renderNode(ROOT_PATH, 0)}
      </div>
    </div>
  );
}
