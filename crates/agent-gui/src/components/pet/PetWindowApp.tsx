import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listPets, PET_LIBRARY_CHANGED_EVENT } from "../../lib/pet/api";
import { pointerDirectionIndex } from "../../lib/pet/runtime";
import type { PetManifest } from "../../lib/pet/types";
import {
  monitorForPoint,
  nextPetDockSide,
  petInteractionPadding,
} from "../../lib/pet/windowGeometry";
import { ChevronDown } from "../icons";
import { type PetFrameGeometry, PetSprite } from "./PetSprite";
import {
  PET_ASSET_MISSING_EVENT,
  PET_READY_EVENT,
  PET_RUNTIME_EVENT,
  type PetWindowRuntimePayload,
} from "./PetWindowBridge";

type PointerSnapshot = {
  cursorX: number;
  cursorY: number;
  windowX: number;
  windowY: number;
  scaleFactor: number;
  monitorX: number;
  monitorY: number;
  monitorWidth: number;
  monitorHeight: number;
  monitors: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    name: string | null;
  }>;
  primaryButtonPressed: boolean | null;
  monitorName: string | null;
};

type PetVisibleBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const PET_CELL_WIDTH = 192;
const PET_CELL_HEIGHT = 208;
const FULL_PET_FRAME_GEOMETRY: PetFrameGeometry = {
  frameBounds: { left: 0, top: 0, right: PET_CELL_WIDTH, bottom: PET_CELL_HEIGHT },
  contentBounds: { left: 0, top: 0, right: PET_CELL_WIDTH, bottom: PET_CELL_HEIGHT },
};

type PetDragSession = {
  offsetX: number;
  offsetY: number;
  timer: number;
  inFlight: boolean;
  targetMonitorName: string | null;
  lastCursorX: number;
};

function visibleBoundsEqual(a: PetVisibleBounds | null, b: PetVisibleBounds) {
  return a?.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

export function PetWindowApp() {
  const [payload, setPayload] = useState<PetWindowRuntimePayload | null>(null);
  const [pet, setPet] = useState<PetManifest | null>(null);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [lookDirection, setLookDirection] = useState<number | null>(null);
  const [bubbleExpanded, setBubbleExpanded] = useState(true);
  const [hoverMotion, setHoverMotion] = useState<{
    moving: boolean;
    direction: "left" | "right";
  }>({ moving: false, direction: "right" });
  const [dragMotion, setDragMotion] = useState<{
    moving: boolean;
    direction: "left" | "right";
  }>({ moving: false, direction: "right" });
  const [frameGeometry, setFrameGeometry] = useState<PetFrameGeometry>(FULL_PET_FRAME_GEOMETRY);
  const frameGeometryRef = useRef<PetFrameGeometry>(FULL_PET_FRAME_GEOMETRY);
  const spriteHostRef = useRef<HTMLDivElement>(null);
  const bubbleShellRef = useRef<HTMLDivElement>(null);
  const statusControlRef = useRef<HTMLButtonElement>(null);
  const interactionDesiredRef = useRef(true);
  const interactionAppliedRef = useRef<boolean | null>(null);
  const interactionSyncRunningRef = useRef(false);
  const componentAliveRef = useRef(true);
  const dragGestureRef = useRef(false);
  const nativeButtonTrackingRef = useRef(false);
  const dragSessionRef = useRef<PetDragSession | null>(null);
  const dragRequestIdRef = useRef(0);
  const visibleBoundsRef = useRef<PetVisibleBounds | null>(null);
  const monitorTopologyRef = useRef("");
  const scaleFactorRef = useRef(1);
  const previousSpriteCenterRef = useRef<{ x: number; y: number } | null>(null);
  const layoutCorrectionInFlightRef = useRef(false);
  const layoutCorrectionPendingRef = useRef({ x: 0, y: 0 });
  const [dockSide, setDockSide] = useState<{
    horizontal: "left" | "right";
    vertical: "top" | "bottom";
  }>({ horizontal: "right", vertical: "bottom" });

  const requestWindowInteraction = useCallback((interactive: boolean) => {
    interactionDesiredRef.current = interactive;
    if (interactionSyncRunningRef.current) return;
    interactionSyncRunningRef.current = true;
    const sync = async () => {
      while (
        componentAliveRef.current &&
        interactionAppliedRef.current !== interactionDesiredRef.current
      ) {
        const target = interactionDesiredRef.current;
        try {
          await invoke("pet_window_set_interaction", {
            clickThrough: !target,
            alwaysOnTop: true,
          });
          interactionAppliedRef.current = target;
        } catch (error) {
          console.warn("pet window hit testing failed", error);
          break;
        }
      }
      interactionSyncRunningRef.current = false;
      if (
        componentAliveRef.current &&
        interactionAppliedRef.current !== interactionDesiredRef.current
      ) {
        window.setTimeout(() => requestWindowInteraction(interactionDesiredRef.current), 40);
      }
    };
    void sync();
  }, []);

  const markPetAssetReady = useCallback(() => {
    void invoke("pet_window_mark_ready").catch((error) =>
      console.warn("pet window ready display failed", error),
    );
  }, []);

  const handleFrameGeometryChange = useCallback((geometry: PetFrameGeometry) => {
    frameGeometryRef.current = geometry;
    setFrameGeometry(geometry);
  }, []);

  const stopCustomDrag = useCallback(() => {
    const commitRequestId = ++dragRequestIdRef.current;
    const wasDragging = dragGestureRef.current || Boolean(dragSessionRef.current);
    const targetMonitorName = dragSessionRef.current?.targetMonitorName ?? null;
    dragGestureRef.current = false;
    const session = dragSessionRef.current;
    if (session) window.clearInterval(session.timer);
    dragSessionRef.current = null;
    setDragMotion((previous) => ({ ...previous, moving: false }));
    if (wasDragging && componentAliveRef.current) {
      void invoke<PointerSnapshot>("pet_window_pointer_snapshot")
        .then((snapshot) => {
          if (
            commitRequestId !== dragRequestIdRef.current ||
            dragGestureRef.current ||
            dragSessionRef.current
          ) {
            return;
          }
          return invoke("pet_window_commit_position", {
            input: {
              x: Math.round(snapshot.windowX),
              y: Math.round(snapshot.windowY),
              snapToEdges: false,
              visibleBounds: visibleBoundsRef.current,
              targetMonitorName,
            },
          });
        })
        .catch((error) => console.warn("pet drag-end position save failed", error));
    }
  }, []);

  const startCustomDrag = useCallback(async () => {
    stopCustomDrag();
    dragGestureRef.current = true;
    requestWindowInteraction(true);
    const requestId = ++dragRequestIdRef.current;
    try {
      const snapshot = await invoke<PointerSnapshot>("pet_window_pointer_snapshot");
      if (requestId !== dragRequestIdRef.current) return;
      nativeButtonTrackingRef.current = snapshot.primaryButtonPressed !== null;
      if (snapshot.primaryButtonPressed === false) {
        stopCustomDrag();
        return;
      }
      const session: PetDragSession = {
        offsetX: snapshot.cursorX - snapshot.windowX,
        offsetY: snapshot.cursorY - snapshot.windowY,
        timer: 0,
        inFlight: false,
        targetMonitorName: snapshot.monitorName,
        lastCursorX: snapshot.cursorX,
      };
      const tick = async () => {
        if (dragSessionRef.current !== session || session.inFlight) return;
        session.inFlight = true;
        try {
          const pointer = await invoke<PointerSnapshot>("pet_window_pointer_snapshot");
          nativeButtonTrackingRef.current = pointer.primaryButtonPressed !== null;
          if (pointer.primaryButtonPressed === false) {
            stopCustomDrag();
            return;
          }
          const cursorDeltaX = pointer.cursorX - session.lastCursorX;
          session.lastCursorX = pointer.cursorX;
          setDragMotion((previous) => ({
            moving: true,
            direction:
              Math.abs(cursorDeltaX) < 0.5
                ? previous.direction
                : cursorDeltaX < 0
                  ? "left"
                  : "right",
          }));
          const currentTarget = pointer.monitors.find(
            (monitor) => monitor.name === session.targetMonitorName,
          );
          const withinTargetHysteresis = Boolean(
            currentTarget &&
              pointer.cursorX >= currentTarget.x - 24 &&
              pointer.cursorX < currentTarget.x + currentTarget.width + 24 &&
              pointer.cursorY >= currentTarget.y - 24 &&
              pointer.cursorY < currentTarget.y + currentTarget.height + 24,
          );
          if (!withinTargetHysteresis) session.targetMonitorName = pointer.monitorName;
          await invoke("pet_window_constrain_position", {
            input: {
              x: Math.round(pointer.cursorX - session.offsetX),
              y: Math.round(pointer.cursorY - session.offsetY),
              snapToEdges: false,
              visibleBounds: visibleBoundsRef.current,
              targetMonitorName: session.targetMonitorName,
            },
          });
        } catch (error) {
          console.warn("pet constrained drag failed", error);
          stopCustomDrag();
        } finally {
          session.inFlight = false;
        }
      };
      session.timer = window.setInterval(() => void tick(), 16);
      dragSessionRef.current = session;
      setDragMotion((previous) => ({ ...previous, moving: true }));
      void tick();
    } catch (error) {
      console.warn("pet drag start failed", error);
      stopCustomDrag();
    }
  }, [requestWindowInteraction, stopCustomDrag]);

  useLayoutEffect(() => {
    // These values intentionally trigger a post-layout anchor measurement.
    void bubbleExpanded;
    void dockSide;
    void payload?.tasks.length;
    void payload?.settings.scale;
    const rect = spriteHostRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const previous = previousSpriteCenterRef.current;
    const session = dragSessionRef.current;
    if (previous) {
      const deltaX = (current.x - previous.x) * scaleFactorRef.current;
      const deltaY = (current.y - previous.y) * scaleFactorRef.current;
      if (session) {
        session.offsetX += deltaX;
        session.offsetY += deltaY;
      } else if (Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5) {
        // Bubble/placement changes must not move the pet's screen anchor. Move
        // the transparent carrier window in the opposite direction after the
        // DOM layout changes, then let the normal visible-bounds pass clamp it.
        layoutCorrectionPendingRef.current.x += deltaX;
        layoutCorrectionPendingRef.current.y += deltaY;
        if (layoutCorrectionInFlightRef.current) {
          previousSpriteCenterRef.current = current;
          return;
        }
        layoutCorrectionInFlightRef.current = true;
        const flushLayoutCorrection = async () => {
          try {
            while (
              Math.abs(layoutCorrectionPendingRef.current.x) >= 0.5 ||
              Math.abs(layoutCorrectionPendingRef.current.y) >= 0.5
            ) {
              const pending = layoutCorrectionPendingRef.current;
              layoutCorrectionPendingRef.current = { x: 0, y: 0 };
              const snapshot = await invoke<PointerSnapshot>("pet_window_pointer_snapshot");
              await invoke("pet_window_constrain_position", {
                input: {
                  x: Math.round(snapshot.windowX - pending.x),
                  y: Math.round(snapshot.windowY - pending.y),
                  snapToEdges: false,
                  visibleBounds: visibleBoundsRef.current,
                },
              });
            }
          } catch (error) {
            console.warn("pet anchor layout correction failed", error);
          } finally {
            layoutCorrectionInFlightRef.current = false;
          }
        };
        void flushLayoutCorrection();
      }
    }
    previousSpriteCenterRef.current = current;
  }, [bubbleExpanded, dockSide, payload?.tasks.length, payload?.settings.scale]);

  useEffect(() => {
    componentAliveRef.current = true;
    return () => {
      componentAliveRef.current = false;
      dragRequestIdRef.current += 1;
      dragGestureRef.current = false;
      const session = dragSessionRef.current;
      if (session) window.clearInterval(session.timer);
      dragSessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    const finishDrag = () => {
      if (dragGestureRef.current || dragSessionRef.current) stopCustomDrag();
    };
    window.addEventListener("pointerup", finishDrag, true);
    const cancelDrag = () => {
      if (!nativeButtonTrackingRef.current) finishDrag();
    };
    window.addEventListener("pointercancel", cancelDrag, true);
    return () => {
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("pointercancel", cancelDrag, true);
    };
  }, [stopCustomDrag]);

  useEffect(() => {
    document.documentElement.classList.add("pet-window");
    const unlistenPromise = listen<PetWindowRuntimePayload>(PET_RUNTIME_EVENT, (event) => {
      setPayload(event.payload);
    });
    const libraryUnlistenPromise = listen(PET_LIBRARY_CHANGED_EVENT, () => {
      setLibraryRevision((revision) => revision + 1);
    });
    void emit(PET_READY_EVENT);
    return () => {
      document.documentElement.classList.remove("pet-window");
      void unlistenPromise.then((unlisten) => unlisten());
      void libraryUnlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    void libraryRevision;
    let cancelled = false;
    const activePetId = payload?.settings.activePetId;
    frameGeometryRef.current = FULL_PET_FRAME_GEOMETRY;
    setFrameGeometry(FULL_PET_FRAME_GEOMETRY);
    if (!activePetId) {
      setPet(null);
      return;
    }
    void listPets()
      .then((pets) => {
        if (cancelled) return;
        const nextPet = pets.find((item) => item.id === activePetId) ?? null;
        setPet(nextPet);
        if (!nextPet) void emit(PET_ASSET_MISSING_EVENT, { petId: activePetId });
      })
      .catch((error) => console.warn("pet window library load failed", error));
    return () => {
      cancelled = true;
    };
  }, [libraryRevision, payload?.settings.activePetId]);

  useEffect(() => {
    if (!payload || !pet) return;
    let cancelled = false;
    const update = async () => {
      try {
        const snapshot = await invoke<PointerSnapshot>("pet_window_pointer_snapshot");
        if (cancelled) return;
        const monitorTopology = snapshot.monitors
          .map(
            (monitor) =>
              `${monitor.name ?? ""}:${monitor.x},${monitor.y},${monitor.width},${monitor.height}`,
          )
          .sort()
          .join("|");
        const monitorTopologyChanged =
          monitorTopologyRef.current !== "" && monitorTopologyRef.current !== monitorTopology;
        monitorTopologyRef.current = monitorTopology;
        const factor = snapshot.scaleFactor || 1;
        scaleFactorRef.current = factor;
        const cursorX = (snapshot.cursorX - snapshot.windowX) / factor;
        const cursorY = (snapshot.cursorY - snapshot.windowY) / factor;
        const spriteRect = spriteHostRef.current?.getBoundingClientRect();
        const spriteWidth = spriteRect?.width ?? PET_CELL_WIDTH * payload.settings.scale;
        const spriteHeight = spriteRect?.height ?? PET_CELL_HEIGHT * payload.settings.scale;
        const spriteLeft = spriteRect?.left ?? window.innerWidth / 2 - spriteWidth / 2;
        const spriteTop =
          spriteRect?.top ?? window.innerHeight - 8 - PET_CELL_HEIGHT * payload.settings.scale;
        const rectFromFrameBounds = (bounds: PetFrameGeometry["frameBounds"]) => ({
          left: spriteLeft + (bounds.left / PET_CELL_WIDTH) * spriteWidth,
          top: spriteTop + (bounds.top / PET_CELL_HEIGHT) * spriteHeight,
          right: spriteLeft + (bounds.right / PET_CELL_WIDTH) * spriteWidth,
          bottom: spriteTop + (bounds.bottom / PET_CELL_HEIGHT) * spriteHeight,
        });
        const currentFrameGeometry = frameGeometryRef.current;
        const frameRect = rectFromFrameBounds(currentFrameGeometry.frameBounds);
        const petBounds = rectFromFrameBounds(currentFrameGeometry.contentBounds);
        const spriteCenterX = (petBounds.left + petBounds.right) / 2;
        const spriteCenterY = (petBounds.top + petBounds.bottom) / 2;
        const dx = cursorX - spriteCenterX;
        const dy = cursorY - spriteCenterY;
        const visibleRects = [
          petBounds,
          bubbleShellRef.current?.getBoundingClientRect(),
          statusControlRef.current?.getBoundingClientRect(),
        ].filter((rect): rect is DOMRect | typeof petBounds => Boolean(rect));
        const nextVisibleBounds = {
          left: Math.floor(Math.min(...visibleRects.map((rect) => rect.left)) * factor),
          top: Math.floor(Math.min(...visibleRects.map((rect) => rect.top)) * factor),
          right: Math.ceil(Math.max(...visibleRects.map((rect) => rect.right)) * factor),
          bottom: Math.ceil(Math.max(...visibleRects.map((rect) => rect.bottom)) * factor),
        };
        const visibleBoundsChanged = !visibleBoundsEqual(
          visibleBoundsRef.current,
          nextVisibleBounds,
        );
        visibleBoundsRef.current = nextVisibleBounds;
        const absolutePetX = snapshot.windowX + spriteCenterX * factor;
        const absolutePetY = snapshot.windowY + spriteCenterY * factor;
        // Docking must follow the monitor that actually contains the pet. Using
        // the cursor monitor here makes an idle pet flip layout (and potentially
        // move outside the work area) as soon as the cursor visits another screen.
        const petMonitor = monitorForPoint(snapshot.monitors, absolutePetX, absolutePetY) ?? {
          x: snapshot.monitorX,
          y: snapshot.monitorY,
          width: snapshot.monitorWidth,
          height: snapshot.monitorHeight,
        };
        setDockSide((previous) =>
          nextPetDockSide(previous, petMonitor, absolutePetX, absolutePetY),
        );
        // A dock flip, bubble expansion, task update, or DPI transition changes
        // the visible content inside the fixed transparent window. Re-apply the
        // boundary immediately so the sprite itself can never remain off-screen,
        // even if pointer capture ended during a cross-monitor drag.
        if (
          (visibleBoundsChanged || monitorTopologyChanged) &&
          !dragSessionRef.current &&
          !layoutCorrectionInFlightRef.current
        ) {
          void invoke("pet_window_constrain_position", {
            input: {
              x: Math.round(snapshot.windowX),
              y: Math.round(snapshot.windowY),
              snapToEdges: false,
              visibleBounds: nextVisibleBounds,
            },
          }).catch((error) => console.warn("pet layout boundary update failed", error));
        }
        const pointInside = (
          rect: { left: number; top: number; right: number; bottom: number } | undefined,
          padding = 0,
        ) =>
          Boolean(
            rect &&
              cursorX >= rect.left - padding &&
              cursorX <= rect.right + padding &&
              cursorY >= rect.top - padding &&
              cursorY <= rect.bottom + padding,
          );
        // Enter slightly before the pointer reaches an opaque sprite edge so
        // AppKit has time to disable pass-through; use a wider exit radius to
        // avoid toggling around that boundary.
        const interactionPadding = petInteractionPadding(interactionDesiredRef.current);
        const cursorNearInteractivePet = pointInside(frameRect, interactionPadding);
        const interactive =
          dragGestureRef.current ||
          cursorNearInteractivePet ||
          pointInside(bubbleShellRef.current?.getBoundingClientRect()) ||
          pointInside(statusControlRef.current?.getBoundingClientRect());
        requestWindowInteraction(interactive);

        if (dragMotion.moving || payload.runtime.state !== "idle") {
          setLookDirection(null);
          setHoverMotion((previous) =>
            previous.moving ? { ...previous, moving: false } : previous,
          );
          return;
        }
        const nearPet = pointInside(frameRect, 28);
        setHoverMotion((previous) => {
          const direction = Math.abs(dx) < 2 ? previous.direction : dx < 0 ? "left" : "right";
          return previous.moving === nearPet && previous.direction === direction
            ? previous
            : { moving: nearPet, direction };
        });
        setLookDirection(nearPet || !pet.lookDirections ? null : pointerDirectionIndex(dx, dy));
      } catch (error) {
        console.warn("pet global pointer tracking failed", error);
      }
    };
    let updateInFlight = false;
    const runUpdate = async () => {
      if (updateInFlight) return;
      updateInFlight = true;
      try {
        await update();
      } finally {
        updateInFlight = false;
      }
    };
    void runUpdate();
    const timer = window.setInterval(() => void runUpdate(), 16);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      setHoverMotion((previous) => ({ ...previous, moving: false }));
    };
  }, [dragMotion.moving, payload, pet, requestWindowInteraction]);

  if (!payload || !pet) return null;

  return (
    <div
      className={`flex h-full w-full flex-col items-center overflow-hidden ${
        dockSide.vertical === "top" ? "justify-start pt-2" : "justify-end pb-2"
      }`}
    >
      {payload.tasks.length > 0 ? (
        bubbleExpanded ? (
          <div
            ref={bubbleShellRef}
            data-pet-placement={dockSide.vertical === "top" ? "below" : "above"}
            className={`pet-status-shell ${
              dockSide.horizontal === "left" ? "ml-12 self-start" : "mr-12 self-end"
            }`}
            style={{ order: dockSide.vertical === "top" ? 2 : 1 }}
          >
            <div className="pet-status-list">
              {payload.tasks.slice(0, 3).map((task) => (
                <div key={task.id} role="status" aria-live="polite" className="pet-status-bubble">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold leading-4">
                      {task.title}
                    </span>
                    <span className="block truncate text-[12px] font-normal leading-4 text-zinc-600">
                      {task.preview}
                    </span>
                  </span>
                  {task.status === "completed" ? (
                    <span className="pet-status-complete" role="img" aria-label="已完成">
                      ✓
                    </span>
                  ) : task.status === "failed" ? (
                    <span className="pet-status-failed" role="img" aria-label="失败">
                      !
                    </span>
                  ) : (
                    <span className="pet-status-spinner" aria-hidden />
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : null
      ) : null}
      <div
        ref={spriteHostRef}
        className={`relative ${dockSide.horizontal === "left" ? "ml-12 self-start" : "mr-12 self-end"}`}
        style={{ order: dockSide.vertical === "top" ? 1 : 2 }}
      >
        {payload.tasks.length > 0 ? (
          <button
            ref={statusControlRef}
            type="button"
            className={`pet-status-control ${bubbleExpanded ? "pet-status-toggle" : "pet-status-count"}`}
            aria-label={
              bubbleExpanded
                ? "收起任务气泡"
                : payload.activeConversationCount > 0
                  ? `${payload.activeConversationCount} 个正在进行的任务对话，点击展开`
                  : "查看最近完成的任务对话"
            }
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setBubbleExpanded((expanded) => !expanded)}
          >
            {bubbleExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : payload.activeConversationCount > 0 ? (
              payload.activeConversationCount
            ) : (
              "✓"
            )}
          </button>
        ) : null}
        <div
          className={`pet-drag-hitbox ${dragMotion.moving ? "cursor-grabbing" : "cursor-grab"}`}
          style={{
            left: `${(frameGeometry.frameBounds.left / PET_CELL_WIDTH) * 100}%`,
            top: `${(frameGeometry.frameBounds.top / PET_CELL_HEIGHT) * 100}%`,
            width: `${
              ((frameGeometry.frameBounds.right - frameGeometry.frameBounds.left) /
                PET_CELL_WIDTH) *
              100
            }%`,
            height: `${
              ((frameGeometry.frameBounds.bottom - frameGeometry.frameBounds.top) /
                PET_CELL_HEIGHT) *
              100
            }%`,
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            void startCustomDrag();
          }}
          onPointerMove={(event) => {
            if (
              !nativeButtonTrackingRef.current &&
              dragSessionRef.current &&
              (event.buttons & 1) === 0
            ) {
              stopCustomDrag();
            }
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            stopCustomDrag();
          }}
          onPointerCancel={() => {
            if (!nativeButtonTrackingRef.current) stopCustomDrag();
          }}
          onLostPointerCapture={() => {
            if (!nativeButtonTrackingRef.current) stopCustomDrag();
          }}
        />
        <PetSprite
          pet={pet}
          state={payload.runtime.state}
          settings={payload.settings}
          lookDirection={dragMotion.moving || hoverMotion.moving ? null : lookDirection}
          movementDirection={
            dragMotion.moving
              ? dragMotion.direction
              : hoverMotion.moving
                ? hoverMotion.direction
                : undefined
          }
          onFrameGeometryChange={handleFrameGeometryChange}
          onAssetReady={markPetAssetReady}
        />
      </div>
    </div>
  );
}
