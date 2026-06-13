import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/i18n";
import { cn } from "@/lib/shared/utils";
import type { TerminalClient, TerminalSession } from "@/lib/terminal/types";
import { AlertTriangle, RefreshCw, Terminal, Wifi, WifiOff, X } from "../icons";
import { XTermViewport } from "../project-tools/XTermViewport";

export type WorkspaceSshTerminalOpenRequest = {
  id: number;
  sessionId: string;
};

type WorkspaceSshTerminalOverlayProps = {
  openRequest: WorkspaceSshTerminalOpenRequest | null;
  sessions: TerminalSession[];
  client: TerminalClient;
  theme: "light" | "dark";
  isOpen: boolean;
  onHide: () => void;
};

const SSH_TERMINAL_OVERLAY_ANIMATION_MS = 180;

function sshSessionStatus(session: TerminalSession) {
  const status = session.ssh?.status ?? (session.running ? "connected" : "disconnected");
  if (status === "connected" && !session.running) return "disconnected";
  return status;
}

function sshStatusLabel(session: TerminalSession, t: (key: string) => string) {
  const status = sshSessionStatus(session);
  if (status === "reconnecting") {
    const attempt = Math.max(1, Number(session.ssh?.reconnectAttempt ?? 1));
    const max = Math.max(attempt, Number(session.ssh?.reconnectMaxAttempts ?? 3));
    return t("workspaceSshTerminal.reconnecting")
      .replace("{attempt}", String(attempt))
      .replace("{max}", String(max));
  }
  if (status === "disconnected") return t("workspaceSshTerminal.disconnected");
  return t("workspaceSshTerminal.connected");
}

function sessionTitle(session: TerminalSession, fallback: string) {
  return session.title || session.ssh?.hostName || fallback;
}

function sessionEndpointLabel(session: TerminalSession) {
  const ssh = session.ssh;
  if (!ssh) return session.cwd || session.projectPathKey;
  const userPrefix = ssh.username.trim() ? `${ssh.username.trim()}@` : "";
  return `${userPrefix}${ssh.host}:${ssh.port}`;
}

function statusDotClassName(session: TerminalSession) {
  const status = sshSessionStatus(session);
  if (status === "connected") return "bg-emerald-500";
  if (status === "reconnecting") return "bg-amber-500";
  return "bg-destructive";
}

function statusIcon(session: TerminalSession) {
  const status = sshSessionStatus(session);
  if (status === "connected") return <Wifi className="h-3.5 w-3.5 text-emerald-600" />;
  if (status === "reconnecting") {
    return <RefreshCw className="h-3.5 w-3.5 animate-spin text-amber-600" />;
  }
  return <WifiOff className="h-3.5 w-3.5 text-destructive" />;
}

export function WorkspaceSshTerminalOverlay(props: WorkspaceSshTerminalOverlayProps) {
  const { openRequest, sessions, client, theme, isOpen, onHide } = props;
  const { t } = useLocale();
  const [isVisible, setIsVisible] = useState(isOpen);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const openRequestIdRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const sshSessions = useMemo(
    () => sessions.filter((session) => session.kind === "ssh" && session.ssh),
    [sessions],
  );
  const sessionsById = useMemo(
    () => new Map(sshSessions.map((session) => [session.id, session])),
    [sshSessions],
  );
  const openSessions = useMemo(
    () =>
      openSessionIds
        .map((sessionId) => sessionsById.get(sessionId))
        .filter((session): session is TerminalSession => Boolean(session)),
    [openSessionIds, sessionsById],
  );
  const activeSession =
    openSessions.find((session) => session.id === activeSessionId) ?? openSessions[0] ?? null;

  const cancelPendingHide = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const hideOverlay = useCallback(() => {
    cancelPendingHide();
    setIsVisible(false);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      onHide();
    }, SSH_TERMINAL_OVERLAY_ANIMATION_MS);
  }, [cancelPendingHide, onHide]);

  const closeTab = useCallback((sessionId: string) => {
    setOpenSessionIds((current) => {
      const index = current.indexOf(sessionId);
      if (index < 0) return current;
      const next = current.filter((id) => id !== sessionId);
      setActiveSessionId((currentActive) => {
        if (currentActive !== sessionId) return currentActive;
        return next[Math.min(index, next.length - 1)] ?? "";
      });
      return next;
    });
  }, []);

  useEffect(() => {
    if (!openRequest || openRequestIdRef.current === openRequest.id) return;
    const session = sessionsById.get(openRequest.sessionId);
    if (!session) return;
    openRequestIdRef.current = openRequest.id;
    cancelPendingHide();
    setIsVisible(true);
    setError(null);
    setOpenSessionIds((current) =>
      current.includes(session.id) ? current : [...current, session.id],
    );
    setActiveSessionId(session.id);
  }, [cancelPendingHide, openRequest, sessionsById]);

  useEffect(() => {
    if (isOpen) {
      cancelPendingHide();
      setIsVisible(true);
      return;
    }
    setIsVisible(false);
  }, [cancelPendingHide, isOpen]);

  useEffect(() => {
    const liveIds = new Set(sshSessions.map((session) => session.id));
    setOpenSessionIds((current) => {
      const next = current.filter((sessionId) => liveIds.has(sessionId));
      return next.length === current.length ? current : next;
    });
  }, [sshSessions]);

  useEffect(() => {
    if (activeSessionId && openSessions.some((session) => session.id === activeSessionId)) return;
    setActiveSessionId(openSessions[0]?.id ?? "");
  }, [activeSessionId, openSessions]);

  useEffect(
    () => () => {
      cancelPendingHide();
    },
    [cancelPendingHide],
  );

  return (
    <div
      className={cn(
        "workspace-ssh-terminal-overlay absolute inset-0 z-40 flex min-h-0 min-w-0 transform-gpu flex-col overflow-hidden border-r border-border bg-background transition-[opacity,transform,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        isVisible
          ? "pointer-events-auto translate-x-0 opacity-100 shadow-2xl"
          : "pointer-events-none -translate-x-2 opacity-0 shadow-lg",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/45 px-3">
        <Terminal className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">
            {t("workspaceSshTerminal.title")}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {activeSession
              ? sessionEndpointLabel(activeSession)
              : t("workspaceSshTerminal.empty")}
          </div>
        </div>
        {activeSession ? (
          <div className="hidden shrink-0 items-center gap-1.5 rounded-md bg-background/70 px-2 py-1 text-[11px] text-muted-foreground sm:flex">
            {statusIcon(activeSession)}
            <span>{sshStatusLabel(activeSession, t)}</span>
          </div>
        ) : null}
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={t("workspaceSshTerminal.close")}
          aria-label={t("workspaceSshTerminal.close")}
          onClick={hideOverlay}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-background px-2 pt-1">
        {openSessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={cn(
              "group flex h-8 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-xs transition-colors",
              session.id === activeSessionId
                ? "border-border bg-muted text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            title={sessionEndpointLabel(session)}
            onClick={() => setActiveSessionId(session.id)}
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClassName(session))} />
            <Terminal className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {sessionTitle(session, t("workspaceSshTerminal.title"))}
            </span>
            <span
              role="button"
              tabIndex={0}
              className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/75 hover:bg-background hover:text-foreground"
              title={t("workspaceSshTerminal.closeTab")}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(session.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                closeTab(session.id);
              }}
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        ))}
      </div>

      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 truncate">{error}</div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-background">
        {openSessions.length > 0 ? (
          openSessions.map((session) => {
            const isActiveTerminal = isVisible && isOpen && activeSessionId === session.id;
            return (
              <div
                key={session.id}
                aria-hidden={!isActiveTerminal}
                className={cn("absolute inset-0 min-h-0", isActiveTerminal ? "block" : "hidden")}
              >
                <XTermViewport
                  client={client}
                  session={session}
                  theme={theme}
                  isActive={isActiveTerminal}
                  onError={setError}
                />
              </div>
            );
          })
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/70">
              <Terminal className="h-5 w-5" />
            </div>
            <div>{t("workspaceSshTerminal.empty")}</div>
          </div>
        )}
      </div>
    </div>
  );
}
