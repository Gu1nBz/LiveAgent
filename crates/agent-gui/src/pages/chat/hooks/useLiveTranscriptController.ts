import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { createCompactionThrottleState } from "../../../lib/chat/compaction/contextCompaction";
import {
  cloneLiveRoundSnapshots,
  type LiveRoundSnapshot,
} from "../../../lib/chat/conversation/chatAbort";
import {
  createLiveTranscriptStore,
  type LiveTranscriptStore,
} from "../../../lib/chat/conversation/liveTranscriptStore";
import type { LiveRound } from "../../../lib/chat/messages/uiMessages";
import { resolveScrollViewport } from "../utils/chatScrollViewport";
import {
  decidePointerReleaseAction,
  decideScrollFollowAction,
  isAtBottom,
  isDominantVerticalWheel,
} from "../utils/scrollFollowPolicy";

const SCROLL_OVERFLOW_THRESHOLD_PX = 4;
const STREAM_AUTO_SCROLL_INTERVAL_MS = 80;
const STREAM_INPUT_BUSY_INTERVAL_MS = 160;
const USER_SCROLL_INTENT_WINDOW_MS = 500;
const BOTTOM_LOCK_DURATION_MS = 700;
// Bottom gaps beyond this are layout jumps (live→committed swap, virtualizer
// estimate corrections, late image/highlight layout), not streaming growth,
// and must be re-pinned before paint instead of waiting for the throttled rAF.
const CONTENT_JUMP_REPIN_THRESHOLD_PX = 64;
const VIEWPORT_ATTACH_RETRY_MS = 80;
const VIEWPORT_ATTACH_MAX_ATTEMPTS = 75;
const LIVE_TRANSCRIPT_RAF_FALLBACK_MS = 96;
const LIVE_TRANSCRIPT_BACKGROUND_BATCH_MS = 160;

function shouldUseLiveTranscriptAnimationFrame() {
  return (
    typeof globalThis.requestAnimationFrame === "function" &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  );
}

export function scheduleLiveTranscriptFlush(callback: () => void) {
  let frameId: number | null = null;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let finished = false;

  const run = () => {
    if (finished) return;
    finished = true;
    if (frameId !== null && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null && typeof globalThis.clearTimeout === "function") {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
    callback();
  };

  const useFrame = shouldUseLiveTranscriptAnimationFrame();
  if (useFrame) {
    frameId = globalThis.requestAnimationFrame(run);
  }

  if (typeof globalThis.setTimeout === "function") {
    timeoutId = globalThis.setTimeout(
      run,
      useFrame ? LIVE_TRANSCRIPT_RAF_FALLBACK_MS : LIVE_TRANSCRIPT_BACKGROUND_BATCH_MS,
    );
  } else if (!useFrame && typeof queueMicrotask === "function") {
    queueMicrotask(run);
  }

  return () => {
    if (finished) return;
    finished = true;
    if (frameId !== null && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null && typeof globalThis.clearTimeout === "function") {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}

function getViewportBottomGap(viewport: HTMLDivElement) {
  return Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
}

function isViewportAtLatest(viewport: HTMLDivElement) {
  return isAtBottom(getViewportBottomGap(viewport));
}

function hasViewportOverflow(viewport: HTMLDivElement) {
  return viewport.scrollHeight - viewport.clientHeight > SCROLL_OVERFLOW_THRESHOLD_PX;
}

function isEditableEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function isHistoryScrollKey(event: KeyboardEvent) {
  if (isEditableEventTarget(event.target)) {
    return false;
  }
  return (
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey)
  );
}

function isFollowScrollKey(event: KeyboardEvent) {
  if (isEditableEventTarget(event.target)) {
    return false;
  }
  return (
    event.key === "ArrowDown" ||
    event.key === "PageDown" ||
    event.key === "End" ||
    (event.key === " " && !event.shiftKey)
  );
}

type UseLiveTranscriptControllerParams = {
  currentConversationId: string;
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  composerBusyRef: MutableRefObject<boolean>;
};

type AbortSnapshot = {
  draftAssistantText: string;
  liveRounds: LiveRoundSnapshot[];
};

type LiveTranscriptArtifacts = {
  store: LiveTranscriptStore;
  pendingDraftDelta: string;
  draftFlushCancel: (() => void) | null;
  draftShouldAutoScroll: boolean;
  pendingLRUpdates: Array<(prev: LiveRound[]) => LiveRound[]>;
  lrFlushCancel: (() => void) | null;
  lrShouldAutoScroll: boolean;
  abortSnapshot: AbortSnapshot | null;
};

function createLiveTranscriptArtifacts(): LiveTranscriptArtifacts {
  return {
    store: createLiveTranscriptStore(),
    pendingDraftDelta: "",
    draftFlushCancel: null,
    draftShouldAutoScroll: false,
    pendingLRUpdates: [],
    lrFlushCancel: null,
    lrShouldAutoScroll: false,
    abortSnapshot: null,
  };
}

export function useLiveTranscriptController(params: UseLiveTranscriptControllerParams) {
  const { currentConversationId, scrollAreaRef, composerBusyRef } = params;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  // A held pointer (scrollbar thumb drag, touch contact, text selection) keeps
  // user intent alive past the timed window — those gestures routinely outlast
  // it and used to fight the auto-pin halfway through.
  const pointerHeldRef = useRef(false);
  const lastObservedBottomGapRef = useRef(0);
  const lastScrollTowardBottomRef = useRef(false);
  const bottomLockUntilRef = useRef(0);
  const liveTranscriptArtifactsRef = useRef(new Map<string, LiveTranscriptArtifacts>());
  const liveTranscriptArtifactsByStoreRef = useRef(
    new WeakMap<LiveTranscriptStore, LiveTranscriptArtifacts>(),
  );
  const compactionThrottleByConversationRef = useRef(
    new Map<string, ReturnType<typeof createCompactionThrottleState>>(),
  );
  const autoScrollRafIdRef = useRef<number | null>(null);
  const lastAutoScrollTsRef = useRef(0);

  const ensureConversationLiveTranscriptArtifacts = useCallback((conversationId: string) => {
    const key = conversationId.trim();
    const existing = liveTranscriptArtifactsRef.current.get(key);
    if (existing) return existing;
    const created = createLiveTranscriptArtifacts();
    liveTranscriptArtifactsRef.current.set(key, created);
    liveTranscriptArtifactsByStoreRef.current.set(created.store, created);
    return created;
  }, []);

  const getConversationLiveTranscriptStore = useCallback(
    (conversationId: string) => ensureConversationLiveTranscriptArtifacts(conversationId).store,
    [ensureConversationLiveTranscriptArtifacts],
  );

  const getCompactionThrottleState = useCallback((conversationId: string) => {
    const key = conversationId.trim();
    const existing = compactionThrottleByConversationRef.current.get(key);
    if (existing) return existing;
    const created = createCompactionThrottleState();
    compactionThrottleByConversationRef.current.set(key, created);
    return created;
  }, []);

  const resetCompactionThrottleState = useCallback((conversationId: string) => {
    compactionThrottleByConversationRef.current.set(
      conversationId.trim(),
      createCompactionThrottleState(),
    );
  }, []);

  const liveTranscriptStore = useMemo(
    () => getConversationLiveTranscriptStore(currentConversationId),
    [currentConversationId, getConversationLiveTranscriptStore],
  );

  // Turn runners capture callbacks at send time; comparing against this ref
  // (instead of the memoized binding) keeps background-conversation resets from
  // scrolling the visible viewport after the user switches conversations.
  const visibleLiveTranscriptStoreRef = useRef(liveTranscriptStore);
  useLayoutEffect(() => {
    visibleLiveTranscriptStoreRef.current = liveTranscriptStore;
  }, [liveTranscriptStore]);

  const resolveLiveTranscriptArtifacts = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) =>
      liveTranscriptArtifactsByStoreRef.current.get(targetStore) ?? null,
    [liveTranscriptStore],
  );

  const getAdaptiveStreamInterval = useCallback(
    (baseIntervalMs: number) =>
      composerBusyRef.current
        ? Math.max(baseIntervalMs, STREAM_INPUT_BUSY_INTERVAL_MS)
        : baseIntervalMs,
    [composerBusyRef],
  );

  const clearAutoScroll = useCallback(() => {
    if (autoScrollRafIdRef.current !== null) {
      cancelAnimationFrame(autoScrollRafIdRef.current);
      autoScrollRafIdRef.current = null;
    }
  }, []);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const hasRecentUserScrollIntent = useCallback(
    () => pointerHeldRef.current || Date.now() <= userScrollIntentUntilRef.current,
    [],
  );

  const hasActiveBottomLock = useCallback(() => Date.now() <= bottomLockUntilRef.current, []);

  const attachAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = true;
  }, []);

  const detachAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = false;
    bottomLockUntilRef.current = 0;
    clearAutoScroll();
  }, [clearAutoScroll]);

  const requestAutoScroll = useCallback(() => {
    if (!shouldAutoScrollRef.current && !hasActiveBottomLock()) return;
    if (autoScrollRafIdRef.current !== null) return;

    autoScrollRafIdRef.current = requestAnimationFrame(function tick(ts) {
      if (!shouldAutoScrollRef.current && !hasActiveBottomLock()) {
        autoScrollRafIdRef.current = null;
        return;
      }

      // While a bottom lock is active the transcript is settling across several
      // commits (run start/stop, live→committed handoff); the throttle would let
      // mis-scrolled frames reach paint, so pin on every frame instead.
      const elapsed = ts - lastAutoScrollTsRef.current;
      if (
        !hasActiveBottomLock() &&
        elapsed < getAdaptiveStreamInterval(STREAM_AUTO_SCROLL_INTERVAL_MS)
      ) {
        autoScrollRafIdRef.current = requestAnimationFrame(tick);
        return;
      }

      autoScrollRafIdRef.current = null;
      lastAutoScrollTsRef.current = ts;

      const viewport = viewportRef.current ?? resolveScrollViewport(scrollAreaRef.current);
      if (!viewport) {
        if (hasActiveBottomLock()) {
          autoScrollRafIdRef.current = requestAnimationFrame(tick);
        }
        return;
      }
      viewport.scrollTop = viewport.scrollHeight;
      attachAutoScroll();
      if (hasActiveBottomLock()) {
        autoScrollRafIdRef.current = requestAnimationFrame(tick);
      }
    });
  }, [attachAutoScroll, getAdaptiveStreamInterval, hasActiveBottomLock, scrollAreaRef]);

  const scrollToBottomNow = useCallback(() => {
    const viewport = viewportRef.current ?? resolveScrollViewport(scrollAreaRef.current);
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [scrollAreaRef]);

  const stickToBottom = useCallback(() => {
    bottomLockUntilRef.current = Date.now() + BOTTOM_LOCK_DURATION_MS;
    attachAutoScroll();
    scrollToBottomNow();
    requestAutoScroll();
  }, [attachAutoScroll, requestAutoScroll, scrollToBottomNow]);

  useLayoutEffect(() => {
    userScrollIntentUntilRef.current = 0;
    stickToBottom();
  }, [currentConversationId, stickToBottom]);

  const cancelPendingLiveUpdates = useCallback((artifacts: LiveTranscriptArtifacts | null) => {
    if (!artifacts) return;

    artifacts.draftFlushCancel?.();
    artifacts.draftFlushCancel = null;
    artifacts.pendingDraftDelta = "";
    artifacts.draftShouldAutoScroll = false;

    artifacts.lrFlushCancel?.();
    artifacts.lrFlushCancel = null;
    artifacts.pendingLRUpdates.length = 0;
    artifacts.lrShouldAutoScroll = false;
  }, []);

  const flushPendingLiveUpdates = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore, shouldAutoScroll = false) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) return;

      let nextShouldAutoScroll = shouldAutoScroll;

      artifacts.draftFlushCancel?.();
      artifacts.draftFlushCancel = null;
      if (artifacts.pendingDraftDelta) {
        const acc = artifacts.pendingDraftDelta;
        artifacts.pendingDraftDelta = "";
        nextShouldAutoScroll ||= artifacts.draftShouldAutoScroll;
        artifacts.draftShouldAutoScroll = false;
        targetStore.appendDraftAssistantText(acc);
      } else {
        artifacts.draftShouldAutoScroll = false;
      }

      artifacts.lrFlushCancel?.();
      artifacts.lrFlushCancel = null;
      if (artifacts.pendingLRUpdates.length > 0) {
        const batch = artifacts.pendingLRUpdates.splice(0);
        nextShouldAutoScroll ||= artifacts.lrShouldAutoScroll;
        artifacts.lrShouldAutoScroll = false;
        targetStore.updateLiveRounds((prev) => {
          let nextRounds = prev;
          for (const update of batch) {
            nextRounds = update(nextRounds);
          }
          return nextRounds;
        });
      } else {
        artifacts.lrShouldAutoScroll = false;
      }

      if (nextShouldAutoScroll) {
        requestAutoScroll();
      }
    },
    [liveTranscriptStore, requestAutoScroll, resolveLiveTranscriptArtifacts],
  );

  const deleteConversationArtifacts = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      const artifacts = liveTranscriptArtifactsRef.current.get(key);
      cancelPendingLiveUpdates(artifacts ?? null);
      liveTranscriptArtifactsRef.current.delete(key);
      compactionThrottleByConversationRef.current.delete(key);
    },
    [cancelPendingLiveUpdates],
  );

  const clearAbortSnapshot = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) return;
      artifacts.abortSnapshot = null;
    },
    [liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const captureAbortSnapshot = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      flushPendingLiveUpdates(targetStore);
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) return;
      const liveState = targetStore.getSnapshot();
      artifacts.abortSnapshot = {
        draftAssistantText: liveState.draftAssistantText,
        liveRounds: cloneLiveRoundSnapshots(liveState.liveRounds),
      };
    },
    [flushPendingLiveUpdates, liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const getAbortSnapshot = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      flushPendingLiveUpdates(targetStore);
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      const liveState = targetStore.getSnapshot();
      return (
        artifacts?.abortSnapshot ?? {
          draftAssistantText: liveState.draftAssistantText,
          liveRounds: cloneLiveRoundSnapshots(liveState.liveRounds),
        }
      );
    },
    [flushPendingLiveUpdates, liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const resetLiveTranscript = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      flushPendingLiveUpdates(targetStore);
      targetStore.reset();
      // Every reset is a live→committed handoff (run completion, abort/error
      // commit, mid-run compaction rebase): the live bubble unmounts while the
      // same content re-enters the virtualizer at estimated height. Arm the
      // bottom lock so the viewport stays pinned through those commits — but
      // only when the user was already following the stream.
      if (targetStore === visibleLiveTranscriptStoreRef.current && shouldAutoScrollRef.current) {
        stickToBottom();
      }
    },
    [flushPendingLiveUpdates, liveTranscriptStore, stickToBottom],
  );

  const updateLiveRounds = useCallback(
    (
      updater: (prev: LiveRound[]) => LiveRound[],
      targetStore: LiveTranscriptStore = liveTranscriptStore,
      shouldAutoScroll = true,
    ) => {
      targetStore.updateLiveRounds(updater);
      if (shouldAutoScroll) {
        requestAutoScroll();
      }
    },
    [liveTranscriptStore, requestAutoScroll],
  );

  const appendDraftAssistantText = useCallback(
    (
      delta: string,
      targetStore: LiveTranscriptStore = liveTranscriptStore,
      shouldAutoScroll = true,
    ) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) {
        targetStore.appendDraftAssistantText(delta);
        if (shouldAutoScroll) {
          requestAutoScroll();
        }
        return;
      }

      const shouldApplyImmediately =
        artifacts.pendingDraftDelta.length === 0 &&
        artifacts.draftFlushCancel === null &&
        targetStore.getSnapshot().draftAssistantText.length === 0;
      if (shouldApplyImmediately) {
        targetStore.appendDraftAssistantText(delta);
        if (shouldAutoScroll) {
          requestAutoScroll();
        }
        return;
      }

      artifacts.pendingDraftDelta += delta;
      artifacts.draftShouldAutoScroll ||= shouldAutoScroll;
      if (artifacts.draftFlushCancel !== null) return;

      artifacts.draftFlushCancel = scheduleLiveTranscriptFlush(() => {
        artifacts.draftFlushCancel = null;

        const acc = artifacts.pendingDraftDelta;
        const shouldScroll = artifacts.draftShouldAutoScroll;
        artifacts.pendingDraftDelta = "";
        artifacts.draftShouldAutoScroll = false;
        if (!acc) return;
        targetStore.appendDraftAssistantText(acc);
        if (shouldScroll) {
          requestAutoScroll();
        }
      });
    },
    [liveTranscriptStore, requestAutoScroll, resolveLiveTranscriptArtifacts],
  );

  const batchLiveRoundsUpdate = useCallback(
    (
      updater: (prev: LiveRound[]) => LiveRound[],
      targetStore: LiveTranscriptStore = liveTranscriptStore,
      shouldAutoScroll = true,
    ) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) {
        targetStore.updateLiveRounds(updater);
        if (shouldAutoScroll) {
          requestAutoScroll();
        }
        return;
      }

      const snapshot = targetStore.getSnapshot();
      const lastRound = snapshot.liveRounds[snapshot.liveRounds.length - 1];
      const shouldApplyImmediately =
        artifacts.pendingLRUpdates.length === 0 &&
        artifacts.lrFlushCancel === null &&
        (snapshot.liveRounds.length === 0 || (lastRound?.blocks.length ?? 0) === 0);
      if (shouldApplyImmediately) {
        targetStore.updateLiveRounds(updater);
        if (shouldAutoScroll) {
          requestAutoScroll();
        }
        return;
      }

      artifacts.pendingLRUpdates.push(updater);
      artifacts.lrShouldAutoScroll ||= shouldAutoScroll;
      if (artifacts.lrFlushCancel !== null) return;

      artifacts.lrFlushCancel = scheduleLiveTranscriptFlush(() => {
        artifacts.lrFlushCancel = null;

        const batch = artifacts.pendingLRUpdates.splice(0);
        const shouldScroll = artifacts.lrShouldAutoScroll;
        artifacts.lrShouldAutoScroll = false;
        if (!batch.length) return;
        targetStore.updateLiveRounds((prev) => {
          let nextRounds = prev;
          for (const update of batch) {
            nextRounds = update(nextRounds);
          }
          return nextRounds;
        });
        if (shouldScroll) {
          requestAutoScroll();
        }
      });
    },
    [liveTranscriptStore, requestAutoScroll, resolveLiveTranscriptArtifacts],
  );

  const updateToolStatus = useCallback(
    (
      status: string | null,
      targetStore: LiveTranscriptStore = liveTranscriptStore,
      shouldAutoScroll = true,
    ) => {
      targetStore.setToolStatus(status);
      if (shouldAutoScroll) {
        requestAutoScroll();
      }
    },
    [liveTranscriptStore, requestAutoScroll],
  );

  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;

    let attachTimeoutId: number | null = null;
    let attachAttempts = 0;
    let cleanup: (() => void) | null = null;
    let mutationObserver: MutationObserver | null = null;

    const clearAttachTimeout = () => {
      if (attachTimeoutId === null) return;
      window.clearTimeout(attachTimeoutId);
      attachTimeoutId = null;
    };

    const scheduleAttachRetry = () => {
      if (attachTimeoutId !== null || cleanup !== null) return;
      if (attachAttempts >= VIEWPORT_ATTACH_MAX_ATTEMPTS) return;
      attachAttempts += 1;
      attachTimeoutId = window.setTimeout(() => {
        attachTimeoutId = null;
        attachViewport();
      }, VIEWPORT_ATTACH_RETRY_MS);
    };

    const attachViewport = () => {
      if (cleanup !== null) return;
      const viewport = resolveScrollViewport(root);
      if (!viewport) {
        scheduleAttachRetry();
        return;
      }

      clearAttachTimeout();
      mutationObserver?.disconnect();
      mutationObserver = null;
      viewportRef.current = viewport;

      const syncAutoScrollState = () => {
        const gap = getViewportBottomGap(viewport);
        lastObservedBottomGapRef.current = gap;
        if (isAtBottom(gap)) {
          attachAutoScroll();
          return;
        }
        if (hasRecentUserScrollIntent()) {
          detachAutoScroll();
        }
      };

      const handleScroll = () => {
        const previousGap = lastObservedBottomGapRef.current;
        const gap = getViewportBottomGap(viewport);
        lastObservedBottomGapRef.current = gap;

        const decision = decideScrollFollowAction({
          bottomGap: gap,
          previousBottomGap: previousGap,
          intentActive: hasRecentUserScrollIntent(),
          pointerHeld: pointerHeldRef.current,
        });
        if (decision.towardBottom !== null) {
          lastScrollTowardBottomRef.current = decision.towardBottom;
        }
        if (decision.refreshIntent) {
          markUserScrollIntent();
        }
        if (decision.action === "attach") {
          attachAutoScroll();
        } else if (decision.action === "attachAndPin") {
          attachAutoScroll();
          requestAutoScroll();
        } else if (decision.action === "detach") {
          detachAutoScroll();
        }
      };

      // Walk from the wheel target up to (excluding) the viewport: a nested
      // scroller that is mid-scroll (thinking <pre>, scrollable tool output)
      // consumes the upward delta itself — the viewport never moves, and since
      // re-attach needs a viewport scroll event, detaching here would strand
      // follow mode "off" while visually pinned at the bottom.
      const canNestedScrollerConsumeWheelUp = (target: EventTarget | null) => {
        let node = target instanceof Element ? target : null;
        while (node && node !== viewport) {
          if (
            node instanceof HTMLElement &&
            node.scrollTop > 0 &&
            node.scrollHeight - node.clientHeight > SCROLL_OVERFLOW_THRESHOLD_PX
          ) {
            return true;
          }
          node = node.parentElement;
        }
        return false;
      };

      const handleWheel = (event: WheelEvent) => {
        markUserScrollIntent();
        if (!isDominantVerticalWheel(event.deltaX, event.deltaY)) {
          return;
        }
        if (event.deltaY < 0) {
          if (!hasViewportOverflow(viewport)) {
            return;
          }
          if (canNestedScrollerConsumeWheelUp(event.target)) {
            return;
          }
          detachAutoScroll();
          return;
        }
        // Wheeling further down while already clamped at the bottom produces
        // no scroll event (scrollTop can't change) — treat it as an explicit
        // re-engage so a stranded detached-at-bottom state stays recoverable.
        if (!shouldAutoScrollRef.current && isViewportAtLatest(viewport)) {
          attachAutoScroll();
          requestAutoScroll();
        }
      };

      const handleTouchStart = (event: TouchEvent) => {
        touchYRef.current = event.touches[0]?.clientY ?? null;
        markUserScrollIntent();
      };

      const handleTouchMove = (event: TouchEvent) => {
        const nextY = event.touches[0]?.clientY ?? null;
        const previousY = touchYRef.current;
        markUserScrollIntent();
        if (
          hasViewportOverflow(viewport) &&
          (previousY === null ||
            nextY === null ||
            nextY > previousY + 1 ||
            !isViewportAtLatest(viewport))
        ) {
          detachAutoScroll();
        }
        touchYRef.current = nextY;
      };

      // On the scroll-area root rather than the viewport: the Base UI
      // scrollbar is a sibling of the viewport, and thumb drags must count as
      // user scroll intent too.
      const handleRootPointerDown = (event: PointerEvent) => {
        if (event.pointerType === "mouse" && event.button !== 0) {
          return;
        }
        pointerHeldRef.current = true;
        markUserScrollIntent();
      };

      const handlePointerRelease = () => {
        if (!pointerHeldRef.current) {
          return;
        }
        pointerHeldRef.current = false;
        markUserScrollIntent();
        if (
          decidePointerReleaseAction({
            bottomGap: getViewportBottomGap(viewport),
            lastScrollTowardBottom: lastScrollTowardBottomRef.current,
          }) === "attachAndPin"
        ) {
          attachAutoScroll();
          requestAutoScroll();
        }
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (isHistoryScrollKey(event)) {
          if (!hasViewportOverflow(viewport)) {
            return;
          }
          markUserScrollIntent();
          detachAutoScroll();
          return;
        }
        if (isFollowScrollKey(event)) {
          // Downward keys only mark intent — their scroll events then pass the
          // user-intent gate and re-engage through the strict/zone checks.
          markUserScrollIntent();
        }
      };

      const handleContentResize = () => {
        if (shouldAutoScrollRef.current) {
          // Detach decisions belong to the wheel/touch/key/scroll handlers,
          // which run in the input phase before this observer fires. Content
          // growth widens the bottom gap without any user input, so checking
          // user-scroll intent here would misread "just scrolled back to the
          // bottom" as "scrolling away" and tear down a re-engaged follow on
          // the next stream flush.
          // ResizeObserver fires after layout and before paint: correcting a
          // large gap here keeps single-commit height jumps from ever being
          // painted. Small gaps are ordinary streaming growth and stay on the
          // throttled path.
          // Recording the gap keeps the scroll handler's direction detection
          // honest: without it, growth since the last scroll event would make
          // the user's next downward wheel read as "moving away" and detach.
          const gap = getViewportBottomGap(viewport);
          lastObservedBottomGapRef.current = gap;
          if (gap > CONTENT_JUMP_REPIN_THRESHOLD_PX) {
            viewport.scrollTop = viewport.scrollHeight;
          }
          requestAutoScroll();
          return;
        }
        syncAutoScrollState();
      };

      syncAutoScrollState();
      viewport.addEventListener("scroll", handleScroll, { passive: true });
      viewport.addEventListener("wheel", handleWheel, { passive: true });
      viewport.addEventListener("touchstart", handleTouchStart, { passive: true });
      viewport.addEventListener("touchmove", handleTouchMove, { passive: true });
      root.addEventListener("pointerdown", handleRootPointerDown, { passive: true });
      window.addEventListener("pointerup", handlePointerRelease, { passive: true });
      window.addEventListener("pointercancel", handlePointerRelease, { passive: true });
      window.addEventListener("blur", handlePointerRelease);
      window.addEventListener("keydown", handleKeyDown, { capture: true });

      const resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleContentResize);
      resizeObserver?.observe(viewport);
      const content = viewport.firstElementChild;
      if (content instanceof Element) {
        resizeObserver?.observe(content);
      }

      cleanup = () => {
        viewport.removeEventListener("scroll", handleScroll);
        viewport.removeEventListener("wheel", handleWheel);
        viewport.removeEventListener("touchstart", handleTouchStart);
        viewport.removeEventListener("touchmove", handleTouchMove);
        root.removeEventListener("pointerdown", handleRootPointerDown);
        window.removeEventListener("pointerup", handlePointerRelease);
        window.removeEventListener("pointercancel", handlePointerRelease);
        window.removeEventListener("blur", handlePointerRelease);
        window.removeEventListener("keydown", handleKeyDown, { capture: true });
        resizeObserver?.disconnect();
        pointerHeldRef.current = false;
      };
    };

    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => {
        if (cleanup === null) {
          attachViewport();
        }
      });
      mutationObserver.observe(root, { childList: true, subtree: true });
    }
    attachViewport();

    return () => {
      clearAttachTimeout();
      mutationObserver?.disconnect();
      cleanup?.();
      viewportRef.current = null;
    };
  }, [
    attachAutoScroll,
    detachAutoScroll,
    hasRecentUserScrollIntent,
    markUserScrollIntent,
    requestAutoScroll,
    scrollAreaRef,
  ]);

  useEffect(
    () => () => {
      clearAutoScroll();
      for (const artifacts of liveTranscriptArtifactsRef.current.values()) {
        cancelPendingLiveUpdates(artifacts);
      }
    },
    [cancelPendingLiveUpdates, clearAutoScroll],
  );

  return {
    shouldAutoScrollRef,
    liveTranscriptStore,
    getConversationLiveTranscriptStore,
    getCompactionThrottleState,
    resetCompactionThrottleState,
    deleteConversationArtifacts,
    requestAutoScroll,
    clearAbortSnapshot,
    captureAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    stickToBottom,
    updateLiveRounds,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
  };
}
