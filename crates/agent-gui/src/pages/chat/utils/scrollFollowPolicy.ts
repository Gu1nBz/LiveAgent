// Scroll-follow policy for the chat transcript viewport.
//
// Pure decision helpers consumed by useLiveTranscriptController. The re-attach
// rules broke twice in 2026-07 ("scroll back to bottom doesn't re-stick"), so
// the device-sensitive judgment calls live here, DOM-free and unit-tested
// (test/chat/scroll-follow-policy.test.mjs).

// Hard "at bottom" tolerance. Fractional devicePixelRatio displays (Windows
// 125%/150% scaling, zoomed webviews) clamp scrollTop 1-3px short of
// scrollHeight - clientHeight, and scrollHeight/clientHeight round
// independently of the fractional scrollTop — the previous 2px threshold sat
// exactly on that boundary, so those devices could never re-attach even when
// the user slammed the viewport into the physical clamp.
export const BOTTOM_ATTACH_THRESHOLD_PX = 8;

// ChatTranscript reserves max(192, composer height + 12)px of blank space
// below the last message so content clears the floating composer. With a
// compact composer most of that band already shows every real content pixel —
// users naturally stop "at the bottom" inside it, dozens of px short of the
// physical clamp, so a clamp-only check can never re-engage them. Any
// user-driven downward scroll that lands inside this zone counts as "scrolled
// back to the bottom".
export const BOTTOM_REATTACH_ZONE_PX = 192;

// Gap wiggle inside this slop is layout noise (virtualizer measurement
// compensation, DPR rounding), not user scroll direction.
export const SCROLL_GAP_DIRECTION_SLOP_PX = 1;

export type ScrollFollowAction = "attach" | "attachAndPin" | "detach" | "none";

export type ScrollFollowDecision = {
  action: ScrollFollowAction;
  // true/false when the event moved toward/away from the bottom; null when
  // there was no user-attributable movement to record.
  towardBottom: boolean | null;
  // Extend the user-intent window so momentum chains outlive the base window.
  refreshIntent: boolean;
};

export function isAtBottom(bottomGap: number) {
  return bottomGap <= BOTTOM_ATTACH_THRESHOLD_PX;
}

export function isWithinReattachZone(bottomGap: number) {
  return bottomGap <= BOTTOM_REATTACH_ZONE_PX;
}

// Trackpad horizontal pans (wide code blocks, tables) carry a few px of
// vertical drift per event; only a dominantly-vertical gesture may change
// follow state.
export function isDominantVerticalWheel(deltaX: number, deltaY: number) {
  return Math.abs(deltaY) > Math.abs(deltaX);
}

export function decideScrollFollowAction(input: {
  bottomGap: number;
  previousBottomGap: number;
  intentActive: boolean;
  pointerHeld: boolean;
}): ScrollFollowDecision {
  const { bottomGap, previousBottomGap, intentActive, pointerHeld } = input;

  if (isAtBottom(bottomGap)) {
    // Physically at the clamp — programmatic pin or user landing — always
    // (re)attach, no intent required. Reaching the bottom also counts as
    // downward movement for the pointer-release re-check.
    return { action: "attach", towardBottom: true, refreshIntent: false };
  }

  if (!intentActive) {
    // Layout-driven scrollTop shifts (virtualizer measurement compensation,
    // content-shrink clamps) never re-decide follow state.
    return { action: "none", towardBottom: null, refreshIntent: false };
  }

  if (bottomGap < previousBottomGap - SCROLL_GAP_DIRECTION_SLOP_PX) {
    // User-driven progress toward the bottom. While a pointer drag is in
    // flight (scrollbar thumb, text selection) attaching would pin the
    // viewport out from under the drag — the release handler re-evaluates.
    return {
      action: !pointerHeld && isWithinReattachZone(bottomGap) ? "attachAndPin" : "none",
      towardBottom: true,
      refreshIntent: true,
    };
  }

  if (pointerHeld && bottomGap > previousBottomGap + SCROLL_GAP_DIRECTION_SLOP_PX) {
    // Scroll-event detach is reserved for pointer drags (scrollbar thumb,
    // selection auto-scroll) — every other user path away from the bottom
    // (wheel-up, touch drag, keys) already detaches synchronously at the
    // input layer. Away-moves without a held pointer are echoes we must not
    // act on: on Windows WebView2 the compositor's wheel smooth-scroll
    // animation keeps emitting frames from its stale trajectory for a few
    // frames after a programmatic pin writes scrollTop (the abort only lands
    // with the next main-thread commit), and treating those as "user scrolled
    // away" tore down follow mode the instant it re-engaged — the
    // Windows-only "scroll back to bottom never re-sticks" failure.
    return { action: "detach", towardBottom: false, refreshIntent: false };
  }

  if (bottomGap > previousBottomGap + SCROLL_GAP_DIRECTION_SLOP_PX) {
    return { action: "none", towardBottom: false, refreshIntent: false };
  }

  return { action: "none", towardBottom: null, refreshIntent: false };
}

export function decidePointerReleaseAction(input: {
  bottomGap: number;
  lastScrollTowardBottom: boolean;
}): Extract<ScrollFollowAction, "attachAndPin" | "none"> {
  // A drag can end anywhere inside the reattach zone without a final scroll
  // event (thumb or touch released "at the bottom"), so the release itself
  // must be able to re-engage.
  return input.lastScrollTowardBottom && isWithinReattachZone(input.bottomGap)
    ? "attachAndPin"
    : "none";
}
