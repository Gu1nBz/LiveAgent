import type { LiveRound } from "../chat/messages/uiMessages";
import type { PetAnimationState, PetRuntimeEvent, PetRuntimeEventKind } from "./types";

export const PET_ANIMATIONS: Record<
  PetAnimationState,
  { row: number; frameDurations: readonly number[]; loop: boolean; label: string }
> = {
  idle: { row: 0, frameDurations: [280, 110, 110, 140, 140, 320], loop: true, label: "休息中" },
  waving: { row: 3, frameDurations: [140, 140, 140, 280], loop: false, label: "你好" },
  jumping: { row: 4, frameDurations: [140, 140, 140, 140, 280], loop: false, label: "完成啦" },
  failed: {
    row: 5,
    frameDurations: [140, 140, 140, 140, 140, 140, 140, 240],
    loop: true,
    label: "遇到问题",
  },
  waiting: {
    row: 6,
    frameDurations: [150, 150, 150, 150, 150, 260],
    loop: true,
    label: "等待你的确认",
  },
  running: {
    row: 7,
    frameDurations: [120, 120, 120, 120, 120, 220],
    loop: true,
    label: "正在工作",
  },
  review: {
    row: 8,
    frameDurations: [150, 150, 150, 150, 150, 280],
    loop: true,
    label: "正在检查",
  },
};

export type PetMovementDirection = "left" | "right";

export const PET_MOVEMENT_ANIMATIONS: Record<
  PetMovementDirection,
  { row: number; frameDurations: readonly number[]; loop: true; label: string }
> = {
  right: {
    row: 1,
    frameDurations: [110, 110, 110, 110, 110, 110, 110, 110],
    loop: true,
    label: "向右移动",
  },
  left: {
    row: 2,
    frameDurations: [110, 110, 110, 110, 110, 110, 110, 110],
    loop: true,
    label: "向左移动",
  },
};

export function resolvePetAnimation(
  state: PetAnimationState,
  movementDirection?: PetMovementDirection,
) {
  return movementDirection ? PET_MOVEMENT_ANIMATIONS[movementDirection] : PET_ANIMATIONS[state];
}

type PetRuntimeSignalInput = {
  isSending: boolean;
  toolStatus: string | null;
  errorMessage: string | null;
  isCompactionRunning: boolean;
  queuedTurnCount: number;
  backgroundRunCount: number;
  liveRounds: LiveRound[];
};

const PRIORITY: Record<PetRuntimeEventKind, number> = {
  run_failed: 100,
  run_completed: 95,
  approval_required: 90,
  compacting: 80,
  tool_running: 70,
  thinking: 60,
  background_running: 50,
  queued: 45,
  tool_failed: 40,
  idle: 0,
};

function event(
  kind: PetRuntimeEventKind,
  state: PetAnimationState,
  label: string,
  reason: string,
  transient = false,
): PetRuntimeEvent {
  return { kind, state, priority: PRIORITY[kind], label, reason, transient };
}

function inspectLiveTools(rounds: LiveRound[]) {
  const runningIds = new Set<string>();
  const runningNames: string[] = [];
  let failedCount = 0;

  for (const round of rounds) {
    for (const id of round.runningToolCallIds) runningIds.add(id);
    for (const block of round.blocks) {
      if (block.kind !== "tool") continue;
      if (block.item.toolResult?.isError) failedCount += 1;
      if (block.item.toolCall.id && runningIds.has(block.item.toolCall.id)) {
        runningNames.push(block.item.toolCall.name);
      }
    }
  }
  return { runningNames: [...new Set(runningNames)], failedCount };
}

export function derivePetRuntimeEvents(input: PetRuntimeSignalInput): PetRuntimeEvent[] {
  const events: PetRuntimeEvent[] = [];
  const status = input.toolStatus?.trim() ?? "";
  const normalizedStatus = status.toLowerCase();
  const tools = inspectLiveTools(input.liveRounds);

  if (input.errorMessage?.trim()) {
    events.push(event("run_failed", "failed", "遇到问题", "conversation_error"));
  }
  if (/approval|approve|confirm|permission|等待.*确认|批准|授权/.test(normalizedStatus)) {
    events.push(event("approval_required", "waiting", "等待你的确认", "explicit_approval_status"));
  }
  if (input.isCompactionRunning) {
    events.push(event("compacting", "review", "正在整理上下文", "compaction_running"));
  }
  if (tools.runningNames.length > 0) {
    const names = tools.runningNames.slice(0, 2).join("、");
    events.push(event("tool_running", "running", `正在使用 ${names}`, "live_tool_call"));
  }
  if (input.isSending && tools.runningNames.length === 0) {
    events.push(event("thinking", "running", status || "正在思考", "active_conversation_run"));
  }
  if (!input.isSending && input.backgroundRunCount > 0) {
    events.push(
      event(
        "background_running",
        "running",
        `${input.backgroundRunCount} 个后台任务运行中`,
        "background_conversation_run",
      ),
    );
  }
  if (!input.isSending && input.queuedTurnCount > 0) {
    events.push(
      event(
        "queued",
        "waiting",
        `${input.queuedTurnCount} 条任务排队中`,
        "queued_conversation_turn",
      ),
    );
  }
  if (tools.failedCount > 0 && input.isSending) {
    events.push(event("tool_failed", "review", "正在检查工具结果", "recoverable_tool_error"));
  }
  if (events.length === 0) {
    events.push(event("idle", "idle", "休息中", "no_activity"));
  }
  return events.sort((left, right) => right.priority - left.priority);
}

export function selectPetRuntimeEvent(events: PetRuntimeEvent[]): PetRuntimeEvent {
  return events[0] ?? event("idle", "idle", "休息中", "empty_event_list");
}

export function createRunCompletedEvent(): PetRuntimeEvent {
  return event("run_completed", "jumping", "完成啦", "run_transition_completed", true);
}

export const PET_STATE_MIN_HOLD_MS: Record<PetAnimationState, number> = {
  idle: 0,
  waving: 800,
  jumping: 1200,
  failed: 1800,
  waiting: 500,
  running: 350,
  review: 500,
};

export function transitionDelayMs(
  current: PetRuntimeEvent,
  next: PetRuntimeEvent,
  enteredAt: number,
  now: number,
): number {
  if (next.priority > current.priority) return 0;
  if (next.kind === current.kind && next.label === current.label) return 0;
  return Math.max(0, PET_STATE_MIN_HOLD_MS[current.state] - (now - enteredAt));
}

export function samePetRuntimeEvent(left: PetRuntimeEvent, right: PetRuntimeEvent): boolean {
  return (
    left.kind === right.kind &&
    left.state === right.state &&
    left.label === right.label &&
    left.reason === right.reason
  );
}

function compactConversationPreview(value: string) {
  const lines = value
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  const text = (lines.at(-1) ?? "").replace(/\s+/g, " ").trim();
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

export function latestPetConversationPreview(liveRounds: LiveRound[], draftAssistantText: string) {
  for (let roundIndex = liveRounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
    const round = liveRounds[roundIndex];
    if (!round?.thinkingOpen) continue;
    for (let blockIndex = round.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = round.blocks[blockIndex];
      if (block?.kind !== "thinking") continue;
      const preview = compactConversationPreview(block.text);
      if (preview) return preview;
    }
  }
  const draftPreview = compactConversationPreview(draftAssistantText);
  if (draftPreview) return draftPreview;
  for (let roundIndex = liveRounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
    const round = liveRounds[roundIndex];
    if (!round) continue;
    for (let blockIndex = round.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = round.blocks[blockIndex];
      if (block?.kind !== "thinking" && block?.kind !== "text") continue;
      const preview = compactConversationPreview(block.text);
      if (preview) return preview;
    }
  }
  return "";
}

export function pointerDirectionIndex(dx: number, dy: number): number {
  const clockwiseFromUp = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const normalized = (clockwiseFromUp + 360) % 360;
  return Math.round(normalized / 22.5) % 16;
}
