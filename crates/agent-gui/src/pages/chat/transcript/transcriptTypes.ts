import type { RefObject } from "react";

import type {
  HistoryMessageRef,
  RenderTimelineItem,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import type { GitClient } from "../../../lib/git/types";
import type { SectionId } from "../../settings/types";

export type ChatTranscriptProps = {
  conversationId: string;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  bottomRef: RefObject<HTMLDivElement | null>;
  hasModels: boolean;
  historyItems: RenderTimelineItem[];
  isHistorySwitching: boolean;
  isSending: boolean;
  isAgentMode: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  liveTranscriptStore: LiveTranscriptStore;
  isCompactionRunning: boolean;
  bottomReservePx?: number;
  copiedMessageKey: string | null;
  setCopiedMessageKey: (key: string | null) => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
  ) => void;
  onOpenSettings: (section?: SectionId) => void;
  onSuggestionSelect?: (text: string) => void;
};

export type TranscriptHistoryProps = Pick<
  ChatTranscriptProps,
  | "historyItems"
  | "conversationId"
  | "workspaceRoot"
  | "gitClient"
  | "showUsage"
  | "usageContextWindow"
  | "copiedMessageKey"
  | "setCopiedMessageKey"
  | "onResendFromEdit"
> & {
  isSending: boolean;
  scrollViewport: HTMLDivElement | null;
};

export type TranscriptLiveStateProps = Pick<
  ChatTranscriptProps,
  | "isSending"
  | "isAgentMode"
  | "showUsage"
  | "usageContextWindow"
  | "liveTranscriptStore"
  | "isCompactionRunning"
>;
