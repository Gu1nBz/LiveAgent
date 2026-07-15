import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveRound } from "../chat/messages/uiMessages";
import {
  createRunCompletedEvent,
  derivePetRuntimeEvents,
  samePetRuntimeEvent,
  selectPetRuntimeEvent,
  transitionDelayMs,
} from "./runtime";
import type { PetRuntimeEvent } from "./types";

export function usePetRuntime(input: {
  isSending: boolean;
  toolStatus: string | null;
  errorMessage: string | null;
  isCompactionRunning: boolean;
  queuedTurnCount: number;
  backgroundRunCount: number;
  liveRounds: LiveRound[];
}) {
  const {
    backgroundRunCount,
    errorMessage,
    isCompactionRunning,
    isSending,
    liveRounds,
    queuedTurnCount,
    toolStatus,
  } = input;
  const desired = useMemo(
    () =>
      selectPetRuntimeEvent(
        derivePetRuntimeEvents({
          backgroundRunCount,
          errorMessage,
          isCompactionRunning,
          isSending,
          liveRounds,
          queuedTurnCount,
          toolStatus,
        }),
      ),
    [
      backgroundRunCount,
      errorMessage,
      isCompactionRunning,
      isSending,
      liveRounds,
      queuedTurnCount,
      toolStatus,
    ],
  );
  const desiredRef = useRef(desired);
  desiredRef.current = desired;
  const previousSendingRef = useRef(isSending);
  const enteredAtRef = useRef(Date.now());
  const currentRef = useRef(desired);
  const timerRef = useRef<number | null>(null);
  const [current, setCurrent] = useState<PetRuntimeEvent>(desired);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const commit = (next: PetRuntimeEvent) => {
      clearTimer();
      const previous = currentRef.current;
      if (samePetRuntimeEvent(previous, next)) {
        return;
      }
      currentRef.current = next;
      enteredAtRef.current = Date.now();
      setCurrent(next);
    };
    const scheduleDesired = (candidate: PetRuntimeEvent) => {
      clearTimer();
      const delay = transitionDelayMs(
        currentRef.current,
        candidate,
        enteredAtRef.current,
        Date.now(),
      );
      if (delay === 0) {
        commit(candidate);
        return;
      }
      timerRef.current = window.setTimeout(() => commit(desiredRef.current), delay);
    };

    const justCompleted = previousSendingRef.current && !isSending && !errorMessage;
    previousSendingRef.current = isSending;
    if (justCompleted) {
      const completed = createRunCompletedEvent();
      commit(completed);
      timerRef.current = window.setTimeout(() => commit(desiredRef.current), 3200);
    } else {
      scheduleDesired(desired);
    }
    return clearTimer;
  }, [desired, errorMessage, isSending]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return current;
}
