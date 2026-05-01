"use client";

import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { getAircraftTypeBadgeLabel } from "@/lib/flights/aircraftTypes";
import {
  getOperatorLabel,
  getPrimaryIdentifier,
  getStripRouteLabel
} from "@/lib/flights/display";
import {
  formatDistanceMiles,
  getDistanceFromHomeBaseMiles
} from "@/lib/map/geo-helpers";
import type { Flight } from "@/lib/flights/types";
import type {
  HomeBaseCenter,
  HoveredFlightState
} from "@/lib/types/flight-map";

type MapHoverCardProps = {
  hoveredFlight: HoveredFlightState | null;
  hoveredFlightDisplay: Flight | null;
  homeBase: HomeBaseCenter;
};

// Why: hover popover surfaces a structured 4-line readout for an
// active dot — enough to triage "is this the flight I want?" without
// clicking. Layout uses shadcn theme tokens (border-border,
// bg-popover, text-popover-foreground, text-muted-foreground) so it
// inherits the active theme.
//
// Lines (top → bottom):
//   1. Identifier (large, tabular-nums) ←→ aircraft-type badge (right)
//   2. Route — adaptive layout based on what's known:
//        • Both origin AND destination → 2-column grid: FROM | TO
//        • Origin only                  → single full-width FROM tile
//        • Destination only             → single full-width TO tile
//        • Neither                      → single full-width ROUTE
//          tile with the strip-style fallback ("VFR" / "Route pending")
//      Each tile has a tiny "FROM" / "TO" / "ROUTE" label above the
//      code (or fallback string).
//   3. Operator / airline (single line, muted)
//   4. 3-column metric tiles (Dist / Alt / Speed) — each tile has a
//      tiny dimmer uppercase label and a tabular-nums value, "—" for
//      missing data so the visual structure stays stable
function MapHoverCardImpl({
  hoveredFlight,
  hoveredFlightDisplay,
  homeBase
}: MapHoverCardProps) {
  if (!hoveredFlight || !hoveredFlightDisplay) return null;

  const operator = getOperatorLabel(hoveredFlightDisplay);
  const origin = hoveredFlightDisplay.origin;
  const destination = hoveredFlightDisplay.destination;
  // Why: when neither end is known, fall back to the strip-style
  // catch-all label ("VFR" / "Route pending") in a single ROUTE
  // tile. When at least one end is known, render From / To tile(s)
  // directly from the codes — getStripRouteLabel isn't used in that
  // case.
  const fallbackRouteLabel = getStripRouteLabel(hoveredFlightDisplay);
  // Why: prefer the normalized short name from the curated table
  // ("737-800", "AS350") over the raw ICAO designator ("B738",
  // "AS50"). Falls back to the raw ICAO uppercased when unmapped, or
  // null when the flight has no aircraftType field at all (we hide
  // the badge entirely in that case rather than render
  // "Unknown type").
  const typeLabel = hoveredFlightDisplay.aircraftType
    ? getAircraftTypeBadgeLabel(hoveredFlightDisplay.aircraftType)
    : null;

  const distance = formatDistanceMiles(
    getDistanceFromHomeBaseMiles(hoveredFlightDisplay, homeBase)
  );
  // Why: inline short fallbacks ("—") instead of using formatAltitude /
  // formatAirspeed directly — those return "Altitude unknown" /
  // "Speed unknown" which are too verbose for a one-line stat row.
  // The hero card still uses the verbose forms; hover stays compact.
  const altitudeRaw = hoveredFlightDisplay.altitudeFeet;
  const altitude =
    altitudeRaw != null ? `${altitudeRaw.toLocaleString()} ft` : "—";
  const airspeedRaw = hoveredFlightDisplay.groundspeedKnots;
  const airspeed =
    airspeedRaw != null ? `${airspeedRaw.toLocaleString()} kt` : "—";

  return (
    <div
      // Why: min-w sized so the card doesn't feel jittery as the
      // user hovers different flights with varying identifier /
      // operator lengths. 200 px keeps a stable footprint while
      // staying compact. max-w keeps a long operator name (e.g.,
      // "LAPD City Hall East Heliport") from dragging the card wide —
      // `truncate` on the operator line picks up the overflow and
      // adds an ellipsis instead.
      className="pointer-events-none fixed z-20 grid min-w-[200px] max-w-[18rem] gap-1 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
      style={{
        left: hoveredFlight.left,
        top: hoveredFlight.top,
        transform: "translate(8px, 8px)"
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <strong className="leading-tight tabular-nums">
          {getPrimaryIdentifier(hoveredFlightDisplay)}
        </strong>
        {typeLabel ? (
          <Badge variant="outline" className="px-1 py-0 text-[9px] font-normal">
            {typeLabel}
          </Badge>
        ) : null}
      </div>
      {origin && destination ? (
        <div className="grid grid-cols-2 gap-2 leading-tight">
          <div className="flex min-w-0 flex-col gap-px">
            <span className="text-[8px] uppercase tracking-wider text-muted-foreground/70">
              From
            </span>
            <span className="truncate">{origin}</span>
          </div>
          <div className="flex min-w-0 flex-col gap-px">
            <span className="text-[8px] uppercase tracking-wider text-muted-foreground/70">
              To
            </span>
            <span className="truncate">{destination}</span>
          </div>
        </div>
      ) : origin ? (
        <div className="flex min-w-0 flex-col gap-px leading-tight">
          <span className="text-[8px] uppercase tracking-wider text-muted-foreground/70">
            From
          </span>
          <span className="truncate">{origin}</span>
        </div>
      ) : destination ? (
        <div className="flex min-w-0 flex-col gap-px leading-tight">
          <span className="text-[8px] uppercase tracking-wider text-muted-foreground/70">
            To
          </span>
          <span className="truncate">{destination}</span>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-px leading-tight">
          <span className="text-[8px] uppercase tracking-wider text-muted-foreground/70">
            Route
          </span>
          <span className="truncate text-muted-foreground">
            {fallbackRouteLabel}
          </span>
        </div>
      )}
      {operator ? (
        <div className="truncate leading-tight text-muted-foreground">
          {operator}
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-2 leading-tight">
        <div className="flex flex-col gap-px">
          <span className="text-[8px] uppercase tracking-wider text-muted-foreground/70">
            Dist
          </span>
          <span className="tabular-nums text-muted-foreground">{distance}</span>
        </div>
        <div className="flex flex-col gap-px">
          <span className="text-[8px] uppercase tracking-wider text-muted-foreground/70">
            Alt
          </span>
          <span className="tabular-nums text-muted-foreground">{altitude}</span>
        </div>
        <div className="flex flex-col gap-px">
          <span className="text-[8px] uppercase tracking-wider text-muted-foreground/70">
            Speed
          </span>
          <span className="tabular-nums text-muted-foreground">{airspeed}</span>
        </div>
      </div>
    </div>
  );
}

// Why: hoveredFlight changes only on map mouse moves (rare); the orchestrator
// re-renders on every poll. Default shallow compare skips the render when
// neither hoveredFlight nor hoveredFlightDisplay (nor homeBase) changed
// identity.
export const MapHoverCard = memo(MapHoverCardImpl);
