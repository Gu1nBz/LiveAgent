import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/shared/utils";
import { GripVertical } from "../icons";
import {
  autoScrollTabsForPointer,
  getReorderedTabIdsFromPointer,
  reorderTabIdsByKeyboard,
  sameStringArray,
} from "./rightDockModel";

type TabDragState = {
  pointerId: number;
  draggedId: string;
  startX: number;
  startY: number;
  hasMoved: boolean;
  order: string[];
  previousUserSelect: string;
  captureElement: HTMLElement;
};

type UseRightDockTabReorderOptions = {
  canReorderTabs: boolean;
  orderedTabIds: string[];
  projectPathKey: string;
  reorderLabel: string;
  reorderHint: string;
  onDraftTabOrderChange: (nextOrder: string[] | null) => void;
  onCommitTabOrder: (nextOrder: string[]) => void;
};

export function useRightDockTabReorder(options: UseRightDockTabReorderOptions) {
  const {
    canReorderTabs,
    orderedTabIds,
    projectPathKey,
    reorderLabel,
    reorderHint,
    onDraftTabOrderChange,
    onCommitTabOrder,
  } = options;
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const tabDragRef = useRef<TabDragState | null>(null);
  const suppressedTabClickRef = useRef("");
  const [draggingTabId, setDraggingTabId] = useState("");

  useEffect(() => {
    return () => {
      const dragState = tabDragRef.current;
      if (dragState?.hasMoved) {
        document.body.style.userSelect = dragState.previousUserSelect;
      }
      tabDragRef.current = null;
    };
  }, []);

  useEffect(() => {
    onDraftTabOrderChange(null);
    setDraggingTabId("");
    tabDragRef.current = null;
    suppressedTabClickRef.current = "";
  }, [onDraftTabOrderChange, projectPathKey]);

  const consumeSuppressedTabClick = useCallback((tabId: string) => {
    if (suppressedTabClickRef.current !== tabId) return false;
    suppressedTabClickRef.current = "";
    return true;
  }, []);

  const handleTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, tabId: string) => {
      if (event.button !== 0 || orderedTabIds.length < 2) return;
      event.stopPropagation();
      tabDragRef.current = {
        pointerId: event.pointerId,
        draggedId: tabId,
        startX: event.clientX,
        startY: event.clientY,
        hasMoved: false,
        order: orderedTabIds,
        previousUserSelect: "",
        captureElement: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [orderedTabIds],
  );

  const handleTabReorderKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      if (orderedTabIds.length < 2) return;
      const nextOrder = reorderTabIdsByKeyboard(orderedTabIds, tabId, event.key);
      if (!nextOrder) return;

      event.preventDefault();
      event.stopPropagation();
      onDraftTabOrderChange(nextOrder);
      onCommitTabOrder(nextOrder);

      const tabElement = event.currentTarget.closest("[data-project-tools-tab-id]");
      if (tabElement instanceof HTMLElement) {
        window.requestAnimationFrame(() => {
          tabElement.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
      }
    },
    [onCommitTabOrder, onDraftTabOrderChange, orderedTabIds],
  );

  const handleTabPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const dragState = tabDragRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (!dragState.hasMoved && Math.hypot(deltaX, deltaY) < 5) return;
      if (!dragState.hasMoved) {
        dragState.hasMoved = true;
        dragState.previousUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        setDraggingTabId(dragState.draggedId);
      }

      event.preventDefault();
      autoScrollTabsForPointer(tabsScrollRef.current, event.clientX);
      const nextOrder = getReorderedTabIdsFromPointer(
        tabsScrollRef.current,
        dragState.draggedId,
        event.clientX,
      );
      if (!nextOrder || sameStringArray(nextOrder, dragState.order)) return;
      dragState.order = nextOrder;
      onDraftTabOrderChange(nextOrder);
    },
    [onDraftTabOrderChange],
  );

  const finishTabDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const dragState = tabDragRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      tabDragRef.current = null;
      if (dragState.captureElement.hasPointerCapture(event.pointerId)) {
        dragState.captureElement.releasePointerCapture(event.pointerId);
      }
      if (dragState.hasMoved) {
        document.body.style.userSelect = dragState.previousUserSelect;
        suppressedTabClickRef.current = dragState.draggedId;
        onCommitTabOrder(dragState.order);
      }
      setDraggingTabId("");
    },
    [onCommitTabOrder],
  );

  const renderTabDragHandle = useCallback(
    (tabId: string, label: string) => (
      <button
        type="button"
        data-project-tools-tab-action="drag"
        aria-label={`${reorderLabel} ${label}`}
        title={reorderHint}
        disabled={!canReorderTabs}
        tabIndex={canReorderTabs ? 0 : -1}
        className={cn(
          "relative z-10 flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/45 opacity-70 transition-[background-color,color,opacity] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          canReorderTabs
            ? "cursor-grab touch-none hover:bg-background/80 hover:text-foreground hover:opacity-100 focus-visible:bg-background focus-visible:text-foreground focus-visible:opacity-100 active:cursor-grabbing"
            : "cursor-default opacity-30",
        )}
        onClick={() => {
          consumeSuppressedTabClick(tabId);
        }}
        onKeyDown={(event) => handleTabReorderKeyDown(event, tabId)}
        onPointerCancel={finishTabDrag}
        onPointerDown={(event) => handleTabPointerDown(event, tabId)}
        onPointerMove={handleTabPointerMove}
        onPointerUp={finishTabDrag}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
    ),
    [
      canReorderTabs,
      consumeSuppressedTabClick,
      finishTabDrag,
      handleTabPointerDown,
      handleTabPointerMove,
      handleTabReorderKeyDown,
      reorderHint,
      reorderLabel,
    ],
  );

  return {
    consumeSuppressedTabClick,
    draggingTabId,
    renderTabDragHandle,
    tabsScrollRef,
  };
}
