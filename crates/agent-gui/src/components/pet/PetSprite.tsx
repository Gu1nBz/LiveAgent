import { memo, useEffect, useRef, useState } from "react";
import { readPetSpritesheet } from "../../lib/pet/api";
import {
  type PetMovementDirection,
  pointerDirectionIndex,
  resolvePetAnimation,
} from "../../lib/pet/runtime";
import type { PetAnimationState, PetManifest } from "../../lib/pet/types";
import type { PetSettings } from "../../lib/settings";

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;

export type PetFrameBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type PetFrameGeometry = {
  frameBounds: PetFrameBounds;
  contentBounds: PetFrameBounds;
};

type PetAtlasGeometry = {
  frames: PetFrameBounds[];
  rowBounds: PetFrameBounds[];
};

const FULL_FRAME_BOUNDS: PetFrameBounds = {
  left: 0,
  top: 0,
  right: CELL_WIDTH,
  bottom: CELL_HEIGHT,
};
const atlasGeometryCache = new Map<string, Promise<PetAtlasGeometry>>();

function mirrorBounds(bounds: PetFrameBounds): PetFrameBounds {
  return {
    left: CELL_WIDTH - bounds.right,
    top: bounds.top,
    right: CELL_WIDTH - bounds.left,
    bottom: bounds.bottom,
  };
}

function inspectAtlasGeometry(
  cacheKey: string,
  source: string,
  rows: number,
): Promise<PetAtlasGeometry> {
  const cached = atlasGeometryCache.get(cacheKey);
  if (cached) return cached;
  const request = new Promise<PetAtlasGeometry>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas 2D context is unavailable");
        context.drawImage(image, 0, 0);
        const atlas = context.getImageData(0, 0, canvas.width, canvas.height);
        const frames: PetFrameBounds[] = [];
        const rowBounds: PetFrameBounds[] = [];
        for (let row = 0; row < rows; row += 1) {
          let rowLeft = CELL_WIDTH;
          let rowTop = CELL_HEIGHT;
          let rowRight = 0;
          let rowBottom = 0;
          for (let column = 0; column < 8; column += 1) {
            let left = CELL_WIDTH;
            let top = CELL_HEIGHT;
            let right = 0;
            let bottom = 0;
            for (let y = 0; y < CELL_HEIGHT; y += 1) {
              const atlasY = row * CELL_HEIGHT + y;
              for (let x = 0; x < CELL_WIDTH; x += 1) {
                const atlasX = column * CELL_WIDTH + x;
                if (atlas.data[(atlasY * atlas.width + atlasX) * 4 + 3] <= 8) continue;
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x + 1);
                bottom = Math.max(bottom, y + 1);
              }
            }
            const bounds =
              right > left && bottom > top ? { left, top, right, bottom } : FULL_FRAME_BOUNDS;
            frames.push(bounds);
            if (right > left && bottom > top) {
              rowLeft = Math.min(rowLeft, left);
              rowTop = Math.min(rowTop, top);
              rowRight = Math.max(rowRight, right);
              rowBottom = Math.max(rowBottom, bottom);
            }
          }
          rowBounds.push(
            rowRight > rowLeft && rowBottom > rowTop
              ? { left: rowLeft, top: rowTop, right: rowRight, bottom: rowBottom }
              : FULL_FRAME_BOUNDS,
          );
        }
        resolve({ frames, rowBounds });
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error("Failed to decode pet spritesheet geometry"));
    image.src = source;
  });
  atlasGeometryCache.set(cacheKey, request);
  return request;
}

export const PetSprite = memo(function PetSprite(props: {
  pet: PetManifest;
  state: PetAnimationState;
  settings: PetSettings;
  trackPointer?: boolean;
  lookDirection?: number | null;
  movementDirection?: PetMovementDirection;
  mirrored?: boolean;
  onFrameGeometryChange?: (geometry: PetFrameGeometry) => void;
  onAssetReady?: () => void;
}) {
  const {
    pet,
    state,
    settings,
    trackPointer = false,
    lookDirection: controlledLookDirection,
    movementDirection,
    mirrored = false,
    onFrameGeometryChange,
    onAssetReady,
  } = props;
  const [source, setSource] = useState("");
  const [frame, setFrame] = useState(0);
  const [lookDirection, setLookDirection] = useState<number | null>(null);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [atlasGeometry, setAtlasGeometry] = useState<PetAtlasGeometry | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const animation = resolvePetAnimation(state, movementDirection);

  useEffect(() => {
    let cancelled = false;
    setSource("");
    void readPetSpritesheet(pet.id, pet.assetVersion)
      .then((value) => {
        if (!cancelled) setSource(value);
      })
      .catch((error) => console.warn("pet spritesheet load failed", error));
    return () => {
      cancelled = true;
    };
  }, [pet.assetVersion, pet.id]);

  useEffect(() => {
    let cancelled = false;
    setAtlasGeometry(null);
    if (!source) return;
    const rows = pet.lookDirections ? 11 : 9;
    void inspectAtlasGeometry(`${pet.id}:${pet.assetVersion}`, source, rows)
      .then((geometry) => {
        if (!cancelled) setAtlasGeometry(geometry);
      })
      .catch((error) => {
        console.warn("pet alpha geometry inspection failed", error);
        if (!cancelled) {
          setAtlasGeometry({
            frames: Array.from({ length: rows * 8 }, () => FULL_FRAME_BOUNDS),
            rowBounds: Array.from({ length: rows }, () => FULL_FRAME_BOUNDS),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pet.assetVersion, pet.id, pet.lookDirections, source]);

  useEffect(() => {
    if (atlasGeometry) onAssetReady?.();
  }, [atlasGeometry, onAssetReady]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    setFrame(0);
    if (settings.reducedMotion || systemReducedMotion) return;
    let animationFrame = 0;
    let previousTime = 0;
    let elapsedInFrame = 0;
    let animationIndex = 0;

    const tick = (time: number) => {
      if (previousTime === 0) previousTime = time;
      elapsedInFrame += Math.min(250, time - previousTime);
      previousTime = time;
      let changed = false;
      while (elapsedInFrame >= (animation.frameDurations[animationIndex] ?? 140)) {
        elapsedInFrame -= animation.frameDurations[animationIndex] ?? 140;
        if (!animation.loop && animationIndex === animation.frameDurations.length - 1) {
          elapsedInFrame = 0;
          break;
        }
        animationIndex = (animationIndex + 1) % animation.frameDurations.length;
        changed = true;
      }
      if (changed) setFrame(animationIndex);
      animationFrame = window.requestAnimationFrame(tick);
    };
    const syncVisibility = () => {
      window.cancelAnimationFrame(animationFrame);
      previousTime = 0;
      elapsedInFrame = 0;
      if (document.visibilityState === "visible") {
        animationFrame = window.requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [animation, settings.reducedMotion, systemReducedMotion]);

  useEffect(() => {
    if (
      !trackPointer ||
      !pet.lookDirections ||
      state !== "idle" ||
      settings.pointerTracking === "off"
    ) {
      setLookDirection(null);
      return;
    }
    const onPointerMove = (event: PointerEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = event.clientX - centerX;
      const dy = event.clientY - centerY;
      const distance = Math.hypot(dx, dy);
      if (settings.pointerTracking === "nearby" && distance > 480) {
        setLookDirection(null);
        return;
      }
      setLookDirection(pointerDirectionIndex(dx, dy));
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [pet.lookDirections, settings.pointerTracking, state, trackPointer]);

  const activeLookDirection =
    controlledLookDirection === undefined ? lookDirection : controlledLookDirection;
  const row = activeLookDirection === null ? animation.row : activeLookDirection < 8 ? 9 : 10;
  const column = activeLookDirection === null ? frame : activeLookDirection % 8;
  const scale = settings.scale;

  useEffect(() => {
    if (!onFrameGeometryChange) return;
    const frameBounds = atlasGeometry?.frames[row * 8 + column] ?? FULL_FRAME_BOUNDS;
    const contentBounds = atlasGeometry?.rowBounds[row] ?? FULL_FRAME_BOUNDS;
    onFrameGeometryChange({
      frameBounds: mirrored ? mirrorBounds(frameBounds) : frameBounds,
      contentBounds: mirrored ? mirrorBounds(contentBounds) : contentBounds,
    });
  }, [atlasGeometry, column, mirrored, onFrameGeometryChange, row]);

  return (
    <div
      ref={rootRef}
      role="img"
      className="relative overflow-hidden"
      style={{
        width: CELL_WIDTH * scale,
        height: CELL_HEIGHT * scale,
        opacity: settings.opacity,
        transform: mirrored ? "scaleX(-1)" : undefined,
      }}
      aria-label={`${pet.displayName} · ${animation.label}`}
    >
      {source ? (
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: CELL_WIDTH,
            height: CELL_HEIGHT,
            transform: `scale(${scale})`,
            backgroundImage: `url(${source})`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: `-${column * CELL_WIDTH}px -${row * CELL_HEIGHT}px`,
            backgroundSize: `${CELL_WIDTH * 8}px ${CELL_HEIGHT * (pet.lookDirections ? 11 : 9)}px`,
          }}
        />
      ) : null}
    </div>
  );
});
