import type { PetSettings } from "../settings";

export type PetManifest = {
  id: string;
  displayName: string;
  description: string;
  kind?: string;
  spriteVersionNumber: number;
  spritesheetPath: string;
  spriteVersion: "codex-v1" | "codex-v2";
  lookDirections: boolean;
  source: "codex" | "liveagent";
  assetVersion: string;
};

export type PetAnimationState =
  | "idle"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export type PetRuntimeProps = {
  settings: PetSettings;
  isSending: boolean;
  toolStatus: string | null;
  errorMessage: string | null;
};

export type PetRuntimeEventKind =
  | "run_failed"
  | "run_completed"
  | "approval_required"
  | "compacting"
  | "tool_running"
  | "thinking"
  | "background_running"
  | "queued"
  | "tool_failed"
  | "idle";

export type PetRuntimeEvent = {
  kind: PetRuntimeEventKind;
  state: PetAnimationState;
  priority: number;
  label: string;
  reason: string;
  transient?: boolean;
};
