import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const modulePath = path.join(rootDir, "src/pages/chat/utils/scrollFollowPolicy.ts");
const {
  BOTTOM_ATTACH_THRESHOLD_PX,
  BOTTOM_REATTACH_ZONE_PX,
  decidePointerReleaseAction,
  decideScrollFollowAction,
  isDominantVerticalWheel,
} = createTsModuleLoader({ rootDir }).loadModule(modulePath);

test("attach threshold tolerates fractional-DPR clamp shortfall", () => {
  // Windows 125%/150% scaling leaves scrollTop 1-3px short of the clamp even
  // when the user slams the viewport into the bottom.
  assert.ok(BOTTOM_ATTACH_THRESHOLD_PX >= 4);

  const decision = decideScrollFollowAction({
    bottomGap: 3,
    previousBottomGap: 500,
    intentActive: false,
    pointerHeld: false,
  });
  assert.equal(decision.action, "attach");
  assert.equal(decision.towardBottom, true);
});

test("reattach zone covers the transcript bottom reserve dead zone", () => {
  // ChatTranscript reserves max(192, composer + 12)px below the last message;
  // stopping anywhere inside it looks like "the bottom" to the user.
  assert.ok(BOTTOM_REATTACH_ZONE_PX >= 192);
});

test("user-driven downward scroll into the dead zone re-engages and pins", () => {
  const decision = decideScrollFollowAction({
    bottomGap: 60,
    previousBottomGap: 140,
    intentActive: true,
    pointerHeld: false,
  });
  assert.equal(decision.action, "attachAndPin");
  assert.equal(decision.towardBottom, true);
  assert.equal(decision.refreshIntent, true);
});

test("downward progress above the zone only refreshes intent", () => {
  const decision = decideScrollFollowAction({
    bottomGap: 400,
    previousBottomGap: 520,
    intentActive: true,
    pointerHeld: false,
  });
  assert.equal(decision.action, "none");
  assert.equal(decision.refreshIntent, true);
});

test("layout-driven movement without intent never re-decides follow state", () => {
  // Virtualizer measurement compensation shifts scrollTop with no user input.
  for (const bottomGap of [50, 400]) {
    const decision = decideScrollFollowAction({
      bottomGap,
      previousBottomGap: bottomGap + 30,
      intentActive: false,
      pointerHeld: false,
    });
    assert.equal(decision.action, "none");
    assert.equal(decision.towardBottom, null);
  }
});

test("moving away from the bottom during a pointer drag detaches", () => {
  // Scrollbar thumb drags and selection auto-scroll are the only user paths
  // away from the bottom that arrive solely as scroll events.
  const decision = decideScrollFollowAction({
    bottomGap: 90,
    previousBottomGap: 20,
    intentActive: true,
    pointerHeld: true,
  });
  assert.equal(decision.action, "detach");
  assert.equal(decision.towardBottom, false);
});

test("away-moves without a held pointer never detach", () => {
  // Windows WebView2 regression: after a programmatic pin, the compositor's
  // wheel smooth-scroll animation emits a few frames from its stale
  // trajectory (the abort only lands with the next main-thread commit).
  // Those look like "scrolled away with intent" but must not tear down the
  // follow that just re-engaged — wheel-up, touch, and key detaches all
  // happen at the input layer instead.
  const decision = decideScrollFollowAction({
    bottomGap: 130,
    previousBottomGap: 0,
    intentActive: true,
    pointerHeld: false,
  });
  assert.equal(decision.action, "none");
  assert.equal(decision.towardBottom, false);
});

test("sub-pixel gap wiggle with intent is neutral", () => {
  // A click (intent) plus a ±1px compensation event must not tear down follow.
  const decision = decideScrollFollowAction({
    bottomGap: 30,
    previousBottomGap: 30.5,
    intentActive: true,
    pointerHeld: false,
  });
  assert.equal(decision.action, "none");
  assert.equal(decision.towardBottom, null);
});

test("held pointer suppresses zone re-attach but keeps direction and intent", () => {
  // Attaching mid-drag would pin the viewport out from under a scrollbar
  // thumb drag or text selection; the release handler re-evaluates.
  const decision = decideScrollFollowAction({
    bottomGap: 60,
    previousBottomGap: 140,
    intentActive: true,
    pointerHeld: true,
  });
  assert.equal(decision.action, "none");
  assert.equal(decision.towardBottom, true);
  assert.equal(decision.refreshIntent, true);
});

test("pointer release inside the zone after downward movement re-engages", () => {
  assert.equal(
    decidePointerReleaseAction({ bottomGap: 60, lastScrollTowardBottom: true }),
    "attachAndPin",
  );
  assert.equal(
    decidePointerReleaseAction({
      bottomGap: BOTTOM_REATTACH_ZONE_PX + 1,
      lastScrollTowardBottom: true,
    }),
    "none",
  );
  assert.equal(
    decidePointerReleaseAction({ bottomGap: 60, lastScrollTowardBottom: false }),
    "none",
  );
});

test("horizontal trackpad drift is not a vertical scroll gesture", () => {
  assert.equal(isDominantVerticalWheel(-40, -3), false);
  assert.equal(isDominantVerticalWheel(0, -3), true);
  assert.equal(isDominantVerticalWheel(0, 0), false);
  assert.equal(isDominantVerticalWheel(2, 120), true);
});
