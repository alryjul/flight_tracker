"use client";

import { useEffect } from "react";

// Why: ambient / kiosk mode is meant to be glanceable from across the
// room — a stationary cursor sitting on the screen is a permanent
// distraction. Hiding it after a short idle period keeps the display
// clean while letting the cursor reappear instantly on real user
// interaction (mouse move, key press, scroll, touch).
//
// Implementation: toggles a `cursor-idle` class on <html>. The CSS
// rule lives in app/globals.css and applies `cursor: none` to
// <html> + every descendant (with `!important` to override
// component-level cursor styles like `cursor-pointer` on buttons or
// the `.maplibregl-canvas-container { cursor: grab }` from MapLibre's
// stylesheet). We use <html> rather than <body> so the rule covers
// every paintable region of the viewport regardless of how the body's
// box is sized in any future layout refactor.
//
// `idleTimeoutMs = 0` disables the behavior entirely (cursor always
// visible) — useful as a kill switch.
//
// Listeners are passive and registered on `window` so they catch
// every interaction regardless of whether anything else handled the
// event. We listen for a deliberately wide set of events so the
// cursor reappears for any plausible "user is here" signal:
//   - mousemove   — primary trigger (with jitter filter; see below)
//   - mousedown   — clicks (a click without movement still counts)
//   - keydown     — keyboard shortcuts
//   - wheel       — scrolling without moving the cursor
//   - touchstart  — touch devices
//   - pointerdown — pen/stylus
//
// Jitter filter: wireless mice and trackpads can fire `mousemove`
// events with very small `movementX/Y` even when the user isn't
// actively moving (sensor noise, palm-edge contact). Without a
// filter, those phantom events would keep resetting the idle timer
// and the cursor would never hide. We ignore moves under
// `MOUSE_JITTER_THRESHOLD_PX` of total displacement; intentional
// motion easily exceeds that on the very first frame.
const MOUSE_JITTER_THRESHOLD_PX = 3;
const CURSOR_IDLE_CLASS = "cursor-idle";

export function useAutoHideCursor(idleTimeoutMs = 3000) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    if (idleTimeoutMs <= 0) {
      // Defensive: ensure the class isn't lingering from a prior
      // mount with a non-zero timeout.
      root.classList.remove(CURSOR_IDLE_CLASS);
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const armHide = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        root.classList.add(CURSOR_IDLE_CLASS);
      }, idleTimeoutMs);
    };

    const showCursor = () => {
      root.classList.remove(CURSOR_IDLE_CLASS);
      armHide();
    };

    const handleMouseMove = (event: MouseEvent) => {
      // Why: filter sensor noise. Real movement easily exceeds the
      // threshold on its first frame; phantom events typically have
      // sub-pixel `movementX/Y` from the OS's accumulator.
      const distance =
        Math.abs(event.movementX) + Math.abs(event.movementY);
      if (distance < MOUSE_JITTER_THRESHOLD_PX) return;
      showCursor();
    };

    // Why: arm the timer on mount so the cursor hides even if the
    // user doesn't interact at all (e.g., they alt-tabbed straight
    // into ambient mode). Without this, the cursor stays visible
    // until the first mousemove, defeating the purpose.
    armHide();

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    const intentEvents: Array<keyof WindowEventMap> = [
      "mousedown",
      "keydown",
      "wheel",
      "touchstart",
      "pointerdown"
    ];
    for (const evt of intentEvents) {
      window.addEventListener(evt, showCursor, { passive: true });
    }

    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      // Why: leave the cursor visible on unmount — otherwise a
      // remount with idleTimeoutMs=0 would race against the lingering
      // class.
      root.classList.remove(CURSOR_IDLE_CLASS);
      window.removeEventListener("mousemove", handleMouseMove);
      for (const evt of intentEvents) {
        window.removeEventListener(evt, showCursor);
      }
    };
  }, [idleTimeoutMs]);
}
