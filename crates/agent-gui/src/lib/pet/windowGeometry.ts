export type PetMonitorArea = {
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string | null;
};

export type PetDockSide = {
  horizontal: "left" | "right";
  vertical: "top" | "bottom";
};

function squaredDistanceToArea(monitor: PetMonitorArea, x: number, y: number) {
  const right = monitor.x + monitor.width;
  const bottom = monitor.y + monitor.height;
  const dx = x < monitor.x ? monitor.x - x : x > right ? x - right : 0;
  const dy = y < monitor.y ? monitor.y - y : y > bottom ? y - bottom : 0;
  return dx * dx + dy * dy;
}

export function monitorForPoint(monitors: PetMonitorArea[], x: number, y: number) {
  return (
    monitors.find(
      (monitor) =>
        x >= monitor.x &&
        x < monitor.x + monitor.width &&
        y >= monitor.y &&
        y < monitor.y + monitor.height,
    ) ??
    monitors.reduce<PetMonitorArea | undefined>((closest, monitor) => {
      if (!closest) return monitor;
      return squaredDistanceToArea(monitor, x, y) < squaredDistanceToArea(closest, x, y)
        ? monitor
        : closest;
    }, undefined)
  );
}

export function nextPetDockSide(
  previous: PetDockSide,
  monitor: PetMonitorArea,
  petX: number,
  petY: number,
  hysteresis = 96,
): PetDockSide {
  const middleX = monitor.x + monitor.width / 2;
  const middleY = monitor.y + monitor.height / 2;
  const horizontal =
    previous.horizontal === "left"
      ? petX > middleX + hysteresis
        ? "right"
        : "left"
      : petX < middleX - hysteresis
        ? "left"
        : "right";
  const vertical =
    previous.vertical === "top"
      ? petY > middleY + hysteresis
        ? "bottom"
        : "top"
      : petY < middleY - hysteresis
        ? "top"
        : "bottom";
  return previous.horizontal === horizontal && previous.vertical === vertical
    ? previous
    : { horizontal, vertical };
}

export function petInteractionPadding(interactive: boolean) {
  return interactive ? 18 : 12;
}
