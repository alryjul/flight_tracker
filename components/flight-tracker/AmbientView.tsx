"use client";

// Why: ambient widget styled as an airport split-flap display board.
// Three hero rows of equal panel size — FLIGHT, FROM, TO — each
// rendered as a labeled split-flap panel. Supporting flight info
// (operator, registration, distance, altitude, airspeed) sits below
// in muted text.
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

import { useMemo } from "react";
import { Helicopter, Plane } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SplitFlapDisplay } from "@/components/ui/split-flap";
import {
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
  getStripRouteLabel,
  normalizeRegisteredOwnerLabel
} from "@/lib/flights/display";
import {
  formatDistanceMiles,
  getDistanceFromHomeBaseMiles
} from "@/lib/map/geo-helpers";
import type { Flight } from "@/lib/flights/types";
import type { HomeBaseCenter } from "@/lib/types/flight-map";
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

// Why: bearing from home base to the flight, mapped to a 16-point compass.
function getCompassBearingLabel(
  flight: Flight,
  home: HomeBaseCenter
): string | null {
  const φ1 = (home.latitude * Math.PI) / 180;
  const φ2 = (flight.latitude * Math.PI) / 180;
  const Δλ = ((flight.longitude - home.longitude) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  const degrees = ((θ * 180) / Math.PI + 360) % 360;
  const points = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW"
  ];
  const idx = Math.round(degrees / 22.5) % 16;
  return points[idx] ?? "N";
}

type AmbientViewProps = {
  flight: Flight | null;
  isSelected: boolean;
  homeBase: HomeBaseCenter;
};

export function AmbientView({ flight, isSelected, homeBase }: AmbientViewProps) {
  const distanceMiles = flight
    ? getDistanceFromHomeBaseMiles(flight, homeBase)
    : null;
  const bearing = useMemo(
    () => (flight ? getCompassBearingLabel(flight, homeBase) : null),
    [flight, homeBase]
  );

  return (
    <AmbientShell>
      {/* Header — Nearest/Selected + bearing/distance */}
      <div className="flex items-baseline justify-between gap-3">
        <p className={LABEL_CLASS}>{isSelected ? "Selected" : "Nearest"}</p>
        {flight && bearing && distanceMiles != null ? (
          <p className="text-[10px] tabular-nums uppercase tracking-wider text-muted-foreground">
            {formatDistanceMiles(distanceMiles)} · {bearing}
          </p>
        ) : null}
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
          <RouteGrid flight={flight} />

          <Separator className="bg-border/60" />

          {/* Aircraft type badge inline with the supporting info dl.
              The badge alone shows the short name (737-800); full
              manufacturer name lives in the badge's title attribute
              on hover. SelectedFlightCard uses the same pattern —
              one badge, tooltip-for-detail, no repetition in the
              body. */}
          <div className="flex items-start gap-3">
            <AmbientAircraftTypeBadge aircraftType={flight.aircraftType} />
            <div className="min-w-0 flex-1">
              <InfoStack flight={flight} />
            </div>
          </div>

          <Separator className="bg-border/60" />

          {/* Stats row — Distance / Altitude / Airspeed */}
          <dl className="grid grid-cols-3 gap-3 text-xs">
            <Stat label="Distance">
              {distanceMiles != null ? formatDistanceMiles(distanceMiles) : "—"}
            </Stat>
            <Stat label="Altitude">{formatAltitude(flight.altitudeFeet)}</Stat>
            <Stat label="Airspeed">{formatAirspeed(flight.groundspeedKnots)}</Stat>
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
  return (
    <div className="dark pointer-events-none fixed top-4 left-1/2 z-30 -translate-x-1/2">
      <div className="pointer-events-auto flex w-[28rem] flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4 text-card-foreground shadow-2xl">
        {children}
      </div>
    </div>
  );
}

// Why: adaptive grid for the FLIGHT panel + route panels. Same logic
// as SelectedFlightCard's FlightRouteRow — which panels render
// depends on what data is available. FLIGHT is always present;
// FROM/TO/ROUTE adapt based on origin/destination availability.
function RouteGrid({ flight }: { flight: Flight }) {
  const origin = flight.origin;
  const destination = flight.destination;
  const flightValue = getPrimaryIdentifier(flight).toUpperCase();

  // Both endpoints — three panels.
  if (origin && destination) {
    return (
      <div className="grid grid-cols-3 gap-2">
        <HeroPanel
          label="Flight"
          value={flightValue}
          cells={FLIGHT_CELL_LENGTH}
          charSet="alphanumeric"
        />
        <HeroPanel
          label="From"
          value={isShortAirportCode(origin) ? origin : ""}
          cells={AIRPORT_CELL_LENGTH}
          fallback={!isShortAirportCode(origin) ? origin : null}
          charSet="alphanumericExtra"
        />
        <HeroPanel
          label="To"
          value={isShortAirportCode(destination) ? destination : ""}
          cells={AIRPORT_CELL_LENGTH}
          fallback={!isShortAirportCode(destination) ? destination : null}
          charSet="alphanumericExtra"
        />
      </div>
    );
  }

  // Origin only — two panels (FLIGHT / FROM).
  if (origin) {
    return (
      <div className="grid grid-cols-2 gap-2">
        <HeroPanel
          label="Flight"
          value={flightValue}
          cells={FLIGHT_CELL_LENGTH}
          charSet="alphanumeric"
        />
        <HeroPanel
          label="From"
          value={isShortAirportCode(origin) ? origin : ""}
          cells={AIRPORT_CELL_LENGTH}
          fallback={!isShortAirportCode(origin) ? origin : null}
          charSet="alphanumericExtra"
        />
      </div>
    );
  }

  // Destination only — two panels (FLIGHT / TO).
  if (destination) {
    return (
      <div className="grid grid-cols-2 gap-2">
        <HeroPanel
          label="Flight"
          value={flightValue}
          cells={FLIGHT_CELL_LENGTH}
          charSet="alphanumeric"
        />
        <HeroPanel
          label="To"
          value={isShortAirportCode(destination) ? destination : ""}
          cells={AIRPORT_CELL_LENGTH}
          fallback={!isShortAirportCode(destination) ? destination : null}
          charSet="alphanumericExtra"
        />
      </div>
    );
  }

  // Neither endpoint — show FLIGHT plus a fallback ROUTE panel
  // (VFR for VFR-squawking flights, Route pending otherwise).
  // Mirrors FlightRouteRow's no-route fallback.
  const fallbackText = getStripRouteLabel(flight);
  const fallbackFitsSplitFlap = fallbackText.length <= AIRPORT_CELL_LENGTH;
  return (
    <div className="grid grid-cols-2 gap-2">
      <HeroPanel
        label="Flight"
        value={flightValue}
        cells={FLIGHT_CELL_LENGTH}
        charSet="alphanumeric"
      />
      <HeroPanel
        label="Route"
        value={fallbackFitsSplitFlap ? fallbackText : ""}
        cells={AIRPORT_CELL_LENGTH}
        fallback={fallbackFitsSplitFlap ? null : fallbackText}
        charSet="alphanumericExtra"
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
  fallback
}: {
  label: string;
  value: string;
  cells: number;
  charSet: "alphanumeric" | "alphanumericExtra" | "alpha" | "numeric";
  fallback?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className={LABEL_CLASS}>{label}</p>
      <div className="flex h-12 items-center justify-center overflow-hidden rounded-md bg-background px-2 text-foreground shadow-inner ring-1 ring-border/30">
        {fallback ? (
          // Why: long readable names (LAPD Hooper Heliport, Cedars-
          // Sinai Medical Center) don't fit in a 4-cell split-flap —
          // fall back to plain text in the same panel slot. The
          // fixed h-12 keeps panel heights aligned across the row.
          <p className="truncate text-sm font-semibold leading-tight tracking-wider">
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
            className="text-xl font-semibold tracking-wider"
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

// Why: ambient-sized aircraft type badge — strips the Tooltip wrapper
// from SelectedFlightCard's version (overkill for an at-a-glance
// surface) but keeps the manufacturer-prefixed full name available
// via a native title attribute. So the badge shows "737-800" and
// hovering reveals "Boeing 737-800" — same info access, less DOM.
function AmbientAircraftTypeBadge({
  aircraftType
}: {
  aircraftType: string | null;
}) {
  const resolved = resolveAircraftType(aircraftType);
  const label = getAircraftTypeBadgeLabel(aircraftType);
  const Icon = isHelicopterType(aircraftType) ? Helicopter : Plane;
  return (
    <Badge
      variant="secondary"
      className="text-xs"
      title={resolved?.full ?? label}
    >
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}

// Why: operator + registration + owner block. Same dl shape as
// SelectedFlightCard but smaller and muted (text-xs labels, text-xs
// values) — the hero rows above are the focus, this is just
// supporting detail.
function InfoStack({ flight }: { flight: Flight }) {
  const operatorLabel = getOperatorLabel(flight);
  const operatorTitle = getOperatorLabelTitle(flight);
  const showRegistration =
    flight.registration != null &&
    getPrimaryIdentifier(flight) !== flight.registration;
  const ownerLabel = normalizeRegisteredOwnerLabel(flight.registeredOwner);
  const showOwner = ownerLabel != null && ownerLabel !== operatorLabel;

  if (!operatorLabel && !showRegistration && !showOwner) return null;

  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
      {operatorLabel ? (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1",
            !showRegistration && "col-span-2"
          )}
        >
          <dt className={LABEL_CLASS}>{operatorTitle}</dt>
          <dd className={cn("truncate font-medium", VALUE_LEADING)}>
            {operatorLabel}
          </dd>
        </div>
      ) : null}
      {showRegistration ? (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1",
            !operatorLabel && "col-span-2"
          )}
        >
          <dt className={LABEL_CLASS}>Registration</dt>
          <dd className={cn("truncate font-medium tabular-nums", VALUE_LEADING)}>
            {flight.registration}
          </dd>
        </div>
      ) : null}
      {showOwner ? (
        <div className="col-span-2 flex min-w-0 flex-col gap-1">
          <dt className={LABEL_CLASS}>Owner</dt>
          <dd className={cn("truncate font-medium", VALUE_LEADING)}>
            {ownerLabel}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

// Why: stat cell — label + value column, used in the bottom 3-col
// metrics row.
function Stat({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className={LABEL_CLASS}>{label}</dt>
      <dd className={cn("font-medium tabular-nums", VALUE_LEADING)}>{children}</dd>
    </div>
  );
}
