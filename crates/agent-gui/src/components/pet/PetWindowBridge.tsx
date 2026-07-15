import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LiveTranscriptStore } from "../../lib/chat/conversation/liveTranscriptStore";
import { listPets, PET_INSTALLED_EVENT, type PetInstalledEvent } from "../../lib/pet/api";
import { latestPetConversationPreview } from "../../lib/pet/runtime";
import type { PetRuntimeEvent } from "../../lib/pet/types";
import { usePetRuntime } from "../../lib/pet/usePetRuntime";
import { type AppSettings, normalizePetSettings, type PetSettings } from "../../lib/settings";

export const PET_RUNTIME_EVENT = "pet:runtime-state";
export const PET_READY_EVENT = "pet:ready";
export const PET_ASSET_MISSING_EVENT = "pet:asset-missing";

export type PetWindowTask = {
  id: string;
  title: string;
  preview: string;
  status: "running" | "completed" | "failed";
};

export type PetWindowRuntimePayload = {
  runtime: PetRuntimeEvent;
  settings: PetSettings;
  conversationTitle: string;
  conversationPreview: string;
  activeConversationCount: number;
  tasks: PetWindowTask[];
};

export function PetWindowBridge(props: {
  settings: PetSettings;
  isSending: boolean;
  errorMessage: string | null;
  liveTranscriptStore: LiveTranscriptStore;
  isCompactionRunning: boolean;
  queuedTurnCount: number;
  backgroundRunCount: number;
  conversationTitle: string;
  activeConversations: Array<{
    id: string;
    title: string;
    transcriptStore: LiveTranscriptStore;
  }>;
  setSettings: (updater: (previous: AppSettings) => AppSettings) => void;
}) {
  const transcript = useSyncExternalStore(
    props.liveTranscriptStore.subscribe,
    props.liveTranscriptStore.getSnapshot,
    props.liveTranscriptStore.getSnapshot,
  );
  const [activeTranscriptVersion, setActiveTranscriptVersion] = useState(0);
  useEffect(() => {
    const unsubscribers = props.activeConversations.map((conversation) =>
      conversation.transcriptStore.subscribe(() => {
        setActiveTranscriptVersion((version) => version + 1);
      }),
    );
    return () =>
      unsubscribers.forEach((unsubscribe) => {
        unsubscribe();
      });
  }, [props.activeConversations]);
  const runtime = usePetRuntime({
    isSending: props.isSending,
    toolStatus: transcript.toolStatus,
    errorMessage: props.errorMessage,
    isCompactionRunning: props.isCompactionRunning,
    queuedTurnCount: props.queuedTurnCount,
    backgroundRunCount: props.backgroundRunCount,
    liveRounds: transcript.liveRounds,
  });
  const livePreview = useMemo(
    () => latestPetConversationPreview(transcript.liveRounds, transcript.draftAssistantText),
    [transcript.draftAssistantText, transcript.liveRounds],
  );
  const lastConversationPreviewRef = useRef("");
  if (livePreview) lastConversationPreviewRef.current = livePreview;
  const conversationPreview =
    livePreview ||
    (runtime.kind === "run_completed" ? lastConversationPreviewRef.current : "") ||
    runtime.label;
  const activeTasks = useMemo<PetWindowTask[]>(() => {
    void activeTranscriptVersion;
    return props.activeConversations.map((conversation) => {
      const snapshot = conversation.transcriptStore.getSnapshot();
      return {
        id: conversation.id,
        title: conversation.title || "LiveAgent",
        preview:
          latestPetConversationPreview(snapshot.liveRounds, snapshot.draftAssistantText) ||
          snapshot.toolStatus?.trim() ||
          "正在处理",
        status: "running",
      };
    });
  }, [activeTranscriptVersion, props.activeConversations]);
  const previousActiveTasksRef = useRef(new Map<string, PetWindowTask>());
  const completionTimersRef = useRef(new Map<string, number>());
  const [recentCompletedTasks, setRecentCompletedTasks] = useState<PetWindowTask[]>([]);
  useEffect(() => {
    const nextIds = new Set(activeTasks.map((task) => task.id));
    for (const [id, previous] of previousActiveTasksRef.current) {
      if (nextIds.has(id)) continue;
      const completedPreview = /^(?:正在处理|正在思考|正在工作|正在使用|处理中|模型生成中)/.test(
        previous.preview.trim(),
      )
        ? "已完成"
        : previous.preview;
      setRecentCompletedTasks((tasks) =>
        [
          { ...previous, preview: completedPreview || "已完成", status: "completed" as const },
          ...tasks.filter((task) => task.id !== id),
        ].slice(0, 3),
      );
      const existingTimer = completionTimersRef.current.get(id);
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      completionTimersRef.current.set(
        id,
        window.setTimeout(() => {
          setRecentCompletedTasks((tasks) => tasks.filter((task) => task.id !== id));
          completionTimersRef.current.delete(id);
        }, 30_000),
      );
    }
    previousActiveTasksRef.current = new Map(activeTasks.map((task) => [task.id, task]));
  }, [activeTasks]);
  useEffect(
    () => () => {
      completionTimersRef.current.forEach((timer) => {
        window.clearTimeout(timer);
      });
      completionTimersRef.current.clear();
    },
    [],
  );
  const tasks = useMemo(() => {
    const combined = [
      ...activeTasks,
      ...recentCompletedTasks.filter(
        (completed) => !activeTasks.some((active) => active.id === completed.id),
      ),
    ];
    if (combined.length > 0) return combined;
    if (runtime.state === "idle") return [];
    return [
      {
        id: "current",
        title: props.conversationTitle || "LiveAgent",
        preview: conversationPreview,
        status:
          runtime.kind === "run_failed"
            ? ("failed" as const)
            : runtime.kind === "run_completed"
              ? ("completed" as const)
              : ("running" as const),
      },
    ];
  }, [activeTasks, conversationPreview, props.conversationTitle, recentCompletedTasks, runtime]);
  const effectiveSettings = useMemo(() => normalizePetSettings(props.settings), [props.settings]);
  const shouldShow = effectiveSettings.enabled && Boolean(effectiveSettings.activePetId);
  const activeConversationCount = tasks.filter((task) => task.status === "running").length;

  const publish = useCallback(async () => {
    if (!shouldShow) return;
    try {
      await emitTo("pet", PET_RUNTIME_EVENT, {
        runtime,
        settings: effectiveSettings,
        conversationTitle: props.conversationTitle,
        conversationPreview,
        activeConversationCount,
        tasks,
      } satisfies PetWindowRuntimePayload);
    } catch (error) {
      console.warn("pet runtime publish failed", error);
    }
  }, [
    conversationPreview,
    activeConversationCount,
    effectiveSettings,
    props.conversationTitle,
    runtime,
    shouldShow,
    tasks,
  ]);

  useEffect(() => {
    void invoke("pet_window_set_visible", { visible: shouldShow }).catch((error) =>
      console.warn("pet window configuration failed", error),
    );
  }, [shouldShow]);

  useEffect(() => {
    if (!shouldShow) return;
    void publish();
    const firstRetry = window.setTimeout(() => void publish(), 250);
    const secondRetry = window.setTimeout(() => void publish(), 900);
    return () => {
      window.clearTimeout(firstRetry);
      window.clearTimeout(secondRetry);
    };
  }, [publish, shouldShow]);

  useEffect(() => {
    let cancelled = false;
    const activePetId = props.settings.activePetId;
    if (!activePetId) return;
    void listPets()
      .then((pets) => {
        if (cancelled || pets.some((pet) => pet.id === activePetId)) return;
        props.setSettings((previous) => ({
          ...previous,
          pet: { ...previous.pet, enabled: false, activePetId: undefined },
        }));
      })
      .catch((error) => console.warn("active pet validation failed", error));
    return () => {
      cancelled = true;
    };
  }, [props.settings.activePetId, props.setSettings]);

  useEffect(() => {
    const missingUnlistenPromise = listen(PET_ASSET_MISSING_EVENT, () => {
      props.setSettings((previous) => ({
        ...previous,
        pet: { ...previous.pet, enabled: false, activePetId: undefined },
      }));
    });
    return () => {
      void missingUnlistenPromise.then((unlisten) => unlisten());
    };
  }, [props.setSettings]);

  useEffect(() => {
    const installedUnlistenPromise = listen<PetInstalledEvent>(PET_INSTALLED_EVENT, (event) => {
      if (!event.payload.activate) return;
      props.setSettings((previous) => ({
        ...previous,
        pet: {
          ...previous.pet,
          enabled: true,
          activePetId: event.payload.pet.id,
        },
      }));
    });
    return () => {
      void installedUnlistenPromise.then((unlisten) => unlisten());
    };
  }, [props.setSettings]);

  useEffect(() => {
    if (!shouldShow) return;
    const unlistenPromise = listen(PET_READY_EVENT, () => {
      void publish();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [publish, shouldShow]);

  return null;
}
