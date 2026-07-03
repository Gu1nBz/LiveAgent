import { type ChatEntry, normalizeLiveUploadedFiles } from "@/lib/chatUi";
import type { ChatEvent } from "@/lib/gatewayTypes";
import type {
  ConversationStreamEvent,
  ConversationSubscribeResult,
  StreamRunActivity,
} from "@/lib/chat/stream/streamTypes";
import { readEventRunId, readEventSeq } from "@/lib/chat/stream/streamTypes";

import { alignHistory } from "./historyAlignment";
import { buildRowsFromEntries, buildTurnRows, dedupeRowKeys } from "./rows";
import {
  applyEventToTurn,
  createTurn,
  optimisticUserEntryId,
  rebuildTurnFromSnapshot,
  seededUserEntryId,
} from "./turnReducer";
import type {
  HistoryApplyMode,
  TranscriptRow,
  TranscriptSnapshot,
  Turn,
  UserChatEntry,
} from "./types";

// One transcript store per conversation, built on two structures:
//
//   historyEntries — the parsed persisted conversation (deterministic ids),
//                    always rendered first, inside the virtualized region
//   turns          — live exchanges, one Turn per run: a single user-bubble
//                    slot plus the run's assistant entries
//
// The snapshot is a single derived row list plus a fold boundary index; the
// virtualized region renders rows[0..foldedRowCount) and the live flow the
// rest. Because both regions are slices of one list built from one source,
// a prompt or reply can never render twice, and a turn's user bubble always
// precedes its assistant content. Completion is supersession: at the next
// run_started, settled turns just flip `folded` — row keys and objects never
// change, so the fold moves zero DOM identity.

export type { TranscriptSnapshot, TranscriptRow, Turn } from "./types";

export type TranscriptStore = {
  getSnapshot(): TranscriptSnapshot;
  subscribe(listener: () => void): () => void;
  // Stream plumbing.
  applySync(result: ConversationSubscribeResult): void;
  applyEvent(event: ConversationStreamEvent): void;
  // Optimistic local echo for a command this client is submitting. The
  // seeded user_message binds the turn by client_request_id — the bubble
  // keeps its id and never remounts.
  addOptimisticUserEntry(params: {
    clientRequestId: string;
    text: string;
    attachments?: UserChatEntry["attachments"];
  }): void;
  removeOptimisticUserEntry(clientRequestId: string): void;
  // Failure surfaced outside the stream (command never bound).
  appendLocalError(message: string): void;
  // History application: "replace" for full (re)loads, "enrich" for the
  // idle quiet refresh (messageRef / full tool payload upgrades).
  applyHistorySnapshot(entries: ChatEntry[], options?: { mode?: HistoryApplyMode }): void;
  // Fold the settled turns outside of run_started (conversation switched
  // away; keeps the next mount clean).
  foldSettledTurns(): void;
  flush(): void;
};

const EMPTY_SNAPSHOT: TranscriptSnapshot = {
  foldedRows: [],
  liveRows: [],
  activeTurnKey: null,
  entryCount: 0,
  activeRun: null,
  toolStatus: null,
  toolStatusIsCompaction: false,
  foldRevision: 0,
  revision: 0,
};

function readEventClientRequestId(event: ConversationStreamEvent): string {
  const value = (event as { client_request_id?: unknown }).client_request_id;
  return typeof value === "string" ? value.trim() : "";
}

export function createTranscriptStore(options?: {
  // A stray run_finished arrived for a non-active run while a run is
  // streaming: the local view of the run topology diverged from the gateway
  // log. Fired at most once per applied sync so the app layer can trigger a
  // resubscribe (which re-arms the signal).
  onDivergence?: () => void;
}): TranscriptStore {
  let historyEntries: ChatEntry[] = [];
  let turns: Turn[] = [];
  let activeRun: StreamRunActivity | null = null;
  let toolStatus: string | null = null;
  let toolStatusIsCompaction = false;
  let foldRevision = 0;
  let localTurnSeq = 0;
  // Idempotency cursor: the highest log seq already applied. Re-subscribe
  // replays and snapshot+replay overlaps are dropped below it.
  let lastSeq = 0;
  // Debounces onDivergence: one signal per applied sync (reset in applySync),
  // and never twice from the same stream position across syncs.
  let divergenceSignaled = false;
  let lastDivergenceSeq = -1;

  let snapshot = EMPTY_SNAPSHOT;
  let dirty = false;
  let rafId: number | null = null;
  const listeners = new Set<() => void>();

  // Row caches: history rows rebuild only when the history region changes;
  // turn rows rebuild only for the turn object that changed (turns are
  // immutable-updated, so a token delta re-derives one turn's rows per
  // commit, not the whole transcript). The assembled folded-region array is
  // additionally cached by identity so the virtualized region's props stay
  // referentially stable across streaming commits.
  let historyRowsCache: { entries: ChatEntry[]; rows: TranscriptRow[] } | null = null;
  const turnRowsCache = new WeakMap<Turn, TranscriptRow[]>();
  let foldedRowsCache: {
    historyEntries: ChatEntry[];
    foldedTurns: Turn[];
    rows: TranscriptRow[];
  } | null = null;

  const historyRows = (): TranscriptRow[] => {
    if (historyRowsCache?.entries !== historyEntries) {
      historyRowsCache = {
        entries: historyEntries,
        rows: buildRowsFromEntries(historyEntries, "history"),
      };
    }
    return historyRowsCache.rows;
  };

  const rowsForTurn = (turn: Turn): TranscriptRow[] => {
    let rows = turnRowsCache.get(turn);
    if (!rows) {
      rows = buildTurnRows(turn);
      turnRowsCache.set(turn, rows);
    }
    return rows;
  };

  const findTurnByCri = (clientRequestId: string): Turn | null => {
    if (!clientRequestId) return null;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn && turn.clientRequestId === clientRequestId) {
        return turn;
      }
    }
    return null;
  };

  const findTurnByRunId = (runId: string): Turn | null => {
    if (!runId) return null;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn && turn.runId === runId) {
        return turn;
      }
    }
    return null;
  };

  const findStreamingTurn = (): Turn | null => {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn && turn.phase === "streaming") {
        return turn;
      }
    }
    return null;
  };

  const replaceTurn = (previous: Turn, next: Turn) => {
    if (previous === next) return;
    turns = turns.map((turn) => (turn === previous ? next : turn));
  };

  // Binds a turn to its run. If a separate turn already exists for that run
  // (a seeded `run:` turn created before the ownership was known), the two
  // describe the same exchange: absorb its content into `turn` — the user
  // bubble's identity always wins — and drop the duplicate.
  const adoptRun = (turn: Turn, runId: string): Turn => {
    if (!runId || turn.runId === runId) {
      return turn;
    }
    const existing = findTurnByRunId(runId);
    let next: Turn = { ...turn, runId };
    if (existing && existing !== turn) {
      const ownIds = new Set(next.entries.map((entry) => entry.id));
      const absorbed = existing.entries.filter((entry) => !ownIds.has(entry.id));
      next = {
        ...next,
        user: next.user ?? existing.user,
        entries: absorbed.length ? [...next.entries, ...absorbed] : next.entries,
        phase: existing.phase === "streaming" ? "streaming" : next.phase,
      };
      turns = turns.filter((candidate) => candidate !== existing);
    }
    return next;
  };

  const buildSnapshot = (): TranscriptSnapshot => {
    const activeTurn = findStreamingTurn();
    // Partition, not prefix: a folded turn can sit after a still-pending one
    // in creation order (a foreign run completing while this client's prompt
    // waits), and its rows must still land in the virtualized region.
    const foldedTurns: Turn[] = [];
    const unfoldedTurns: Turn[] = [];
    let entryCount = historyEntries.length;
    for (const turn of turns) {
      (turn.folded ? foldedTurns : unfoldedTurns).push(turn);
      entryCount += turn.entries.length + (turn.user ? 1 : 0);
    }

    const cacheValid =
      foldedRowsCache !== null &&
      foldedRowsCache.historyEntries === historyEntries &&
      foldedRowsCache.foldedTurns.length === foldedTurns.length &&
      foldedRowsCache.foldedTurns.every((turn, index) => turn === foldedTurns[index]);
    let foldedRows: TranscriptRow[];
    if (cacheValid && foldedRowsCache) {
      foldedRows = foldedRowsCache.rows;
    } else {
      foldedRows = dedupeRowKeys([
        ...historyRows(),
        ...foldedTurns.flatMap((turn) => rowsForTurn(turn)),
      ]);
      foldedRowsCache = { historyEntries, foldedTurns, rows: foldedRows };
    }

    const seenKeys = new Set(foldedRows.map((row) => row.key));
    const liveRows = dedupeRowKeys(
      unfoldedTurns.flatMap((turn) => rowsForTurn(turn)),
      seenKeys,
    );

    return {
      foldedRows,
      liveRows,
      activeTurnKey: activeTurn?.key ?? null,
      entryCount,
      activeRun,
      toolStatus,
      toolStatusIsCompaction,
      foldRevision,
      revision: snapshot.revision + 1,
    };
  };

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const commit = () => {
    rafId = null;
    if (!dirty) {
      return;
    }
    dirty = false;
    snapshot = buildSnapshot();
    emit();
  };
  // While a batch is open (applySync), schedule() only marks dirty: the
  // snapshot rebuild and the event replay must land as ONE commit, never an
  // intermediate frame at the (older) snapshot state.
  let batchDepth = 0;
  const schedule = (flush?: boolean) => {
    dirty = true;
    if (batchDepth > 0) {
      return;
    }
    if (flush) {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      commit();
      return;
    }
    if (rafId === null && typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(commit);
    } else if (typeof requestAnimationFrame !== "function") {
      commit();
    }
  };

  // Folding flips flags only: every settled turn moves into the virtualized
  // region with identical rows. `settleStreaming` additionally retires a
  // still-streaming turn whose run is being superseded by a new run_started.
  const foldSettled = (settleStreaming: boolean): boolean => {
    let changed = false;
    const next = turns.map((turn) => {
      if (turn.phase === "settled" && !turn.folded) {
        changed = true;
        return { ...turn, folded: true };
      }
      if (settleStreaming && turn.phase === "streaming") {
        changed = true;
        return { ...turn, phase: "settled" as const, folded: true };
      }
      return turn;
    });
    if (changed) {
      turns = next;
      foldRevision += 1;
    }
    return changed;
  };

  const setToolStatus = (status: string | null, isCompaction: boolean, flush?: boolean) => {
    const next = status && status.trim() ? status.trim() : null;
    const nextCompaction = Boolean(next) && isCompaction;
    if (toolStatus === next && toolStatusIsCompaction === nextCompaction) {
      return;
    }
    toolStatus = next;
    toolStatusIsCompaction = nextCompaction;
    schedule(flush);
  };

  const applyUserMessage = (event: ConversationStreamEvent, runId: string) => {
    const payload = event as { message?: unknown; uploaded_files?: unknown };
    const clientRequestId = readEventClientRequestId(event);
    const text = typeof payload.message === "string" ? payload.message : "";
    const attachments = normalizeLiveUploadedFiles(payload.uploaded_files);
    if (!text.trim() && attachments.length === 0) {
      return;
    }

    // (1) Our own submission: bind the optimistic turn to its run. The user
    // slot is already filled — the bubble keeps its id, nothing remounts.
    const ownTurn = findTurnByCri(clientRequestId);
    if (ownTurn) {
      let next = adoptRun(ownTurn, runId);
      if (!next.user) {
        next = {
          ...next,
          user: { id: optimisticUserEntryId(clientRequestId), kind: "user", text, attachments },
        };
      }
      if (next !== ownTurn) {
        replaceTurn(ownTurn, next);
        schedule(true);
      }
      return;
    }

    // (2) The run already has a turn: fill the single user slot iff empty.
    const runTurn = findTurnByRunId(runId);
    if (runTurn) {
      if (!runTurn.user) {
        replaceTurn(runTurn, {
          ...runTurn,
          user: { id: seededUserEntryId(runId), kind: "user", text, attachments },
        });
        schedule(true);
      }
      return;
    }

    // (3) Foreign/seeded turn (another viewer's command, replay).
    const seq = readEventSeq(event);
    turns = [
      ...turns,
      {
        ...createTurn({
          key: runId ? `run:${runId}` : `run:seed-${seq}`,
          runId,
          clientRequestId,
          phase: activeRun?.runId === runId && runId !== "" ? "streaming" : "pending",
        }),
        user: {
          id: runId ? seededUserEntryId(runId) : `r:seed-${seq}:u`,
          kind: "user",
          text,
          attachments,
        },
      },
    ];
    schedule(true);
  };

  const applyDelta = (event: ConversationStreamEvent, runId: string) => {
    if (event.type === "user_message") {
      applyUserMessage(event, runId);
      return;
    }
    let turn = findTurnByRunId(runId) ?? (runId === "" ? findStreamingTurn() : null);
    if (!turn && runId === "") {
      // Reuse the trailing orphan turn so run-less deltas coalesce into one
      // exchange instead of fragmenting into a turn per event.
      const last = turns[turns.length - 1];
      if (last && last.key.startsWith("run:orphan") && !last.folded) {
        turn = last;
      }
    }
    if (!turn) {
      // Content for a run the store never saw start (defensive).
      const seq = readEventSeq(event);
      turn = createTurn({
        key: runId ? `run:${runId}` : `run:orphan-${seq}`,
        runId,
        phase: activeRun?.runId === runId && runId !== "" ? "streaming" : "settled",
      });
      turns = [...turns, turn];
    }
    const next = applyEventToTurn(turn, event as ChatEvent);
    if (next !== turn) {
      replaceTurn(turn, next);
      schedule(false);
    }
  };

  const rebuildActiveTurnFromSnapshot = (entriesJson: string, runId: string) => {
    const parsed = parseSnapshotEntries(entriesJson);
    let turn =
      findTurnByRunId(runId) ??
      (activeRun?.clientRequestId ? findTurnByCri(activeRun.clientRequestId) : null);
    if (!turn) {
      if (parsed.length === 0) {
        return;
      }
      turn = createTurn({ key: `run:${runId}`, runId, phase: "streaming" });
      turns = [...turns, turn];
    }
    let next = adoptRun(turn, runId);
    next = rebuildTurnFromSnapshot(next, parsed);
    if (next.phase !== "streaming" || next.folded) {
      next = { ...next, phase: "streaming", folded: false };
    }
    replaceTurn(turn, next);
    schedule(true);
  };

  const applyRunFinished = (event: ConversationStreamEvent) => {
    const runId = readEventRunId(event);
    if (activeRun && runId !== "" && runId !== activeRun.runId) {
      // Stray terminal for a non-active run (the gateway appends these
      // deliberately, e.g. failing a superseded queued run). Never settle
      // the active turn; just drop the stray run's turn.
      const stray = findTurnByRunId(runId);
      if (stray && !stray.folded) {
        turns = turns.filter((turn) => turn !== stray);
        schedule(true);
      }
      // The active run may itself be a zombie (its own run_finished was
      // lost); let the app resync this conversation to converge. The seq
      // guard stops a resync loop when a reset replay re-delivers the same
      // stray on every subscribe.
      if (!divergenceSignaled && lastSeq !== lastDivergenceSeq) {
        divergenceSignaled = true;
        lastDivergenceSeq = lastSeq;
        options?.onDivergence?.();
      }
      return;
    }
    const payload = event as { status?: string; message?: string; reason?: string };
    let turn = findTurnByRunId(runId) ?? findStreamingTurn();
    if (payload.status === "failed" && payload.message && payload.reason !== "superseded") {
      if (!turn) {
        turn = createTurn({ key: `run:${runId || `finished-${readEventSeq(event)}`}`, runId });
        turns = [...turns, turn];
      }
      const withError = applyEventToTurn(turn, {
        type: "error",
        message: payload.message,
      } as ChatEvent);
      replaceTurn(turn, withError);
      turn = withError;
    }
    if (turn && turn.phase !== "settled") {
      replaceTurn(turn, { ...turn, phase: "settled" });
    }
    activeRun = null;
    setToolStatus(null, false);
    schedule(true);
  };

  // edit_resend: truncate the transcript at the edited user message. The new
  // user_message (binding the optimistic turn) follows in the stream.
  const applyRebased = (event: ConversationStreamEvent) => {
    const ref = (event as { base_message_ref?: unknown }).base_message_ref;
    if (!ref || typeof ref !== "object") {
      return;
    }
    const refValue = ref as Record<string, unknown>;
    const messageId = typeof refValue.message_id === "string" ? refValue.message_id.trim() : "";
    const contentHash =
      typeof refValue.content_hash === "string" ? refValue.content_hash.trim() : "";
    if (!messageId && !contentHash) {
      return;
    }
    // Prefer the exact message id; the content hash is only a fallback for
    // refs without one — matching on it eagerly would truncate at the FIRST
    // occurrence of a re-sent identical prompt.
    const matchesRef = (user: UserChatEntry | null) => {
      if (!user?.messageRef) {
        return false;
      }
      if (messageId !== "") {
        return user.messageRef.messageId === messageId;
      }
      return contentHash !== "" && user.messageRef.contentHash === contentHash;
    };

    const turnIndex = turns.findIndex((turn) => matchesRef(turn.user));
    if (turnIndex >= 0) {
      turns = [
        ...turns.slice(0, turnIndex),
        ...turns.slice(turnIndex).filter((turn) => turn.phase === "pending"),
      ];
      schedule(true);
      return;
    }

    const entryIndex = historyEntries.findIndex(
      (entry) => entry.kind === "user" && matchesRef(entry),
    );
    if (entryIndex < 0) {
      return;
    }
    historyEntries = historyEntries.slice(0, entryIndex);
    turns = turns.filter((turn) => turn.phase === "pending");
    schedule(true);
  };

  function applyOne(event: ConversationStreamEvent) {
    const seq = readEventSeq(event);
    if (seq > 0) {
      if (seq <= lastSeq) {
        // Already applied (resubscribe replay / snapshot overlap).
        return;
      }
      lastSeq = seq;
    }
    const runId = readEventRunId(event);
    switch (event.type) {
      case "run_started": {
        // Fold the previous exchange into the virtualized region in the same
        // commit that renders the new run — the one intentional layout change.
        foldSettled(true);
        const clientRequestId = readEventClientRequestId(event);
        let turn = findTurnByCri(clientRequestId) ?? findTurnByRunId(runId);
        if (!turn) {
          turn = createTurn({ key: `run:${runId}`, runId, clientRequestId });
          turns = [...turns, turn];
        }
        const bound = adoptRun(turn, runId);
        replaceTurn(turn, {
          ...bound,
          phase: "streaming",
          folded: false,
        });
        activeRun = {
          runId,
          state: "running",
          startedSeq: seq,
          toolStatus: null,
          toolStatusIsCompaction: false,
          clientRequestId: clientRequestId || undefined,
          updatedAt: Date.now(),
        };
        setToolStatus(null, false, true);
        schedule(true);
        return;
      }
      case "run_finished": {
        applyRunFinished(event);
        return;
      }
      case "run_queued": {
        // The prompt went into the desktop queue: drop its turn (user bubble
        // and provisional entries); the queue panel shows it instead.
        const turn = findTurnByRunId(runId) ?? findTurnByCri(readEventClientRequestId(event));
        if (turn && !turn.folded) {
          turns = turns.filter((candidate) => candidate !== turn);
          schedule(true);
        }
        if (activeRun?.runId === runId) {
          activeRun = null;
          schedule(true);
        }
        return;
      }
      case "rebased": {
        applyRebased(event);
        return;
      }
      case "snapshot": {
        const payload = event as { entries_json?: string; as_of_seq?: number };
        const asOfSeq =
          typeof payload.as_of_seq === "number" && Number.isFinite(payload.as_of_seq)
            ? Math.floor(payload.as_of_seq)
            : 0;
        if (asOfSeq > 0 && asOfSeq <= lastSeq) {
          // Snapshot events carry no seq of their own; a replayed one that
          // covers less of the log than we already applied must not roll the
          // active turn back to an older state.
          return;
        }
        rebuildActiveTurnFromSnapshot(payload.entries_json ?? "", runId);
        if (asOfSeq > 0) {
          // The snapshot content covers the log through as_of_seq; drop the
          // overlapping tail of any concurrent replay.
          lastSeq = Math.max(lastSeq, asOfSeq);
        }
        const status = (event as { tool_status?: string | null }).tool_status ?? null;
        setToolStatus(
          typeof status === "string" ? status : null,
          (event as { tool_status_is_compaction?: boolean }).tool_status_is_compaction === true,
          true,
        );
        return;
      }
      case "tool_status": {
        const status = (event as { status?: string | null }).status ?? null;
        setToolStatus(
          typeof status === "string" ? status : null,
          (event as { isCompaction?: boolean }).isCompaction === true,
        );
        if (activeRun && activeRun.runId === runId) {
          activeRun = { ...activeRun, toolStatus, toolStatusIsCompaction };
        }
        return;
      }
      default: {
        applyDelta(event, runId);
      }
    }
  }

  const applySyncLocked = (result: ConversationSubscribeResult) => {
    // A completed (re)subscribe is the convergence point: re-arm the
    // divergence signal so a later stray burst can trigger another resync.
    divergenceSignaled = false;
    if (result.reset) {
      // Seq continuity broke (gateway restart / buffer gap). Folded and
      // settled turns hold finished content with stable ids — fold, never
      // drop. A streaming turn's content is rebuilt from the snapshot and
      // replay, but the turn object (and its user bubble) survives, so the
      // active exchange never remounts. Pending turns — optimistic echoes
      // whose run hasn't started — survive untouched and bind normally
      // when their seed replays.
      lastSeq = 0;
      let changed = false;
      turns = turns.map((turn) => {
        if (turn.phase === "settled" && !turn.folded) {
          changed = true;
          return { ...turn, folded: true };
        }
        if (turn.phase === "streaming") {
          changed = true;
          if (result.activity && result.activity.runId === turn.runId) {
            // Still running server-side: the snapshot/replay rebuilds the
            // content into this same turn object. When the incoming snapshot
            // targets this run, keep the delta-built entries so the rebuild
            // can compare per-tool-call progress instead of starting blind.
            return result.snapshot?.runId === turn.runId ? turn : { ...turn, entries: [] };
          }
          // The run ended while this client was away and the replay may
          // not cover it any more: settle the turn (never strand it as a
          // pending zombie) so the idle enrich can adopt its persisted
          // reply from history.
          return { ...turn, entries: [], phase: "settled" as const };
        }
        return turn;
      });
      if (changed) {
        foldRevision += 1;
      }
      toolStatus = null;
      toolStatusIsCompaction = false;
      // Set the activity before the rebuild so the snapshot can target the
      // optimistic pending turn by client_request_id (its user bubble then
      // keeps its identity instead of a duplicate run turn appearing).
      activeRun = result.activity;
      if (result.snapshot) {
        rebuildActiveTurnFromSnapshot(result.snapshot.entriesJson, result.snapshot.runId);
        lastSeq = Math.max(lastSeq, result.snapshot.asOfSeq);
      }
    } else {
      activeRun = result.activity;
      if (result.snapshot) {
        // Late join mid-run where the buffer cannot cover the run start.
        // The snapshot folds every event through asOfSeq into its entries;
        // advancing the cursor drops the overlapping replay below.
        const existing = findTurnByRunId(result.snapshot.runId);
        if (!existing || existing.entries.length === 0) {
          rebuildActiveTurnFromSnapshot(result.snapshot.entriesJson, result.snapshot.runId);
          lastSeq = Math.max(lastSeq, result.snapshot.asOfSeq);
        }
      }
    }
    if (result.activity) {
      setToolStatus(result.activity.toolStatus, result.activity.toolStatusIsCompaction);
    } else if (result.reset) {
      setToolStatus(null, false);
    }
    for (const event of result.events) {
      applyOne(event);
    }
    lastSeq = Math.max(lastSeq, result.latestSeq);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    // The rebuild + replay of a (re)subscribe commits as one frame: an
    // intermediate render at the snapshot's older state is exactly the
    // backwards flicker the progress guards exist to prevent.
    applySync: (result) => {
      batchDepth += 1;
      try {
        applySyncLocked(result);
      } finally {
        batchDepth -= 1;
      }
      schedule(true);
    },

    applyEvent: (event) => {
      applyOne(event);
    },

    addOptimisticUserEntry: ({ clientRequestId, text, attachments }) => {
      if (findTurnByCri(clientRequestId)) {
        return;
      }
      turns = [
        ...turns,
        {
          ...createTurn({ key: `req:${clientRequestId}`, clientRequestId, phase: "pending" }),
          user: {
            id: optimisticUserEntryId(clientRequestId),
            kind: "user",
            text,
            attachments: attachments ?? [],
          },
        },
      ];
      schedule(true);
    },

    removeOptimisticUserEntry: (clientRequestId) => {
      const turn = findTurnByCri(clientRequestId);
      if (!turn || turn.folded) {
        return;
      }
      if (turn.entries.length === 0) {
        turns = turns.filter((candidate) => candidate !== turn);
      } else if (turn.user) {
        // Keep the run's content but settle a headless pending turn — it can
        // never bind again, and a lingering pending turn would block the
        // idle history enrich.
        replaceTurn(turn, {
          ...turn,
          user: null,
          phase: turn.phase === "streaming" ? turn.phase : "settled",
        });
      } else {
        return;
      }
      schedule(true);
    },

    appendLocalError: (message) => {
      const alreadyShown = turns.some(
        (turn) =>
          !turn.folded &&
          turn.entries.some(
            (entry) =>
              (entry.kind === "assistant" || entry.kind === "error") &&
              entry.text.trim() === message.trim(),
          ),
      );
      if (alreadyShown) {
        return;
      }
      const turn = createTurn({ key: `local:${localTurnSeq++}`, phase: "settled" });
      const withError = applyEventToTurn(turn, { type: "error", message } as ChatEvent);
      if (withError.entries.length === 0) {
        return;
      }
      turns = [...turns, withError];
      schedule(true);
    },

    applyHistorySnapshot: (entries, options) => {
      const result = alignHistory({
        historyEntries,
        turns,
        entries,
        mode: options?.mode ?? "enrich",
      });
      if (!result.changed) {
        return;
      }
      historyEntries = result.historyEntries;
      turns = result.turns;
      schedule(true);
    },

    foldSettledTurns: () => {
      if (foldSettled(false)) {
        schedule(true);
      }
    },

    flush: () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      commit();
    },
  };
}

function isSnapshotChatEntry(value: unknown): value is ChatEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.kind !== "string") {
    return false;
  }
  switch (v.kind) {
    case "user":
      return typeof v.text === "string" && Array.isArray(v.attachments);
    case "assistant":
    case "thinking":
    case "error":
      return typeof v.text === "string";
    case "tool_call":
      return v.toolCall != null && typeof v.toolCall === "object";
    case "tool_result":
      return v.toolResult != null && typeof v.toolResult === "object";
    case "hosted_search":
      return v.hostedSearch != null && typeof v.hostedSearch === "object";
    default:
      return false;
  }
}

function parseSnapshotEntries(json: string | undefined): ChatEntry[] {
  const raw = typeof json === "string" ? json.trim() : "";
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSnapshotChatEntry) : [];
  } catch {
    return [];
  }
}
