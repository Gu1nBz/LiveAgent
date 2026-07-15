import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const runtime = loader.loadModule("src/lib/pet/runtime.ts");
const windowGeometry = loader.loadModule("src/lib/pet/windowGeometry.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

function liveToolRound({ name = "Bash", running = true, failed = false } = {}) {
  return {
    round: 0,
    key: "r0",
    thinkingOpen: true,
    runningToolCallIds: running ? ["call-1"] : [],
    blocks: [
      {
        kind: "tool",
        item: {
          toolCall: { id: "call-1", name, arguments: {} },
          toolResult: failed ? { isError: true, content: [] } : undefined,
        },
      },
    ],
  };
}

function derive(overrides = {}) {
  return runtime.derivePetRuntimeEvents({
    isSending: false,
    toolStatus: null,
    errorMessage: null,
    isCompactionRunning: false,
    queuedTurnCount: 0,
    backgroundRunCount: 0,
    liveRounds: [],
    ...overrides,
  });
}

test("structural live tool state takes precedence over generic thinking", () => {
  const events = derive({ isSending: true, liveRounds: [liveToolRound({ name: "Bash" })] });
  assert.equal(events[0].kind, "tool_running");
  assert.equal(events[0].state, "running");
  assert.match(events[0].label, /Bash/);
});

test("explicit approval state outranks running tools", () => {
  const events = derive({
    isSending: true,
    toolStatus: "等待用户确认权限",
    liveRounds: [liveToolRound()],
  });
  assert.equal(events[0].kind, "approval_required");
  assert.equal(events[0].state, "waiting");
});

test("conversation error is the highest-priority persistent event", () => {
  const events = derive({
    isSending: true,
    errorMessage: "boom",
    isCompactionRunning: true,
    liveRounds: [liveToolRound()],
  });
  assert.equal(events[0].kind, "run_failed");
  assert.equal(events[0].priority, 100);
});

test("idle current conversation reflects background and queued work", () => {
  const background = derive({ backgroundRunCount: 2, queuedTurnCount: 3 });
  assert.equal(background[0].kind, "background_running");
  assert.match(background[0].label, /2/);

  const queued = derive({ queuedTurnCount: 3 });
  assert.equal(queued[0].kind, "queued");
  assert.equal(queued[0].state, "waiting");
});

test("state machine preempts for higher priority and holds lower-priority transitions", () => {
  const running = derive({ isSending: true })[0];
  const failed = derive({ errorMessage: "boom" })[0];
  const idle = derive()[0];
  assert.equal(runtime.transitionDelayMs(running, failed, 1000, 1100), 0);
  assert.equal(runtime.transitionDelayMs(running, idle, 1000, 1100), 250);
  assert.equal(runtime.transitionDelayMs(running, idle, 1000, 1400), 0);
});

test("equivalent runtime events are detected for cross-window publish deduplication", () => {
  const first = derive({ isSending: true })[0];
  const second = derive({ isSending: true })[0];
  const idle = derive()[0];
  assert.equal(runtime.samePetRuntimeEvent(first, second), true);
  assert.equal(runtime.samePetRuntimeEvent(first, idle), false);
});

test("pointer directions follow Codex clockwise ordering", () => {
  assert.equal(runtime.pointerDirectionIndex(0, -10), 0);
  assert.equal(runtime.pointerDirectionIndex(10, 0), 4);
  assert.equal(runtime.pointerDirectionIndex(0, 10), 8);
  assert.equal(runtime.pointerDirectionIndex(-10, 0), 12);
});

test("standard animations never advance into transparent v2 atlas cells", () => {
  assert.equal(runtime.PET_ANIMATIONS.idle.frameDurations.length, 6);
  assert.equal(runtime.PET_ANIMATIONS.waving.frameDurations.length, 4);
  assert.equal(runtime.PET_ANIMATIONS.jumping.frameDurations.length, 5);
  assert.equal(runtime.PET_ANIMATIONS.failed.frameDurations.length, 8);
  assert.equal(runtime.PET_ANIMATIONS.waiting.frameDurations.length, 6);
  assert.equal(runtime.PET_ANIMATIONS.running.frameDurations.length, 6);
  assert.equal(runtime.PET_ANIMATIONS.review.frameDurations.length, 6);
});

test("drag and hover movement use the dedicated directional rows", () => {
  assert.equal(runtime.resolvePetAnimation("idle", "right").row, 1);
  assert.equal(runtime.resolvePetAnimation("running", "left").row, 2);
  assert.equal(runtime.resolvePetAnimation("running").row, 7);
  assert.equal(runtime.PET_MOVEMENT_ANIMATIONS.right.frameDurations.length, 8);
  assert.equal(runtime.PET_MOVEMENT_ANIMATIONS.left.frameDurations.length, 8);
});

test("pet bubble uses the latest real conversation content", () => {
  const rounds = [
    {
      round: 0,
      key: "r0",
      thinkingOpen: true,
      runningToolCallIds: [],
      blocks: [
        { kind: "thinking", id: "thinking-1", text: "Planning\nIdentifying relevant API CLI tools" },
      ],
    },
  ];
  assert.equal(
    runtime.latestPetConversationPreview(rounds, ""),
    "Identifying relevant API CLI tools",
  );
  assert.equal(runtime.latestPetConversationPreview([], "正在组织最终回答"), "正在组织最终回答");
});

test("pets always use the desktop floating window", () => {
  assert.equal(settings.normalizePetSettings({}).displayMode, "desktop-floating");
  assert.equal(settings.normalizePetSettings({ displayMode: "chat-overlay" }).displayMode, "desktop-floating");
  assert.equal(settings.normalizePetSettings({ displayMode: "unknown" }).displayMode, "desktop-floating");
});

test("desktop pet behavior is fixed while size remains configurable", () => {
  const defaults = settings.normalizePetSettings({});
  assert.equal(defaults.lockPosition, false);
  assert.equal(defaults.clickThrough, false);
  assert.equal(defaults.snapToEdges, false);
  assert.equal(defaults.alwaysOnTop, true);
  assert.equal(defaults.opacity, 1);
  assert.equal(defaults.pointerTracking, "window");
  assert.equal(defaults.showStatusBubble, false);

  const configured = settings.normalizePetSettings({
    lockPosition: true,
    clickThrough: true,
    snapToEdges: true,
    alwaysOnTop: false,
    opacity: 0.4,
    pointerTracking: "off",
    showStatusBubble: true,
    scale: 1.1,
  });
  assert.equal(configured.lockPosition, false);
  assert.equal(configured.clickThrough, false);
  assert.equal(configured.snapToEdges, false);
  assert.equal(configured.alwaysOnTop, true);
  assert.equal(configured.opacity, 1);
  assert.equal(configured.pointerTracking, "window");
  assert.equal(configured.showStatusBubble, false);
  assert.equal(configured.scale, 1.1);
});

test("pet master switch persists independently from the selection", () => {
  assert.equal(settings.normalizePetSettings({ activePetId: "pet-1", enabled: false }).enabled, false);
  assert.equal(settings.normalizePetSettings({ activePetId: "pet-1" }).enabled, true);
  assert.equal(settings.normalizePetSettings({ enabled: true }).enabled, false);
});

test("pet monitor selection handles adjacent screens, gaps, and negative coordinates", () => {
  const monitors = [
    { name: "retina", x: 0, y: 0, width: 1680, height: 1025 },
    { name: "external", x: 1800, y: -200, width: 1920, height: 1080 },
  ];
  assert.equal(windowGeometry.monitorForPoint(monitors, 200, 300).name, "retina");
  assert.equal(windowGeometry.monitorForPoint(monitors, 2500, 300).name, "external");
  assert.equal(windowGeometry.monitorForPoint(monitors, 1760, 300).name, "external");
});

test("pet corner placement uses Codex-style center hysteresis", () => {
  const monitor = { x: 0, y: 0, width: 1920, height: 1080 };
  const leftTop = { horizontal: "left", vertical: "top" };
  assert.equal(windowGeometry.nextPetDockSide(leftTop, monitor, 1000, 580), leftTop);
  assert.deepEqual(windowGeometry.nextPetDockSide(leftTop, monitor, 1100, 700), {
    horizontal: "right",
    vertical: "bottom",
  });
});

test("interactive hit testing has a wider exit radius than entry radius", () => {
  assert.ok(
    windowGeometry.petInteractionPadding(true) >
      windowGeometry.petInteractionPadding(false),
  );
});
