import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { assistantMessageToText, streamAssistantMessage } from "../../lib/providers/llm";
import {
  buildConversationTitlePrompt,
  mergeHistoryItem,
  normalizeConversationTitle,
} from "../../lib/chat/page/chatPageHelpers";
import type { ChatHistorySummary } from "../../lib/chat/history/chatHistory";
import type { ProviderId } from "../../lib/settings";
import type { GatewayBridgeEventController } from "../../lib/chat/conversation/run";

type TitleJobRefValue = {
  conversationId: string;
  promise: Promise<string | null>;
} | null;

type StartConversationTitleJobParams = {
  providerId: ProviderId;
  model: string;
  runtime: Parameters<typeof streamAssistantMessage>[0]["runtime"];
  signal: AbortSignal;
  conversationId: string;
  titleSourceText: string;
  content: string;
  setHistoryItems: Dispatch<SetStateAction<ChatHistorySummary[]>>;
  titleJobRef: MutableRefObject<TitleJobRefValue>;
  gatewayBridgeEvents: GatewayBridgeEventController;
};

const GATEWAY_BRIDGE_TITLE_MIN_INTERVAL_MS = 250;

export function buildConversationTitleRuntime(
  runtime: Parameters<typeof streamAssistantMessage>[0]["runtime"],
): Parameters<typeof streamAssistantMessage>[0]["runtime"] {
  return {
    ...runtime,
    reasoning: "off",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
  };
}

export function startConversationTitleJob(params: StartConversationTitleJobParams) {
  const {
    providerId,
    model,
    runtime,
    signal,
    conversationId,
    titleSourceText,
    content,
    setHistoryItems,
    titleJobRef,
    gatewayBridgeEvents,
  } = params;
  let streamedTitle = "";
  let lastForwardedGatewayTitle = "";
  let lastForwardedGatewayTitleAt = 0;

  const forwardGatewayTitlePreview = (preview: string, force = false) => {
    const title = preview.trim();
    if (!title || title === lastForwardedGatewayTitle) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastForwardedGatewayTitleAt < GATEWAY_BRIDGE_TITLE_MIN_INTERVAL_MS) {
      return;
    }
    lastForwardedGatewayTitle = title;
    lastForwardedGatewayTitleAt = now;
    gatewayBridgeEvents.queueTitle(title, force);
  };

  const titleRuntime = buildConversationTitleRuntime(runtime);

  const titlePromise = streamAssistantMessage({
    providerId,
    model,
    runtime: titleRuntime,
    signal,
    cacheRetention: "none",
    nativeWebSearch: false,
    context: {
      systemPrompt: "You generate concise conversation titles. Output the title only, with no extra explanation.",
      messages: [
        {
          role: "user",
          content: buildConversationTitlePrompt(titleSourceText || content),
          timestamp: Date.now(),
        },
      ],
    },
    onTextDelta: (delta) => {
      streamedTitle += delta;
      const preview = streamedTitle
        .replace(/[\r\n]+/g, " ")
        .replace(/^[`"'""'']+|[`"'""'']+$/g, "")
        .trim();
      if (!preview) return;
      forwardGatewayTitlePreview(preview);
      setHistoryItems((prev) => {
        const currentItem = prev.find((item) => item.id === conversationId);
        if (!currentItem || !currentItem.isPending) return prev;
        return mergeHistoryItem(prev, {
          ...currentItem,
          title: preview,
          updatedAt: Date.now(),
        });
      });
    },
  })
    .then((assistant) => normalizeConversationTitle(assistantMessageToText(assistant)))
    .then((title) => title || null)
    .catch(() => null);

  titleJobRef.current = {
    conversationId,
    promise: titlePromise,
  };

  void titlePromise
    .then((resolvedTitle) => {
      if (!resolvedTitle) return;
      forwardGatewayTitlePreview(resolvedTitle, true);
      setHistoryItems((prev) => {
        const currentItem = prev.find((item) => item.id === conversationId);
        if (!currentItem || !currentItem.isPending) return prev;
        if (currentItem.title === resolvedTitle) return prev;
        return mergeHistoryItem(prev, {
          ...currentItem,
          title: resolvedTitle,
          updatedAt: Date.now(),
        });
      });
    })
    .catch(() => {
      // ignore title preview failures; the pending row keeps the default title
    });

  return titlePromise;
}
