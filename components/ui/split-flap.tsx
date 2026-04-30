"use client";

// Why: a Solari-board / split-flap display, hand-rolled. We started by
// trying react-split-flap-effect but its peer-dep is pinned to React 16
// and won't install cleanly with React 19. Re-implementing gives us
// full control over theming, character sets, and timing — and it's
// only ~150 lines.
//
// Architecture (mirrors the original library):
//   1. <Flap>            — a single half-clipped layer (top or bottom)
//   2. <FlapDigit>       — one character cell, composed of 4 stacked
//                          Flaps (2 static + 2 animated). The two
//                          animated layers perform the visible flip
//                          via CSS keyframes; the static layers show
//                          the steady state.
//   3. <FlapStack>       — owns the cycling logic for one cell.
//                          Advances `current` through the character
//                          set via setInterval until it reaches the
//                          `target` for `value`. Each tick re-renders
//                          FlapDigit, which re-mounts its animated
//                          layers (via key prop) to restart the flip
//                          animation.
//   4. <SplitFlapDisplay> — the public API. Splits a string into
//                          characters and renders one FlapStack per
//                          character.
//
// Keyframes + clip-path classes live in app/globals.css.

import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";

// Why: predefined character sets. Order matters — cycling moves
// forward through the array, so a digit going from 0 to 9 cycles
// through 1-8 visibly. Including a leading space lets us pad blanks
// and animate to/from blank (e.g., a 6-cell display showing "WN1184"
// then changing to "PGR1390" visibly flips the trailing cells).
const CHAR_SETS = {
  numeric: " 0123456789".split(""),
  alpha: " ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  alphanumeric: " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  // Why: covers airport-code separators and the route arrow. Useful
  // for displays like "BUR → SJC" or "FL 123" where the symbol slots
  // need their own character.
  alphanumericExtra: " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ→.,:-/".split("")
} as const;

export type SplitFlapCharSet = keyof typeof CHAR_SETS | string[];

function resolveCharSet(charset: SplitFlapCharSet): string[] {
  return Array.isArray(charset) ? charset : CHAR_SETS[charset];
}

// ─────────────────────────────────────────────────────────────────────
// Flap — single half-clipped layer

type FlapProps = {
  half: "top" | "bottom";
  animated?: boolean;
  children: React.ReactNode;
};

function Flap({ half, animated, children }: FlapProps) {
  // Why: each half-flap is positioned absolute, fills its parent cell,
  // and is clipped to its half via clip-path. backface-hidden cleans
  // up the rotateX flip so the back side of the panel doesn't bleed.
  // animated half plays the flip keyframe; static halves don't.
  return (
    <div
      className={cn(
        "absolute inset-0 box-border bg-inherit text-inherit [backface-visibility:hidden]",
        half === "top"
          ? "split-flap-clip-top origin-bottom"
          : "split-flap-clip-bottom origin-top",
        animated &&
          (half === "top" ? "split-flap-anim-top z-20" : "split-flap-anim-bottom z-20"),
        !animated && "z-10"
      )}
    >
      <span className="absolute inset-0 flex items-center justify-center">
        {children}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// FlapDigit — one character cell, 4 layers stacked

type FlapDigitProps = {
  value: string;
  prevValue: string;
  final: boolean;
  showHinge?: boolean | undefined;
};

function FlapDigit({ value, prevValue, final, showHinge = false }: FlapDigitProps) {
  // Why: the 4-layer composition.
  //   - static top:    new value's top half (always visible behind the
  //                    falling animated top)
  //   - static bottom: previous value's bottom half (visible until the
  //                    animated bottom drops in)
  //   - animated top:  previous value's top half — flips down 0→90deg
  //                    (key changes when prevValue changes, forcing
  //                    React to remount and replay the animation)
  //   - animated bottom (only on final): new value's bottom half —
  //                    drops in 90→0deg, settles. Only renders on the
  //                    final tick of a cycle so mid-cycle frames don't
  //                    over-animate.
  //
  // The hinge is a 1px line across the seam — purely decorative,
  // optional via showHinge.
  return (
    <div
      data-split-flap-digit
      className="relative inline-block h-[1em] w-[1ch] overflow-hidden bg-inherit text-inherit"
    >
      <Flap half="top">{value}</Flap>
      <Flap half="bottom">{prevValue}</Flap>
      <Flap key={`top-${prevValue}`} half="top" animated>
        {prevValue}
      </Flap>
      {final && (
        <Flap key={`bottom-${value}`} half="bottom" animated>
          {value}
        </Flap>
      )}
      {showHinge && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-0 z-30 h-px w-full -translate-y-1/2 bg-black/30"
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// FlapStack — cycles one cell from current → target through the charset

type FlapStackProps = {
  charSet: string[];
  value: string;
  cycleMs: number;
  showHinge?: boolean | undefined;
};

function FlapStack({ charSet, value, cycleMs, showHinge = false }: FlapStackProps) {
  // Why: cursor state is the source of truth for the rendered chars.
  // current = the index currently displayed in the top static layer.
  // previous = the index displayed in the bottom static layer (and
  //            in the animated falling top — which is the OLD top).
  // target = where we're cycling to.
  //
  // Cycle: each tick advances current by 1 modulo charset length;
  // when current === target, the interval clears. The "final" prop
  // on FlapDigit triggers the bottom layer's settle keyframe.
  const [cursor, setCursor] = useState({
    current: -1,
    previous: -1,
    target: 0
  });

  // Reset cursor when charSet changes (e.g., switching modes mid-flight).
  useEffect(() => {
    setCursor({ current: -1, previous: -1, target: 0 });
  }, [charSet]);

  useEffect(() => {
    let { current, previous } = cursor;
    const targetChar = (value || "").toUpperCase();
    const target = Math.max(charSet.indexOf(targetChar), 0);

    const tick = () => {
      previous = current;
      if (current >= charSet.length - 1 || current < 0) {
        current = 0;
      } else {
        current = current + 1;
      }
      setCursor({ current, previous, target });
    };

    // First tick fires synchronously so the cell shows _something_
    // immediately rather than waiting for the first interval.
    tick();

    const timer = setInterval(() => {
      if (current === target) {
        clearInterval(timer);
      } else {
        tick();
      }
    }, cycleMs);

    return () => clearInterval(timer);
    // Why: cursor intentionally NOT in deps. The effect captures it
    // at run-time and mutates local copies; including cursor would
    // re-trigger the effect on every tick and create runaway timers.
    // Re-running only when value, charSet, or cycleMs change is the
    // correct behavior for "start a new cycle when the target moves."
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charSet, value, cycleMs]);

  return (
    <FlapDigit
      value={charSet[cursor.current] ?? " "}
      prevValue={charSet[cursor.previous] ?? " "}
      final={cursor.current === cursor.target}
      showHinge={showHinge}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// SplitFlapDisplay — public API

type SplitFlapDisplayProps = {
  /** Value to display. Coerced to upper-case. */
  value: string;
  /** Character set to cycle through. Defaults to alphanumeric. */
  charSet?: SplitFlapCharSet;
  /** Pad to this length with spaces. If null/undefined, displays exact
   * length of value. */
  length?: number;
  /** Pad position when value is shorter than length. */
  padDirection?: "start" | "end";
  /** Per-step cycle time in ms (10-50 reads best). Lower = faster
   * machine-gun rattle. Default 45ms. */
  cycleMs?: number;
  /** Final settle animation duration in ms. Default 300ms. Set on
   * the wrapping container as a CSS variable so it cascades. */
  flipMs?: number;
  /** Show a horizontal hinge line across the middle of each cell. */
  showHinge?: boolean;
  /** Class name applied to the outer wrapper. Use this to control
   * font size, family, color, panel background, etc. — the cells
   * inherit color/bg via CSS inheritance. */
  className?: string;
};

export function SplitFlapDisplay({
  value,
  charSet = "alphanumeric",
  length,
  padDirection = "end",
  cycleMs = 45,
  flipMs = 300,
  showHinge = false,
  className
}: SplitFlapDisplayProps) {
  const resolvedCharSet = useMemo(() => resolveCharSet(charSet), [charSet]);

  const padded = useMemo(() => {
    const upper = String(value || "").toUpperCase();
    if (length == null) return upper.split("");
    if (upper.length >= length) return upper.slice(0, length).split("");
    const padCount = length - upper.length;
    const padding = " ".repeat(padCount);
    return padDirection === "start"
      ? (padding + upper).split("")
      : (upper + padding).split("");
  }, [value, length, padDirection]);

  // Why: stable keys so React can preserve FlapStack state across
  // value changes. Index keys would be fine for simple pads, but if
  // the value length grows, the new cells would inherit the cursor
  // state of the old cell at that index — which actually IS what we
  // want here (each position is "the Nth cell" semantically).
  const stableKeys = useStableKeys(padded.length);

  // CSS variable cascades into the .split-flap-anim-* rules so all
  // cells share the same flip duration without each one setting it.
  const styleVars = useMemo<React.CSSProperties>(
    () => ({ "--split-flap-flip-ms": `${flipMs}ms` } as React.CSSProperties),
    [flipMs]
  );

  return (
    <div
      role="text"
      aria-label={value}
      className={cn(
        "inline-flex select-none items-baseline gap-[0.1ch] tabular-nums",
        className
      )}
      style={styleVars}
    >
      {padded.map((char, i) => (
        <FlapStack
          key={stableKeys[i]}
          charSet={resolvedCharSet}
          value={char}
          cycleMs={cycleMs}
          showHinge={showHinge}
        />
      ))}
    </div>
  );
}

// Why: simple key generator that stays stable across renders for the
// same length. We deliberately don't key by character (would cause
// React to unmount and remount cells when characters change, killing
// the flip animation). Index-based keys with stable refs work because
// each position is conceptually "the Nth cell."
function useStableKeys(length: number): number[] {
  const ref = useRef<number[]>([]);
  if (ref.current.length !== length) {
    ref.current = Array.from({ length }, (_, i) => i);
  }
  return ref.current;
}
