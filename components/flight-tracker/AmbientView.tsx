"use client";

// Why: ambient widget styled as an airport split-flap display board.
// Three hero rows of equal panel size — FLIGHT, FROM, TO — each
// rendered as a labeled split-flap panel. Supporting flight info
// (operator, type, distance, altitude, airspeed) sits below in
// muted text.
//
// Theming: wrapped in a forced `dark` className subtree so the whole
// widget renders against shadcn's dark theme tokens regardless of
// the user's app theme. Inside, semantic tokens (bg-card, bg-
// background, text-foreground, text-muted-foreground, border-border)
// resolve to their dark-theme values, giving us the "airport board"
// aesthetic with theme-token consistency.
//
// Fixed width: prevents thrash when values change length (a 4-char
// flight number turning into 7 chars would otherwise reflow the whole
// card). Panels are full container width; split-flap content centers
// within them, so a 3-cell airport code in the same panel as a 7-cell
// flight number both look "in their slot" rather than left-aligned.

import { Helicopter, Plane, Tv } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SplitFlapDisplay } from "@/components/ui/split-flap";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import {
  getAircraftManufacturer,
  getAircraftTypeBadgeLabel,
  isHelicopterType,
  resolveAircraftType
} from "@/lib/flights/aircraftTypes";
import {
  formatAirspeed,
  formatAltitude,
  getOperatorLabel,
  getOperatorLabelTitle,
  getPrimaryIdentifier,
  getStripRouteLabel
} from "@/lib/flights/display";
import {
  formatDistanceMiles,
  getDistanceFromHomeBaseMiles
} from "@/lib/map/geo-helpers";
import type { Flight } from "@/lib/flights/types";
import type { HomeBaseCenter, TrendDirection } from "@/lib/types/flight-map";
import { cn } from "@/lib/utils";

// Why: dt label styling — uppercase + tracking-wider, muted color via
// theme token (renders against the dark surface as a subtle gray).
const LABEL_CLASS =
  "text-[10px] leading-tight uppercase tracking-wider text-muted-foreground";

const VALUE_LEADING = "leading-tight";

// Why: cell counts per hero row. Flight numbers can run up to 7 chars
// (PGR1390); airport codes are 3 chars (IATA) or 4 (FAA LIDs like
// 1CA9). With the three rows arranged in a horizontal grid where each
// column has equal width, the cell counts vary per panel but content
// centers inside its column — so airports look "tighter" than the
// flight panel, with the surrounding panel aligned to the same outer
// dimensions.
const FLIGHT_CELL_LENGTH = 7;
const AIRPORT_CELL_LENGTH = 4;

// Why: panel font size depends on layout context. When all three
// panels render (FLIGHT/FROM/TO), short airport codes never fall
// back to text — they always render as split-flap, so we can use
// the bigger "lg" size for visual presence. When only one route
// panel renders (origin-only / destination-only / fallback), it
// might contain a long readable name (LAPD Hooper Heliport,
// Cedars-Sinai Medical Center) that falls back to truncated text;
// "base" leaves more characters visible before truncation.
// Why: panel height stays constant across both sizes — variants
// changing height made the rows feel like they were "growing" with
// the font. h-9 (36px) is tight to text-xl's 20px font + small
// padding; text-base (16px) fits comfortably in the same height
// with extra slack.
type HeroPanelSize = "lg" | "base";
const HERO_PANEL_HEIGHT = "h-9";
const SIZE_CLASSES: Record<
  HeroPanelSize,
  { display: string; fallback: string }
> = {
  lg: { display: "text-xl", fallback: "text-base" },
  base: { display: "text-base", fallback: "text-xs" }
};

type AmbientViewProps = {
  flight: Flight | null;
  isSelected: boolean;
  flightsInViewCount: number;
  homeBase: HomeBaseCenter;
  altitudeTrend: TrendDirection;
  airspeedTrend: TrendDirection;
  onExitAmbient: () => void;
};

export function AmbientView({
  flight,
  isSelected,
  flightsInViewCount,
  homeBase,
  altitudeTrend,
  airspeedTrend,
  onExitAmbient
}: AmbientViewProps) {
  const distanceMiles = flight
    ? getDistanceFromHomeBaseMiles(flight, homeBase)
    : null;

  return (
    <AmbientShell>
      {/* Header — same shape as SidebarHeader's top row: "{count}
          flights in view" h2 on the left, button stack (ambient
          exit toggle + theme toggle) pinned right. Aircraft type
          lives in the InfoStack as a labeled "Type" field instead
          of a badge here. Context ("Nearest" vs. "Selected") lives
          on the FLIGHT panel's label below. */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 flex-1 text-base leading-tight">
          <span className="font-semibold tabular-nums">
            {flightsInViewCount} flights
          </span>
          <span className="ml-1 font-normal text-sidebar-foreground/60">
            in view
          </span>
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Exit ambient view"
            aria-pressed={true}
            onClick={onExitAmbient}
          >
            <Tv aria-hidden="true" />
          </Button>
          <ThemeToggle />
        </div>
      </div>

      {flight ? (
        <>
          {/* Hero rows — adaptive grid mirroring SelectedFlightCard's
              FlightRouteRow logic:
                - origin AND destination → 3 panels (FLIGHT/FROM/TO)
                - origin only            → 2 panels (FLIGHT/FROM)
                - destination only       → 2 panels (FLIGHT/TO)
                - neither                → 2 panels (FLIGHT/ROUTE)
                                           where ROUTE is the fallback
                                           string (VFR / Route pending)
              Equal column widths via the grid; content inside each
              panel centers. Hiding panels we don't have data for
              keeps the board honest — empty TO slots would invite
              "what's the destination" ambiguity. */}
          <RouteGrid flight={flight} isSelected={isSelected} />

          <Separator className="bg-border/60" />

          {/* Operator / Type — same dl shape as SelectedFlightCard's
              CardContent block, but with Type swapped in for
              Registration and Owner dropped. Equipment reads better
              at-a-glance than tail number in ambient mode; operator
              already conveys "who's flying it." */}
          <InfoStack flight={flight} />

          <Separator className="bg-border/60" />

          {/* Stats row — Distance / Altitude / Airspeed.
              Altitude + airspeed include trend arrows when the
              snapshot history shows movement past the metric
              thresholds. Same pattern (and same green/amber colors)
              as SelectedFlightCard's metrics row. */}
          <dl className="grid grid-cols-3 gap-3 text-xs">
            <Stat label="Distance">
              {distanceMiles != null ? formatDistanceMiles(distanceMiles) : "—"}
            </Stat>
            <Stat label="Altitude" trend={altitudeTrend}>
              {formatAltitude(flight.altitudeFeet)}
            </Stat>
            <Stat label="Airspeed" trend={airspeedTrend}>
              {formatAirspeed(flight.groundspeedKnots)}
            </Stat>
          </dl>
        </>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Waiting for an aircraft in range…
        </p>
      )}
    </AmbientShell>
  );
}

// Why: outer shell — fixed width, top-center positioning, the always-
// dark wrapping. The `dark` className forces shadcn's dark-theme
// tokens for the entire subtree regardless of user theme, so we still
// reference theme-aware semantic tokens (bg-card, bg-background,
// text-foreground, etc.) and they resolve to airport-board colors.
function AmbientShell({ children }: { children: React.ReactNode }) {
  // Why: structurally identical to the floating sidebar — outer
  // container is `fixed inset-y-0 left-0` at `w-(--sidebar-width)`
  // with `p-2` (8px) padding around the inner panel, exactly mirroring
  // shadcn's <Sidebar variant="floating">. By replicating the
  // two-layer structure we get the inner-panel dimensions for free
  // (the p-2 produces the 8px inset on every side) — no calc()
  // formula needed.
  //
  // Outer is `pointer-events-none` so clicks below the (auto-height)
  // inner panel pass through to the map; only the inner panel
  // captures clicks. Forced-dark via `dark` so theme tokens resolve
  // to the airport-board palette regardless of user theme.
  return (
    <div className="dark pointer-events-none fixed inset-y-0 left-0 z-30 w-[var(--sidebar-width,20rem)] max-w-[100vw] p-2">
      <div className="pointer-events-auto flex flex-col gap-3 rounded-lg bg-sidebar px-3 pt-3 pb-3 text-sidebar-foreground shadow-sm ring-1 ring-sidebar-border">
        {children}
      </div>
    </div>
  );
}

// Why: adaptive grid for the FLIGHT panel + route panels. Same logic
// as SelectedFlightCard's FlightRouteRow — which panels render
// depends on what data is available. FLIGHT is always present;
// FROM/TO/ROUTE adapt based on origin/destination availability.
//
// FLIGHT panel is always pinned to 1/2 of the card width — flight
// numbers can run 4-7 chars (WN1184, PGR1390), and the panel needs
// width to display them legibly. The remaining 1/2 either splits
// (FROM+TO at 1/4 each) or carries a single panel at full 1/2
// (FROM-only / TO-only / ROUTE fallback) depending on what data
// we have.
function RouteGrid({
  flight,
  isSelected
}: {
  flight: Flight;
  isSelected: boolean;
}) {
  const origin = flight.origin;
  const destination = flight.destination;
  const flightValue = getPrimaryIdentifier(flight).toUpperCase();
  // Why: the FLIGHT panel's label carries the context — "SELECTED
  // FLIGHT" when the user has clicked an aircraft, "NEAREST FLIGHT"
  // when ambient is auto-tracking the closest one. Replaces the
  // separate "Selected"/"Nearest" header dt that used to sit above
  // the panels (redundant once the panel is the focal point).
  const flightLabel = isSelected ? "Selected Flight" : "Nearest Flight";

  // Both endpoints — FLIGHT (1/2) + FROM (1/4) + TO (1/4), all "lg"
  // since short airport codes always render as split-flap and the
  // flight panel still has room.
  if (origin && destination) {
    return (
      <div className="grid grid-cols-[2fr_1fr_1fr] gap-2">
        <HeroPanel
          label={flightLabel}
          value={flightValue}
          cells={FLIGHT_CELL_LENGTH}
          charSet="alphanumeric"
          size="lg"
        />
        <HeroPanel
          label="From"
          value={isShortAirportCode(origin) ? origin : ""}
          cells={AIRPORT_CELL_LENGTH}
          fallback={!isShortAirportCode(origin) ? origin : null}
          charSet="alphanumericExtra"
          size="lg"
        />
        <HeroPanel
          label="To"
          value={isShortAirportCode(destination) ? destination : ""}
          cells={AIRPORT_CELL_LENGTH}
          fallback={!isShortAirportCode(destination) ? destination : null}
          charSet="alphanumericExtra"
          size="lg"
        />
      </div>
    );
  }

  // Two-panel layouts (origin-only / destination-only / fallback).
  // FLIGHT stays at "lg" — it always renders as a split-flap with
  // bounded cell count, never falls back to long text. The route
  // side picks its size dynamically per-render: short codes (≤4
  // chars: airport IATA, FAA LIDs, "VFR" fallback) get "lg" so they
  // match the flight number's visual weight; long readable names
  // (LAPD Hooper Heliport, Cedars-Sinai Medical Center) drop to
  // "base" so more characters fit before truncation.
  const flightPanelLg = (
    <HeroPanel
      label={flightLabel}
      value={flightValue}
      cells={FLIGHT_CELL_LENGTH}
      charSet="alphanumeric"
      size="lg"
    />
  );

  // Origin only — FLIGHT (1/2) + FROM (1/2).
  if (origin) {
    const originIsCode = isShortAirportCode(origin);
    return (
      <div className="grid grid-cols-2 gap-2">
        {flightPanelLg}
        <HeroPanel
          label="From"
          value={originIsCode ? origin : ""}
          cells={AIRPORT_CELL_LENGTH}
          fallback={!originIsCode ? origin : null}
          charSet="alphanumericExtra"
          size={originIsCode ? "lg" : "base"}
        />
      </div>
    );
  }

  // Destination only — FLIGHT (1/2) + TO (1/2).
  if (destination) {
    const destinationIsCode = isShortAirportCode(destination);
    return (
      <div className="grid grid-cols-2 gap-2">
        {flightPanelLg}
        <HeroPanel
          label="To"
          value={destinationIsCode ? destination : ""}
          cells={AIRPORT_CELL_LENGTH}
          fallback={!destinationIsCode ? destination : null}
          charSet="alphanumericExtra"
          size={destinationIsCode ? "lg" : "base"}
        />
      </div>
    );
  }

  // Neither endpoint — FLIGHT (1/2) + ROUTE fallback (1/2).
  // Mirrors FlightRouteRow's no-route fallback (VFR / Route pending).
  const fallbackText = getStripRouteLabel(flight);
  const fallbackFitsSplitFlap = fallbackText.length <= AIRPORT_CELL_LENGTH;
  return (
    <div className="grid grid-cols-2 gap-2">
      {flightPanelLg}
      <HeroPanel
        label="Route"
        value={fallbackFitsSplitFlap ? fallbackText : ""}
        cells={AIRPORT_CELL_LENGTH}
        fallback={fallbackFitsSplitFlap ? null : fallbackText}
        charSet="alphanumericExtra"
        size={fallbackFitsSplitFlap ? "lg" : "base"}
      />
    </div>
  );
}

// Why: one of the hero panels (FLIGHT / FROM / TO / ROUTE). Renders a
// label above a split-flap panel. Inside a grid parent, panel
// widths are equal; content centers within. Cell counts vary per
// column (7 for flight, 4 for airports) since airport codes are
// inherently shorter; the surrounding panel sizes stay aligned
// because the grid forces equal column widths.
function HeroPanel({
  label,
  value,
  cells,
  charSet,
  fallback,
  size
}: {
  label: string;
  value: string;
  cells: number;
  charSet: "alphanumeric" | "alphanumericExtra" | "alpha" | "numeric";
  fallback?: string | null;
  size: HeroPanelSize;
}) {
  const sizeClasses = SIZE_CLASSES[size];
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className={LABEL_CLASS}>{label}</p>
      <div
        className={cn(
          "flex items-center justify-start overflow-hidden rounded-md bg-background px-1.5 text-foreground shadow-inner ring-1 ring-border/30",
          HERO_PANEL_HEIGHT
        )}
      >
        {fallback ? (
          // Why: long readable names (LAPD Hooper Heliport, Cedars-
          // Sinai Medical Center) don't fit in a 4-cell split-flap —
          // fall back to plain text in the same panel slot. Fallback
          // size is one tier smaller than the split-flap so more
          // characters fit before truncation.
          <p
            className={cn(
              "truncate font-semibold leading-tight tracking-wider",
              sizeClasses.fallback
            )}
          >
            {fallback}
          </p>
        ) : (
          <SplitFlapDisplay
            value={value}
            charSet={charSet}
            length={cells}
            padDirection="end"
            cycleMs={45}
            flipMs={300}
            className={cn("font-semibold tracking-wider", sizeClasses.display)}
          />
        )}
      </div>
    </div>
  );
}

// Why: helper to test if an airport "code" is short enough to render
// as a split-flap (≤4 chars; covers IATA + most FAA LIDs). Long
// readable names (LAPD Hooper Heliport, Cedars-Sinai Medical Center)
// fall through to text fallback.
function isShortAirportCode(value: string | null): value is string {
  return value != null && value.length > 0 && value.length <= 4;
}

// Why: operator + type block. Same dl shape as SelectedFlightCard's
// CardContent block but with Type swapped in for Registration —
// equipment is more useful at-a-glance in ambient mode than tail
// number, and the tail number remains visible in the FLIGHT panel
// for GA / private flights via getPrimaryIdentifier. Owner is
// intentionally omitted: the operator label already covers "who's
// flying it" for our purposes here.
function InfoStack({ flight }: { flight: Flight }) {
  const operatorLabel = getOperatorLabel(flight);
  const operatorTitle = getOperatorLabelTitle(flight);

  // Why: show "manufacturer + sanitized short label" inline ("Boeing
  // 737-800", "Airbus AS350") alongside a Plane / Helicopter icon,
  // and surface the full curated name + raw ICAO designator in a
  // tooltip. Manufacturer comes from `getAircraftManufacturer` —
  // it strips the parenthetical noise that lives on `full`
  // ("(Eurocopter AS350)") and handles known multi-word brands.
  // We dedupe when the short label already starts with the
  // manufacturer ("Bell 206" / "MD 520N") so we don't double-print
  // the brand. Mirrors the AircraftTypeBadge pattern in
  // SelectedFlightCard so the affordance is consistent across
  // surfaces. Hide the field entirely when the type is genuinely
  // unknown — "Unknown type" reads as missing data, not informative.
  const typeResolved = resolveAircraftType(flight.aircraftType);
  const typeShortLabel = getAircraftTypeBadgeLabel(flight.aircraftType);
  const typeManufacturer = getAircraftManufacturer(flight.aircraftType);
  const typeShortStartsWithManufacturer =
    typeManufacturer != null &&
    typeShortLabel
      .toLowerCase()
      .startsWith(`${typeManufacturer.toLowerCase()} `);
  const typeDisplayLabel =
    typeManufacturer && !typeShortStartsWithManufacturer
      ? `${typeManufacturer} ${typeShortLabel}`
      : typeShortLabel;
  const showType = typeShortLabel !== "Unknown type";
  const TypeIcon = isHelicopterType(flight.aircraftType) ? Helicopter : Plane;

  if (!operatorLabel && !showType) return null;

  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
      {operatorLabel ? (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1",
            !showType && "col-span-2"
          )}
        >
          <dt className={LABEL_CLASS}>{operatorTitle}</dt>
          <dd className={cn("truncate font-medium", VALUE_LEADING)}>
            {operatorLabel}
          </dd>
        </div>
      ) : null}
      {showType ? (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1",
            !operatorLabel && "col-span-2"
          )}
        >
          <dt className={LABEL_CLASS}>Type</dt>
          <dd
            className={cn(
              "flex items-center gap-1.5 truncate font-medium",
              VALUE_LEADING
            )}
          >
            <TypeIcon
              aria-hidden="true"
              className="size-3 shrink-0 text-muted-foreground"
            />
            {typeResolved ? (
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help truncate" tabIndex={0}>
                      {typeDisplayLabel}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    align="start"
                    className="flex flex-col gap-0.5"
                  >
                    {flight.aircraftType ? (
                      <span className="tabular-nums">
                        <span className="text-background/70">ICAO </span>
                        {flight.aircraftType.trim().toUpperCase()}
                      </span>
                    ) : null}
                    <span>{typeResolved.full}</span>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <span className="truncate">{typeDisplayLabel}</span>
            )}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

// Why: stat cell — label + value column, used in the bottom 3-col
// metrics row. Optional trend prop renders an up/down arrow next to
// the value (green for up, amber for down) — same pattern and colors
// as SelectedFlightCard's altitude/airspeed cells.
function Stat({
  label,
  children,
  trend
}: {
  label: string;
  children: React.ReactNode;
  trend?: TrendDirection;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className={LABEL_CLASS}>{label}</dt>
      <dd
        className={cn(
          "flex items-baseline gap-1 font-medium tabular-nums",
          VALUE_LEADING
        )}
      >
        {children}
        {trend ? (
          <span
            aria-hidden="true"
            className={cn(
              "text-[10px]",
              trend === "up" ? "text-emerald-500" : "text-amber-500"
            )}
          >
            {trend === "up" ? "↑" : "↓"}
          </span>
        ) : null}
      </dd>
    </div>
  );
}
