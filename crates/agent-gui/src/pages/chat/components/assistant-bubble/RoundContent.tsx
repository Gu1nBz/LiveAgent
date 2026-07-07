import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChevronRight, Loader2, Sparkles } from "../../../../components/icons";
import { LiveMarkdown, Markdown } from "../../../../components/Markdown";
import { useLocale } from "../../../../i18n";
import type { UiRound } from "../../../../lib/chat/messages/uiMessages";
import { normalizeLiveToolStatus, VIBING_STATUS } from "../../../../lib/chat/page/chatPageHelpers";
import { isAtBottom, isDominantVerticalWheel } from "../../utils/scrollFollowPolicy";
import { groupRoundBlocks } from "./assistantBubbleUtils";
import { HostedSearchGroupView } from "./HostedSearchGroupView";
import { CompactingText, VibingText } from "./StatusText";
import { MemoToolCallItem } from "./ToolCallItem";
import { getNativeDisplayImagePayload, NativeDisplayImageBlock } from "./ToolImages";
import { ToolTraceGroup } from "./ToolTraceGroup";
import { UsagePanel } from "./UsagePanel";

const THINKING_SCROLL_BOTTOM_THRESHOLD_PX = 2;
const THINKING_USER_SCROLL_INTENT_WINDOW_MS = 500;

function getThinkingScrollBottomGap(viewport: HTMLElement) {
  return Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
}

function isThinkingScrollAtBottom(viewport: HTMLElement) {
  // Shares the transcript's fractional-DPR-tolerant threshold; a 2px check
  // can't be satisfied at the physical clamp on scaled displays.
  return isAtBottom(getThinkingScrollBottomGap(viewport));
}

function hasThinkingScrollOverflow(viewport: HTMLElement) {
  return viewport.scrollHeight - viewport.clientHeight > THINKING_SCROLL_BOTTOM_THRESHOLD_PX;
}

function useStickyBottomScroll(
  viewportRef: { current: HTMLPreElement | null },
  options: { enabled: boolean; contentKey: string },
) {
  const { enabled, contentKey } = options;
  const shouldStickRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const userScrollIntentUntilRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const previousContentKeyRef = useRef(contentKey);

  const cancelScheduledScroll = useCallback(() => {
    if (scrollFrameRef.current === null || typeof window === "undefined") {
      scrollFrameRef.current = null;
      return;
    }
    window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = null;
  }, []);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    shouldStickRef.current = true;
  }, [viewportRef]);

  const scheduleScrollToBottom = useCallback(() => {
    if (scrollFrameRef.current !== null || typeof window === "undefined") {
      return;
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (!shouldStickRef.current) return;
      scrollToBottom();
    });
  }, [scrollToBottom]);

  useEffect(() => {
    if (!enabled) {
      shouldStickRef.current = true;
      cancelScheduledScroll();
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;

    shouldStickRef.current = true;
    scheduleScrollToBottom();

    const markUserScrollIntent = () => {
      userScrollIntentUntilRef.current = Date.now() + THINKING_USER_SCROLL_INTENT_WINDOW_MS;
    };

    const hasRecentUserScrollIntent = () => Date.now() <= userScrollIntentUntilRef.current;

    const syncStickyState = () => {
      if (isThinkingScrollAtBottom(viewport)) {
        shouldStickRef.current = true;
      } else if (hasRecentUserScrollIntent()) {
        shouldStickRef.current = false;
      }
    };

    const handleScroll = () => {
      syncStickyState();
    };

    const handleWheel = (event: WheelEvent) => {
      markUserScrollIntent();
      if (
        event.deltaY < 0 &&
        isDominantVerticalWheel(event.deltaX, event.deltaY) &&
        hasThinkingScrollOverflow(viewport)
      ) {
        shouldStickRef.current = false;
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
        hasThinkingScrollOverflow(viewport) &&
        (previousY === null ||
          nextY === null ||
          nextY > previousY + 1 ||
          !isThinkingScrollAtBottom(viewport))
      ) {
        shouldStickRef.current = false;
      }
      touchYRef.current = nextY;
    };

    const handlePointerDown = () => {
      markUserScrollIntent();
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    viewport.addEventListener("touchstart", handleTouchStart, { passive: true });
    viewport.addEventListener("touchmove", handleTouchMove, { passive: true });
    viewport.addEventListener("pointerdown", handlePointerDown, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("touchstart", handleTouchStart);
      viewport.removeEventListener("touchmove", handleTouchMove);
      viewport.removeEventListener("pointerdown", handlePointerDown);
      cancelScheduledScroll();
      touchYRef.current = null;
    };
  }, [cancelScheduledScroll, enabled, scheduleScrollToBottom, viewportRef]);

  useEffect(() => {
    const contentChanged = previousContentKeyRef.current !== contentKey;
    previousContentKeyRef.current = contentKey;
    if (!contentChanged || !enabled || !shouldStickRef.current) return;
    scheduleScrollToBottom();
  });

  useEffect(() => () => cancelScheduledScroll(), [cancelScheduledScroll]);
}

function ThinkingBlock({ text, open }: { text: string; open?: boolean }) {
  const hasText = /\S/.test(text || "");
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(typeof open === "boolean" ? open : false);
  const userInteractedRef = useRef(false);
  const thinkingPreRef = useRef<HTMLPreElement | null>(null);

  useStickyBottomScroll(thinkingPreRef, { enabled: isOpen && hasText, contentKey: text });

  useEffect(() => {
    if (!userInteractedRef.current && typeof open === "boolean") {
      setIsOpen(open);
    }
  }, [open]);

  if (!hasText) return null;

  return (
    <div className="group/think rounded-lg border border-border/40 bg-muted/30">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          userInteractedRef.current = true;
          setIsOpen((prev) => !prev);
        }}
        className="thinking-block-toggle flex w-full cursor-pointer select-none items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground/70" />
        <span className="thinking-block-label font-medium">{t("chat.thinkingProcess")}</span>
        <ChevronRight
          className={`ml-auto h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
        />
      </button>
      {isOpen ? (
        <div className="border-t border-border/30 px-3 pb-3 pt-2">
          <pre
            ref={thinkingPreRef}
            className="thinking-block-pre max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-[12.5px] leading-relaxed text-muted-foreground"
          >
            {text}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

export function RoundContent(props: {
  round: UiRound;
  showLabel: boolean;
  showUsage?: boolean;
  usageContextWindow?: number;
  isLive?: boolean;
  isActive?: boolean;
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
  runningToolCallIds?: string[];
  thinkingOpen?: boolean;
}) {
  const {
    round,
    showLabel,
    showUsage,
    usageContextWindow,
    isLive,
    isActive,
    toolStatus,
    toolStatusVariant,
    runningToolCallIds,
    thinkingOpen,
  } = props;
  const hasContent =
    round.blocks.some((block) => {
      if (block.kind === "tool" || block.kind === "hostedSearch") return true;
      return block.text.trim().length > 0;
    }) ||
    (isActive && isLive);
  const normalizedToolStatus =
    isActive && isLive ? normalizeLiveToolStatus(toolStatus ?? null) : null;
  const isCompactionStatus = toolStatusVariant === "compaction";
  const isVibingStatus = normalizedToolStatus === VIBING_STATUS;
  const groupedBlocks = useMemo(() => groupRoundBlocks(round.blocks), [round.blocks]);
  const latestThinkingKey = useMemo(() => {
    for (let index = groupedBlocks.length - 1; index >= 0; index -= 1) {
      const block = groupedBlocks[index];
      if (block?.kind === "thinking") return block.key;
    }
    return null;
  }, [groupedBlocks]);
  const autoOpenThinking = isLive ? Boolean(isActive && thinkingOpen) : false;

  if (!hasContent) return null;

  return (
    <div className="space-y-3">
      {showLabel ? <div className="h-px bg-border/40" /> : null}

      {isActive && isLive && normalizedToolStatus ? (
        <div className="flex items-center gap-2 py-1 text-[13px]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          {isCompactionStatus ? (
            <CompactingText className="font-medium text-muted-foreground" />
          ) : isVibingStatus ? (
            <VibingText className="font-medium text-muted-foreground" />
          ) : (
            <span className="font-medium text-muted-foreground">{normalizedToolStatus}</span>
          )}
        </div>
      ) : null}

      {groupedBlocks.map((block) => {
        if (block.kind === "thinking") {
          return (
            <ThinkingBlock
              key={block.key}
              text={block.text}
              open={autoOpenThinking && block.key === latestThinkingKey}
            />
          );
        }

        if (block.kind === "tool") {
          const displayImagePayload = getNativeDisplayImagePayload(block.item);
          if (displayImagePayload) {
            return <NativeDisplayImageBlock key={block.key} payload={displayImagePayload} />;
          }

          if (block.item.toolCall.name === "Image" && !block.item.toolResult?.isError) {
            return null;
          }

          return (
            <MemoToolCallItem
              key={block.key}
              item={block.item}
              isRunning={Boolean(
                isLive &&
                  block.item.toolCall.id &&
                  (runningToolCallIds || []).includes(block.item.toolCall.id),
              )}
            />
          );
        }

        if (block.kind === "toolGroup") {
          return (
            <ToolTraceGroup
              key={block.key}
              items={block.items}
              runningToolCallIds={isLive ? (runningToolCallIds ?? []) : []}
            />
          );
        }

        if (block.kind === "hostedSearch" || block.kind === "hostedSearchGroup") {
          return (
            <HostedSearchGroupView
              key={block.key}
              items={block.kind === "hostedSearch" ? [block.item] : block.items}
            />
          );
        }

        if (!block.text.trim()) return null;

        return isLive && isActive ? (
          <LiveMarkdown
            key={block.key}
            content={block.text}
            className="font-openai-chat"
            isAnimating
          />
        ) : (
          <Markdown key={block.key} content={block.text} className="font-openai-chat" />
        );
      })}

      {showUsage ? (
        <UsagePanel usage={round.meta?.usage} contextWindow={usageContextWindow} />
      ) : null}
    </div>
  );
}
